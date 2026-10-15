#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { classify, recordBuild } from '@rnship/ota';
import { compilePolicy, loadBasePolicy, loadPolicy, mergePolicy, seatbeltProfile, type Policy } from '@rnship/policy';
import {
  ApprovalError,
  baselineDigest,
  loadBaseline,
  mergeApprove,
  releaseApproveBuild,
  releaseApproveSubmit,
  releaseApproveUpdate,
  stateDir,
  writeApproval,
  type ApproveResult,
} from '@rnship/release';
import { policyCheck } from './check.ts';
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
      approvals run as your user (never rnship-agent) and refuse a digest that doesn't match the artifact
  rnship sandbox profile [--home <dir>]
  rnship sandbox run [--home <dir>] -- <command...>
      runs a validation command under sandbox-exec: no secrets, no persistence writes, network only via
      an allowlisting localhost proxy
  rnship ota record <project-root> --out <dir> --build-id <id>
  rnship ota classify --base <project-root> --artifacts <dir> --candidate <project-root> [--policy <project-policy.yaml>]`;

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
  const [group, command, ...rest] = argv;
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
      'from-branch': { type: 'string' },
      channel: { type: 'string' },
      home: { type: 'string' },
    },
  });

  switch (`${group} ${command}`) {
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
      process.exitCode = await sandboxRun(positionals, { home: values.home ?? homedir() });
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
