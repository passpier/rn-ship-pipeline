import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { ApprovalError, approvalPath, assertHumanUser, writeApproval, type ApprovalKind } from './approvals.ts';

// `rnship merge approve` and `rnship release approve`: you run these as your own user,
// with your own gh and eas credentials. Approving *is* executing the action (D1). Each
// command refuses to run as the agent user, checks that the digest you typed matches
// the artifact it is about to act on, and records a single-use approval afterwards.
//
// eas-cli flags and JSON fields were checked against eas-cli 24.13.0 (oclif manifest,
// BuildFragment, getUpdateJsonInfosForUpdates).

export type RunResult = { code: number; stdout: string; stderr: string };
/** Runs a command. `capture` returns its output; otherwise output goes to the terminal. */
export type Runner = (command: string, args: string[], opts: { cwd: string; capture: boolean }) => RunResult;

export type ApproveContext = {
  cwd: string;
  /** Approval state dir (see stateDir). */
  state: string;
  env?: Record<string, string | undefined>;
  run?: Runner;
};

export const spawnRunner: Runner = (command, args, opts) => {
  const result = spawnSync(command, args, {
    cwd: opts.cwd,
    encoding: 'utf8',
    stdio: opts.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.error) throw new ApprovalError(`can't run ${command}: ${result.error.message}`);
  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
};

export type ApproveResult = { kind: ApprovalKind; digest: string; subject: string; record: string };

export function mergeApprove(ctx: ApproveContext, input: { sha: string; pr: string; repo?: string }): ApproveResult {
  const { run, env } = prepare(ctx, 'merge', input.sha);
  const repo = input.repo ? ['--repo', input.repo] : [];
  const pr = json<{ headRefOid: string; state: string }>(run('gh', ['pr', 'view', input.pr, '--json', 'headRefOid,state', ...repo], query(ctx)));
  if (pr.state !== 'OPEN') throw new ApprovalError(`PR ${input.pr} is ${pr.state}, not OPEN`);
  if (pr.headRefOid !== input.sha) {
    throw new ApprovalError(`PR ${input.pr} head is ${pr.headRefOid}, not ${input.sha}; review the new commits and approve that SHA`);
  }
  // --match-head-commit makes GitHub refuse the merge if the head moved after our check.
  act(run('gh', ['pr', 'merge', input.pr, '--merge', '--match-head-commit', input.sha, ...repo], live(ctx)), 'gh pr merge');
  return record(ctx, env, 'merge', input.sha, `PR ${input.pr}`);
}

export function releaseApproveBuild(ctx: ApproveContext, input: { sha: string; platform: string; profile?: string }): ApproveResult {
  const { run, env } = prepare(ctx, 'release', input.sha);
  const head = text(run('git', ['rev-parse', 'HEAD'], query(ctx)));
  if (head !== input.sha) throw new ApprovalError(`HEAD is ${head}, not ${input.sha}; check out the approved commit first`);
  const dirty = text(run('git', ['status', '--porcelain'], query(ctx)));
  if (dirty) throw new ApprovalError('the checkout has uncommitted changes; a production build must come from a clean checkout of the approved SHA');
  const profile = input.profile ?? 'production';
  act(run('eas', ['build', '--profile', profile, '--platform', input.platform, '--non-interactive'], live(ctx)), 'eas build');
  return record(ctx, env, 'release', input.sha, `eas build --profile ${profile} --platform ${input.platform}`);
}

type EasBuild = { id: string; status: string; platform: string; buildProfile?: string; gitCommitHash?: string };

export function releaseApproveSubmit(ctx: ApproveContext, input: { buildId: string; profile?: string }): ApproveResult {
  const { run, env } = prepare(ctx, 'release', input.buildId);
  const build = json<EasBuild>(run('eas', ['build:view', input.buildId, '--json'], query(ctx)));
  const profile = input.profile ?? 'production';
  if (build.id !== input.buildId) throw new ApprovalError(`eas returned build ${build.id}, not ${input.buildId}`);
  if (build.status !== 'FINISHED') throw new ApprovalError(`build ${input.buildId} is ${build.status}, not FINISHED`);
  if (build.buildProfile !== profile) throw new ApprovalError(`build ${input.buildId} used profile ${build.buildProfile}, not ${profile}`);
  const platform = build.platform.toLowerCase();
  act(run('eas', ['submit', '--platform', platform, '--id', input.buildId, '--profile', profile, '--non-interactive'], live(ctx)), 'eas submit');
  return record(ctx, env, 'release', input.buildId, `eas submit ${platform} build ${input.buildId} (commit ${build.gitCommitHash ?? 'unknown'})`);
}

type EasUpdate = { group: string; branch: string; platform: string; gitCommitHash?: string | null; runtimeVersion: string };

export function releaseApproveUpdate(
  ctx: ApproveContext,
  input: { group: string; rollout?: number; fromBranch?: string; channel?: string },
): ApproveResult {
  const { run, env } = prepare(ctx, 'release', input.group);
  const rollout = input.rollout ?? 10;
  if (!Number.isInteger(rollout) || rollout < 1 || rollout > 100) throw new ApprovalError(`--rollout must be an integer from 1 to 100, got ${rollout}`);
  const fromBranch = input.fromBranch ?? 'staging';
  const channel = input.channel ?? 'production';
  const updates = json<EasUpdate[]>(run('eas', ['update:view', input.group, '--json'], query(ctx)));
  if (!Array.isArray(updates) || updates.length === 0) throw new ApprovalError(`update group ${input.group} has no updates`);
  const head = text(run('git', ['rev-parse', 'HEAD'], query(ctx)));
  for (const update of updates) {
    if (update.group !== input.group) throw new ApprovalError(`eas returned group ${update.group}, not ${input.group}`);
    if (update.branch !== fromBranch) throw new ApprovalError(`update group ${input.group} is on branch ${update.branch}, not ${fromBranch}`);
    if (update.gitCommitHash !== head) {
      throw new ApprovalError(`update group ${input.group} (${update.platform}) was built from ${update.gitCommitHash ?? 'an unknown commit'}, not HEAD ${head}`);
    }
  }
  act(
    run(
      'eas',
      ['update:republish', '--group', input.group, '--destination-channel', channel, '--rollout-percentage', String(rollout), '--message', `rnship release approve ${input.group}`, '--non-interactive'],
      live(ctx),
    ),
    'eas update:republish',
  );
  return record(ctx, env, 'release', input.group, `republish ${input.group} (commit ${head}) to ${channel} at ${rollout}%`);
}

function prepare(ctx: ApproveContext, kind: ApprovalKind, digest: string) {
  const env = ctx.env ?? process.env;
  assertHumanUser(env);
  if (!digest) throw new ApprovalError('missing digest');
  if (existsSync(approvalPath(ctx.state, kind, digest))) {
    throw new ApprovalError(`${kind} ${digest} was already approved; approvals are single-use`);
  }
  return { run: ctx.run ?? spawnRunner, env };
}

const query = (ctx: ApproveContext) => ({ cwd: ctx.cwd, capture: true });
const live = (ctx: ApproveContext) => ({ cwd: ctx.cwd, capture: false });

function text(result: RunResult): string {
  if (result.code !== 0) throw new ApprovalError(result.stderr.trim() || `command failed with exit ${result.code}`);
  return result.stdout.trim();
}

function json<T>(result: RunResult): T {
  const out = text(result);
  try {
    return JSON.parse(out) as T;
  } catch {
    throw new ApprovalError(`expected JSON, got: ${out.slice(0, 200)}`);
  }
}

function act(result: RunResult, what: string): void {
  if (result.code !== 0) throw new ApprovalError(`${what} failed with exit ${result.code}; nothing was recorded`);
}

function record(ctx: ApproveContext, env: Record<string, string | undefined>, kind: ApprovalKind, digest: string, subject: string): ApproveResult {
  return { kind, digest, subject, record: writeApproval(ctx.state, { kind, digest, subject }, env) };
}
