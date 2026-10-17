#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { classify, recordBuild } from '@rnship/ota';
import { compilePolicy, loadBasePolicy, loadPolicy, loadRouting, mergePolicy, seatbeltProfile, TIERS, type Policy, type Tier } from '@rnship/policy';
import {
  ApprovalError,
  baselineDigest,
  loadBaseline,
  mergeApprove,
  releaseApproveBuild,
  releaseApproveRollback,
  releaseApproveRollout,
  releaseApproveSubmit,
  releaseApproveUpdate,
  stateDir,
  writeApproval,
  type ApproveResult,
} from '@rnship/release';
import { changeDigest, changePreparer, changeStatus, importTasks, loadRequest, loadTasks, openDb, pollSentry, SentryClient, tick } from '@rnship/orchestrator';
import { changeApprove, changeIntake, changeTasks, sandboxInstall } from './change.ts';
import { policyCheck } from './check.ts';
import { dbPath, desktopNotify, ledgerRows, makeExecutor, orchestratorHome, policyDiffCheck, sandboxValidate, taskApprove } from './orchestrate.ts';
import { sandboxRun } from './sandbox.ts';

const USAGE = `usage:
  rnship policy merge <project-policy.yaml> [--base <base.yaml>]
  rnship policy compile <project-policy.yaml> --out <dir> [--base <base.yaml>] [--codeowner <@handle>]
      writes settings.json, hook-rules.json, executor-settings.json (pass to every executor run as
      --settings <file> --setting-sources user), and CODEOWNERS when --codeowner is given
  rnship policy check <project-root> --base-ref <sha> [--policy <project-policy.yaml>] [--baseline <approved-baseline.yaml>]
      exit 1 when any gate fires; deps/config rules compare against the approved baseline
  rnship baseline approve <approved-baseline.yaml> [--project <root>]
  rnship merge approve <sha> --pr <number> [--repo <owner/name>] [--accept-main <sha>]
      refuses if the PR's base moved since the last merge approve; after inspecting, vouch for the
      current base head with --accept-main (also needed on the first merge in a repo)
  rnship release approve build <sha> --platform <ios|android|all> [--profile production]
  rnship release approve submit <build-id> [--profile production]
  rnship release approve update <group-id> [--rollout 10] [--from-branch staging] [--channel production]
  rnship release approve rollout <group-id> --percent <n>
      moves a production rollout to the next step; judge the current step's health window first
  rnship release approve rollback <group-id> [--to-embedded [--channel production]]
      reverts the group's rollout, or with --to-embedded points the channel's clients on that
      runtime back at the update embedded in their build (the rollback drill uses --channel staging)
      approvals run as your user (never rnship-agent) and refuse a digest that doesn't match the artifact
  rnship sandbox profile [--home <dir>]
  rnship sandbox run [--home <dir>] [--timeout <sec>] -- <command...>
      runs a validation command under sandbox-exec: no secrets, no persistence writes, network only via
      an allowlisting localhost proxy; --timeout stops it and exits 124
  rnship ota record <project-root> --out <dir> --build-id <id>
  rnship ota classify --base <project-root> --artifacts <dir> --candidate <project-root> [--policy <project-policy.yaml>]
  rnship signals poll --app <name> --repo <app-repo> --sentry-org <slug> --sentry-project <slug>
                      --validation <cmd>... [--at <ref>] [--tier T1] [--min-events 1] [--min-users 1]
                      [--rolling-out <update-id>]... [--db <path>]
      B1–B3: triage unresolved Sentry issues into Flow B tasks. Reads SENTRY_AUTH_TOKEN from env; run
      it as its own job, never inside tick (executors inherit the tick's env). Suspect files must
      exist at --at (default HEAD of the app repo)
  rnship change intake <change-dir> --repo <app-repo> --settings <executor-settings.json> [--tier T1] [--db <path>]
      A1–A4 for .rnship/changes/<id>/change-request.yaml: checks the request, asks Claude what it needs,
      decides go / go-dev-build / stop against the approved baseline, and designs the screens
  rnship change status <change-dir> --repo <app-repo>
      the verdict, rule hits, baseline delta and packages to install, the digest, and whether it's approved
  rnship change approve <change-dir> <digest> [--baseline <approved-baseline.yaml>] [--project <root>]
      run as you: approves the change folder at exactly that digest (any later edit voids it). With a
      baseline delta, also merges it into --baseline (default <project>/.rnship/approved-baseline.yaml)
      and approves that baseline; the agent's repo needs that file before tick leases any task
  rnship change tasks <change-dir> --app <name> --repo <app-repo> --settings <executor-settings.json>
                      --validation <cmd>... --app-id <bundle-id> [--tier T1] [--db <path>]
      A5 for an approved change: tasks.yaml and Maestro flows under <change-dir>/tasks/, imported into
      a Flow A run bound to the change; tick holds the run whenever the change's gate fails
  rnship tasks import <tasks.yaml> --app <name> --flow <A|B> --repo <app-repo> [--change <change-dir> | --unscoped] [--db <path>]
      a Flow A file names its change: pass --change, which must still have the file's digest.
      --unscoped imports Flow A tasks with no change (fixture plans only, as in the M3 acceptance)
  rnship tasks list [--db <path>]
  rnship ledger [--db <path>]
      every executor call: task, model that ran, tokens (input + output)
  rnship tick [--db <path>] [--home <dir>] [--batch <n>] --executor fake --fake-script <json>
  rnship tick [--db <path>] [--home <dir>] [--batch <n>] --executor claude-p --settings <executor-settings.json>
              [--plugin-dir <knowledge-plugin>]... [--review]
  rnship tick [--db <path>] [--home <dir>] [--batch <n>] --executor ralphex --settings <executor-settings.json>
              [--ralphex <bin>] [--plugin-dir <knowledge-plugin>]... [--review]
      one idempotent orchestrator pass (run by the LaunchAgent); the DB defaults to $RNSHIP_DB
      or ~/.rnship/orchestrator.db, and worktrees and bundles go next to it. The guard plugin is
      always loaded; --plugin-dir adds knowledge plugins such as plugins/rn-game
  rnship task approve <task-id> <head-sha> [--db <path>]
      run as you: approves the task's gated changes at exactly that commit`;

