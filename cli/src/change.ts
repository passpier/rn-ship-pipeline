import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  applyDelta,
  baselineCovers,
  BASELINE_FILE,
  changeDigest,
  claudeStageRunner,
  deltaIsEmpty,
  importTasks,
  loadDelta,
  loadImpact,
  loadRequest,
  openDb,
  planChange,
  runIntake,
  type Installer,
  type IntakeReport,
  type PlanReport,
  type StageRunner,
} from '@rnship/orchestrator';
import { loadBasePolicy, loadPolicy, loadRouting, loadSuitability, mergePolicy, type Policy, type Tier } from '@rnship/policy';
import { ApprovalError, assertHumanUser, baselineDigest, findApproval, loadBaseline, stateDir, stringifyBaseline, writeApproval } from '@rnship/release';
import { GUARD_PLUGIN_DIR, orchestratorHome } from './orchestrate.ts';
import { sandboxRun, TIMED_OUT } from './sandbox.ts';

// Wiring for `rnship change …` (Flow A, M5). intake and tasks run as rnship-agent (they
// call Claude); approve runs as you.

type Env = Record<string, string | undefined>;

export type StageFlags = { db: string; settings?: string; tier?: string; pluginDirs?: string[] };

function stageRunner(flags: StageFlags): StageRunner {
  // The settings file must be the compiled executor-settings.json (ADR 0002).
  if (!flags.settings) throw new Error('rnship change needs --settings <executor-settings.json>');
  const tier = (flags.tier ?? 'T1') as Tier;
  const model = loadRouting().tiers[tier];
  if (!model) throw new Error(`--tier must be one of T0, T1, T2`);
  return claudeStageRunner({
    db: openDb(flags.db),
    model,
    pluginDir: GUARD_PLUGIN_DIR,
    extraPluginDirs: flags.pluginDirs?.map((dir) => resolve(dir)),
    settingsFile: resolve(flags.settings),
    workDir: join(orchestratorHome(flags.db), 'intake'),
  });
}

function projectPolicy(repo: string): Policy {
  const path = join(repo, '.rnship', 'policy.yaml');
  if (!existsSync(path)) return loadBasePolicy();
  const merged = mergePolicy(loadBasePolicy(), loadPolicy(path));
  if (!merged.ok) throw new Error(`${path} doesn't merge: ${merged.errors.map((e) => e.message).join('; ')}`);
  return merged.policy;
}

function readJson(path: string): Record<string, unknown> | undefined {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>) : undefined;
}

/** `rnship change intake`: A1–A4 against the repo's approved baseline. */
export async function changeIntake(dir: string, repo: string, flags: StageFlags, env: Env = process.env): Promise<IntakeReport> {
  const baselinePath = join(repo, BASELINE_FILE);
  if (!existsSync(baselinePath)) throw new Error(`${baselinePath} doesn't exist: Stage 0's approved baseline comes first`);
  const baseline = loadBaseline(baselinePath);
  const approval = findApproval(stateDir(repo, env), 'baseline', baselineDigest(baseline), env);
  if (!approval.ok) throw new Error(`${baselinePath} isn't approved (${approval.reason}): the gate compares against an approved baseline only`);
  const pkg = readJson(join(repo, 'package.json')) ?? {};
  const packageDeps = { ...(pkg.dependencies as Record<string, string>), ...(pkg.devDependencies as Record<string, string>) };
  const bundled = readJson(join(repo, 'node_modules', 'expo', 'bundledNativeModules.json')) as Record<string, string> | undefined;
  return runIntake({ dir, repo, policy: projectPolicy(repo), suitability: loadSuitability(), baseline, packageDeps, bundled, run: stageRunner(flags) });
}

/**
 * `rnship change approve`: run as you, after reading `rnship change status`. Refuses a digest
 * that isn't the folder's current one, and a stopped change. With a baseline delta it also
 * merges the delta into your approved-baseline.yaml (`--baseline`) and approves that
 * baseline: the same gate as `rnship baseline approve`, in one act.
 */
export function changeApprove(input: { dir: string; digest: string; baseline?: string; project: string }, env: Env = process.env): string[] {
  assertHumanUser(env);
  const request = loadRequest(input.dir);
  const digest = changeDigest(input.dir);
  if (digest !== input.digest) throw new ApprovalError(`change ${request.id} is now ${digest}, not ${input.digest}; review it again and approve that digest`);
  const impact = loadImpact(input.dir);
  if (!impact) throw new ApprovalError(`change ${request.id} has no impact.json; run rnship change intake first`);
  if (impact.verdict === 'stop') {
    throw new ApprovalError(`change ${request.id} was stopped by ${impact.rule_hits.filter((h) => h.effect === 'stop').map((h) => h.ruleId).join(', ')}; overriding a stop needs an ADR first`);
  }
  const state = stateDir(input.project, env);
  const records: string[] = [];
  const delta = loadDelta(input.dir);
  if (delta && !deltaIsEmpty(delta)) {
    const path = input.baseline ?? join(input.project, BASELINE_FILE);
    if (!existsSync(path)) throw new ApprovalError(`change ${request.id} has a baseline delta, and ${path} doesn't exist; pass --baseline <approved-baseline.yaml>`);
    let baseline = loadBaseline(path);
    if (!findApproval(state, 'baseline', baselineDigest(baseline), env).ok) throw new ApprovalError(`${path} isn't approved itself; approve the baseline before adding a delta to it`);
    if (!baselineCovers(baseline, delta)) {
      baseline = applyDelta(baseline, delta);
      writeFileSync(path, stringifyBaseline(baseline));
    }
    const merged = baselineDigest(baseline);
    if (!findApproval(state, 'baseline', merged, env).ok) records.push(writeApproval(state, { kind: 'baseline', digest: merged, subject: `${path} + change ${request.id}` }, env));
  }
  records.push(writeApproval(state, { kind: 'change', digest, subject: request.id }, env));
  return records;
}

/** `rnship change tasks`: A5 for the approved change, then the import, bound to the change. */
export async function changeTasks(
  dir: string,
  input: { app: string; repo: string; validation: string[]; appId: string },
  flags: StageFlags,
  env: Env = process.env,
): Promise<PlanReport & { runId: number; created: string[] }> {
  const report = await planChange({ dir, repo: input.repo, run: stageRunner(flags), validation: input.validation, appId: input.appId, env });
  const db = openDb(flags.db);
  const result = importTasks(db, { app: input.app, flow: 'A', repo: input.repo, file: report.file, change: { dir: resolve(dir), digest: report.digest } }, new Date());
  return { ...report, runId: result.runId, created: result.created };
}

/** Installs a change's approved packages under the validation sandbox (A3b delta). */
export const sandboxInstall: Installer = async ({ cwd, packages }) => {
  const code = await sandboxRun(['npx', '--no-install', 'expo', 'install', ...packages], { home: homedir(), cwd, timeoutSec: 1800 });
  if (code === TIMED_OUT) return { ok: false, digest: 'expo install timed out after 1800s' };
  return code === 0 ? { ok: true } : { ok: false, digest: `expo install exited ${code}` };
};