class UsageError extends Error {}

function merged(projectPath: string, basePath?: string): Policy {
  const result = mergePolicy(basePath ? loadPolicy(basePath) : loadBasePolicy(), loadPolicy(projectPath));
  if (!result.ok) {
    for (const error of result.errors) console.error(`rnship: ${error.code}: ${error.message}`);
    process.exit(1);
  }
  return result.policy;
}

function approveContext() {
  return { cwd: process.cwd(), state: stateDir(process.cwd()) };
}

function approved(result: ApproveResult): void {
  console.log(`approved ${result.kind} ${result.digest}: ${result.subject}\n${result.record}`);
  for (const note of result.notes ?? []) console.error(`rnship: warning: ${note}`);
}

function required(values: Record<string, unknown>, ...names: string[]): void {
  for (const name of names) if (typeof values[name] !== 'string') throw new UsageError(`missing --${name}`);
}

async function main(argv: string[]): Promise<void> {
  const [group, command, ...rest] = argv[0] === 'tick' || argv[0] === 'ledger' ? [argv[0], '', ...argv.slice(1)] : argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      base: { type: 'string' },
      out: { type: 'string' },
      codeowner: { type: 'string' },
      'build-id': { type: 'string' },
      artifacts: { type: 'string' },
      candidate: { type: 'string' },
      policy: { type: 'string' },
      'base-ref': { type: 'string' },
      baseline: { type: 'string' },
      project: { type: 'string' },
      pr: { type: 'string' },
      repo: { type: 'string' },
      'accept-main': { type: 'string' },
      platform: { type: 'string' },
      profile: { type: 'string' },
      rollout: { type: 'string' },
      percent: { type: 'string' },
      'to-embedded': { type: 'boolean' },
      'sentry-org': { type: 'string' },
      'sentry-project': { type: 'string' },
      validation: { type: 'string', multiple: true },
      at: { type: 'string' },
      tier: { type: 'string' },
      'min-events': { type: 'string' },
      'min-users': { type: 'string' },
      'rolling-out': { type: 'string', multiple: true },
      'from-branch': { type: 'string' },
      channel: { type: 'string' },
      home: { type: 'string' },
      timeout: { type: 'string' },
      app: { type: 'string' },
      flow: { type: 'string' },
      db: { type: 'string' },
      executor: { type: 'string' },
      'fake-script': { type: 'string' },
      batch: { type: 'string' },
      ralphex: { type: 'string' },
      settings: { type: 'string' },
      review: { type: 'boolean' },
      'plugin-dir': { type: 'string', multiple: true },
      change: { type: 'string' },
      unscoped: { type: 'boolean' },
      'app-id': { type: 'string' },
    },
  });

  switch (command ? `${group} ${command}` : group) {
    case 'policy merge': {
      if (!positionals[0]) throw new UsageError('missing <project-policy.yaml>');
      console.log(JSON.stringify(merged(positionals[0], values.base), null, 2));
      return;
    }
    case 'policy compile': {
      if (!positionals[0]) throw new UsageError('missing <project-policy.yaml>');
      required(values, 'out');
      const hookRulesPath = resolve(values.out!, 'hook-rules.json');
      const compiled = compilePolicy(merged(positionals[0], values.base), { codeowner: values.codeowner, hookRulesPath });
      mkdirSync(values.out!, { recursive: true });
      writeFileSync(join(values.out!, 'settings.json'), JSON.stringify(compiled.settings, null, 2) + '\n');
      writeFileSync(hookRulesPath, JSON.stringify(compiled.hookRules, null, 2) + '\n');
      writeFileSync(join(values.out!, 'executor-settings.json'), JSON.stringify(compiled.executorSettings, null, 2) + '\n');
      if (compiled.codeowners) writeFileSync(join(values.out!, 'CODEOWNERS'), compiled.codeowners);
      return;
    }
    case 'policy check': {
      const root = positionals[0];
      if (!root) throw new UsageError('missing <project-root>');
      required(values, 'base-ref');
      const projectPolicy = values.policy ?? join(root, '.rnship', 'policy.yaml');
      const policy = values.policy || existsSync(projectPolicy) ? merged(projectPolicy, values.base) : loadBasePolicy();
      const result = policyCheck({ root, baseRef: values['base-ref']!, policy, baselinePath: values.baseline });
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exit(1);
      return;
    }
    case 'baseline approve': {
      const path = positionals[0];
      if (!path) throw new UsageError('missing <approved-baseline.yaml>');
      const digest = baselineDigest(loadBaseline(path));
      const record = writeApproval(stateDir(values.project ?? process.cwd()), { kind: 'baseline', digest, subject: path });
      console.log(`approved baseline ${digest}\n${record}`);
      return;
    }
    case 'merge approve': {
      if (!positionals[0]) throw new UsageError('missing <sha>');
      required(values, 'pr');
      approved(mergeApprove(approveContext(), { sha: positionals[0], pr: values.pr!, repo: values.repo, acceptMain: values['accept-main'] }));
      return;
    }
    case 'release approve': {
      const [action, digest] = positionals;
      if (!digest) throw new UsageError('missing <digest>');
      const ctx = approveContext();
      if (action === 'build') {
        required(values, 'platform');
        approved(releaseApproveBuild(ctx, { sha: digest, platform: values.platform!, profile: values.profile }));
      } else if (action === 'submit') {
        approved(releaseApproveSubmit(ctx, { buildId: digest, profile: values.profile }));
      } else if (action === 'update') {
        const rollout = values.rollout === undefined ? undefined : Number(values.rollout);
        approved(releaseApproveUpdate(ctx, { group: digest, rollout, fromBranch: values['from-branch'], channel: values.channel }));
      } else if (action === 'rollout') {
        required(values, 'percent');
        approved(releaseApproveRollout(ctx, { group: digest, percent: Number(values.percent) }));
      } else if (action === 'rollback') {
        approved(releaseApproveRollback(ctx, { group: digest, toEmbedded: values['to-embedded'], channel: values.channel }));
      } else {
        throw new UsageError(`unknown release action: ${action ?? '(none)'}`);
      }
      return;
    }
    case 'sandbox profile': {
      process.stdout.write(seatbeltProfile({ home: values.home ?? homedir() }));
      return;
    }
    case 'sandbox run': {
      const timeoutSec = values.timeout === undefined ? undefined : Number(values.timeout);
      if (timeoutSec !== undefined && !(timeoutSec > 0)) throw new UsageError('--timeout must be a positive number of seconds');
      process.exitCode = await sandboxRun(positionals, { home: values.home ?? homedir(), timeoutSec });
      return;
    }
    case 'ota record': {
      if (!positionals[0]) throw new UsageError('missing <project-root>');
      required(values, 'out', 'build-id');
      await recordBuild(positionals[0], values.out!, { buildId: values['build-id']! });
      return;
    }
    case 'ota classify': {
      required(values, 'base', 'artifacts', 'candidate');
      const result = await classify({
        base: values.base!,
        artifacts: values.artifacts!,
        candidate: values.candidate!,
        policy: values.policy ? merged(values.policy) : undefined,
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case 'signals poll': {
      required(values, 'app', 'repo', 'sentry-org', 'sentry-project');
      if (!values.validation?.length) throw new UsageError('missing --validation: Flow B tasks need validation commands');
      const tier = values.tier ?? 'T1';
      if (!(TIERS as readonly string[]).includes(tier)) throw new UsageError(`--tier must be one of ${TIERS.join(', ')}`);
      const repo = resolve(values.repo!);
      const client = new SentryClient({ org: values['sentry-org']!, project: values['sentry-project']!, token: process.env.SENTRY_AUTH_TOKEN ?? '' });
      const report = await pollSentry(
        openDb(dbPath(values.db)),
        client,
        {
          app: values.app!,
          repo,
          at: values.at ?? 'HEAD',
          task: { tier: tier as Tier, validation: values.validation },
          minEvents: values['min-events'] === undefined ? undefined : Number(values['min-events']),
          minUsers: values['min-users'] === undefined ? undefined : Number(values['min-users']),
          rollingOut: values['rolling-out'],
          notify: desktopNotify,
        },
        new Date(),
      );
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    case 'tasks import': {
      if (!positionals[0]) throw new UsageError('missing <tasks.yaml>');
      required(values, 'app', 'flow', 'repo');
      if (values.flow !== 'A' && values.flow !== 'B') throw new UsageError('--flow must be A or B');
      const file = loadTasks(positionals[0]);
      let change: { dir: string; digest: string } | undefined;
      if (file.change) {
        if (!values.change) throw new UsageError(`${positionals[0]} implements change ${file.change.id}: pass --change <change-dir>`);
        const dir = resolve(values.change);
        const digest = changeDigest(dir);
        if (loadRequest(dir).id !== file.change.id || digest !== file.change.digest) {
          throw new Error(`${dir} is change ${loadRequest(dir).id} at ${digest}, not ${file.change.id} at ${file.change.digest}`);
        }
        change = { dir, digest };
      } else if (values.flow === 'A' && !values.unscoped) {
        throw new UsageError('Flow A tasks come from rnship change tasks; pass --unscoped only for a fixture plan');
      }
      const db = openDb(dbPath(values.db));
      console.log(JSON.stringify(importTasks(db, { app: values.app!, flow: values.flow, repo: resolve(values.repo!), file, change }, new Date()), null, 2));
      return;
    }
    case 'change intake': {
      if (!positionals[0]) throw new UsageError('missing <change-dir>');
      required(values, 'repo');
      const report = await changeIntake(resolve(positionals[0]), resolve(values.repo!), { db: dbPath(values.db), settings: values.settings, tier: values.tier, pluginDirs: values['plugin-dir'] });
      console.log(JSON.stringify(report, null, 2));
      if (report.verdict === 'stop') process.exitCode = 3;
      return;
    }
    case 'change status': {
      if (!positionals[0]) throw new UsageError('missing <change-dir>');
      required(values, 'repo');
      console.log(JSON.stringify(changeStatus(resolve(positionals[0]), resolve(values.repo!)), null, 2));
      return;
    }
    case 'change approve': {
      const [dir, digest] = positionals;
      if (!dir || !digest) throw new UsageError('missing <change-dir> <digest>');
      const records = changeApprove({ dir: resolve(dir), digest, baseline: values.baseline, project: values.project ?? process.cwd() });
      console.log(`approved change ${digest}\n${records.join('\n')}`);
      return;
    }
    case 'change tasks': {
      if (!positionals[0]) throw new UsageError('missing <change-dir>');
      required(values, 'app', 'repo', 'app-id');
      if (!values.validation?.length) throw new UsageError('missing --validation: every task needs validation commands');
      const report = await changeTasks(
        resolve(positionals[0]),
        { app: values.app!, repo: resolve(values.repo!), validation: values.validation, appId: values['app-id']! },
        { db: dbPath(values.db), settings: values.settings, tier: values.tier, pluginDirs: values['plugin-dir'] },
      );
      console.log(JSON.stringify({ change: report.change, digest: report.digest, tasks: report.tasksPath, flows: report.flows, run: report.runId, created: report.created }, null, 2));
      return;
    }
    case 'tasks list': {
      const db = openDb(dbPath(values.db));
      const rows = db.prepare('SELECT id, run_id, key, state, phase, tier, validation_failures, resume_at, head_sha, failure_class FROM tasks ORDER BY id').all();
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    case 'ledger': {
      console.log(JSON.stringify(ledgerRows(openDb(dbPath(values.db))), null, 2));
      return;
    }
    case 'tick': {
      const path = dbPath(values.db);
      const home = orchestratorHome(path, values.home);
      const report = await tick({
        db: openDb(path),
        executor: makeExecutor(values.executor, {
          fakeScript: values['fake-script'],
          ralphex: values.ralphex,
          settings: values.settings,
          pluginDirs: values['plugin-dir'],
          review: values.review,
          home,
        }),
        routing: loadRouting(),
        diffCheck: policyDiffCheck,
        validate: sandboxValidate,
        prepare: changePreparer(sandboxInstall),
        notify: desktopNotify,
        home,
        batchSize: values.batch === undefined ? undefined : Number(values.batch),
      });
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    case 'task approve': {
      const [taskId, sha] = positionals;
      if (!taskId || !sha) throw new UsageError('missing <task-id> <head-sha>');
      const record = taskApprove(dbPath(values.db), { taskId: Number(taskId), sha });
      console.log(`approved task ${taskId} at ${sha}\n${record}`);
      return;
    }
    default:
      throw new UsageError(`unknown command: ${[group, command].filter(Boolean).join(' ') || '(none)'}`);
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof ApprovalError) {
    console.error(`rnship: ${error.message}`);
    process.exit(1);
  }
  if (error instanceof UsageError) {
    console.error(`rnship: ${error.message}\n${USAGE}`);
    process.exit(2);
  }
  console.error(error);
  process.exit(1);
});
