import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { ApprovalError, approvalPath, assertHumanUser, writeApproval, type ApprovalKind } from './approvals.ts';
import { readMainHead, writeMainHead } from './mainHead.ts';

// `rnship merge approve` and `rnship release approve`: you run these as your own user,
// with your own gh and eas credentials. Approving *is* executing the action (D1). Each
// command refuses to run as the agent user, checks that the digest you typed matches
// the artifact it is about to act on, and records a single-use approval afterwards.
//
// eas-cli flags and JSON fields were checked against eas-cli 24.13.0 (oclif manifest,
// BuildFragment, getUpdateJsonInfosForUpdates), so release approvals refuse another
// eas-cli minor before their first eas call.

/** The eas-cli line the flags were checked against; any patch release of it is accepted. */
export const EAS_CLI_VERSION = '24.13';

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

export type ApproveResult = { kind: ApprovalKind; digest: string; subject: string; record: string; notes?: string[] };

type PrView = { headRefOid: string; state: string; baseRefName: string; url: string };

export function mergeApprove(
  ctx: ApproveContext,
  input: { sha: string; pr: string; repo?: string; acceptMain?: string },
): ApproveResult {
  const { run, env } = prepare(ctx, 'merge', input.sha);
  const repoFlag = input.repo ? ['--repo', input.repo] : [];
  const pr = json<PrView>(run('gh', ['pr', 'view', input.pr, '--json', 'headRefOid,state,baseRefName,url', ...repoFlag], query(ctx)));
  if (pr.state !== 'OPEN') throw new ApprovalError(`PR ${input.pr} is ${pr.state}, not OPEN`);
  if (pr.headRefOid !== input.sha) {
    throw new ApprovalError(`PR ${input.pr} head is ${pr.headRefOid}, not ${input.sha}; review the new commits and approve that SHA`);
  }
  const repo = /^https:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/\d+$/.exec(pr.url)?.[1];
  if (!repo) throw new ApprovalError(`can't read the repo from PR URL ${pr.url}`);
  const base = pr.baseRefName;

  // The base must still be where the last merge approve left it (D1 backstop). Anything
  // else reached main without you: inspect it, then vouch for it with --accept-main.
  const current = sha(text(run('gh', ['api', `repos/${repo}/git/ref/heads/${base}`, '--jq', '.object.sha'], query(ctx))), `${base} head`);
  if (input.acceptMain !== undefined) {
    if (input.acceptMain !== current) throw new ApprovalError(`--accept-main ${input.acceptMain} isn't the current ${base} head ${current}`);
  } else {
    const known = readMainHead(ctx.state, repo, base, env);
    const vouch = `inspect it, then re-run with --accept-main ${current}`;
    if (!known.ok) throw new ApprovalError(`${known.reason}; ${base} is at ${current}: ${vouch}`);
    if (known.record.sha !== current) {
      throw new ApprovalError(
        `${base} moved from ${known.record.sha} to ${current} since the last rnship merge approve: ` +
          `https://github.com/${repo}/compare/${known.record.sha}...${current}; ${vouch}`,
      );
    }
  }

  // --match-head-commit makes GitHub refuse the merge if the head moved after our check.
  act(run('gh', ['pr', 'merge', input.pr, '--merge', '--match-head-commit', input.sha, ...repoFlag], live(ctx)), 'gh pr merge');
  const result = record(ctx, env, 'merge', input.sha, `PR ${input.pr}`);
  const note = recordMergeCommit(ctx, run, env, { pr: input.pr, repoFlag, repo, base, parent: current });
  return note ? { ...result, notes: [note] } : result;
}

/**
 * After the merge, records its merge commit as the new base head. It records nothing if
 * the merge commit's first parent isn't the head we checked (something landed on the base
 * in between), so the next merge approve refuses until you vouch.
 */
function recordMergeCommit(
  ctx: ApproveContext,
  run: Runner,
  env: Record<string, string | undefined>,
  m: { pr: string; repoFlag: string[]; repo: string; base: string; parent: string },
): string | undefined {
  const unrecorded = (why: string) =>
    `merged, but the ${m.base} head was not recorded (${why}); the next merge approve will ask you to inspect ${m.base} and pass --accept-main`;
  try {
    const merged = json<{ mergeCommit?: { oid?: string } | null }>(run('gh', ['pr', 'view', m.pr, '--json', 'mergeCommit', ...m.repoFlag], query(ctx)));
    const oid = sha(merged.mergeCommit?.oid ?? '', 'merge commit');
    const parent = sha(text(run('gh', ['api', `repos/${m.repo}/commits/${oid}`, '--jq', '.parents[0].sha'], query(ctx))), 'merge parent');
    if (parent !== m.parent) return unrecorded(`merge commit ${oid} has first parent ${parent}, not the checked head ${m.parent}`);
    writeMainHead(ctx.state, { repo: m.repo, base: m.base, sha: oid }, env);
    return undefined;
  } catch (error) {
    return unrecorded(error instanceof Error ? error.message : String(error));
  }
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

/** The update group's updates, checked to be that group and one runtime version. */
function viewGroup(ctx: ApproveContext, run: Runner, group: string): EasUpdate[] {
  const updates = json<EasUpdate[]>(run('eas', ['update:view', group, '--json'], query(ctx)));
  if (!Array.isArray(updates) || updates.length === 0) throw new ApprovalError(`update group ${group} has no updates`);
  for (const update of updates) if (update.group !== group) throw new ApprovalError(`eas returned group ${update.group}, not ${group}`);
  if (new Set(updates.map((u) => u.runtimeVersion)).size !== 1) throw new ApprovalError(`update group ${group} spans more than one runtime version`);
  return updates;
}

/**
 * Moves a production rollout to the next percentage (design §5). Check the health window
 * of the current step before you run it; an inconclusive window is yours to judge. Each
 * step is its own single-use approval, recorded as `<group>@<percent>`.
 */
export function releaseApproveRollout(ctx: ApproveContext, input: { group: string; percent: number }): ApproveResult {
  const { percent } = input;
  if (!Number.isInteger(percent) || percent < 1 || percent > 100) throw new ApprovalError(`--percent must be an integer from 1 to 100, got ${percent}`);
  const digest = `${input.group}@${percent}`;
  const { run, env } = prepare(ctx, 'release', digest);
  const [update] = viewGroup(ctx, run, input.group);
  act(run('eas', ['update:edit', input.group, '--rollout-percentage', String(percent), '--non-interactive'], live(ctx)), 'eas update:edit');
  return record(ctx, env, 'release', digest, `rollout of ${input.group} (branch ${update!.branch}) to ${percent}%`);
}

/**
 * Rolls back a bad update group (design §5, recovery). By default it reverts the group's
 * in-progress rollout; `toEmbedded` instead points the channel's clients on that runtime
 * back at the update embedded in their build. Recorded as `rollback-<group>`, so the
 * group's earlier release approval doesn't block it.
 */
export function releaseApproveRollback(ctx: ApproveContext, input: { group: string; toEmbedded?: boolean; channel?: string }): ApproveResult {
  const digest = `rollback-${input.group}`;
  const { run, env } = prepare(ctx, 'release', digest);
  const [update] = viewGroup(ctx, run, input.group);
  const message = `rnship release approve rollback ${input.group}`;
  if (input.toEmbedded) {
    const channel = input.channel ?? 'production';
    act(
      run(
        'eas',
        ['update:roll-back-to-embedded', '--channel', channel, '--runtime-version', update!.runtimeVersion, '--message', message, '--force-end-active-rollout', '--non-interactive'],
        live(ctx),
      ),
      'eas update:roll-back-to-embedded',
    );
    return record(ctx, env, 'release', digest, `roll back ${channel} runtime ${update!.runtimeVersion} to embedded (from ${input.group})`);
  }
  if (input.channel !== undefined) throw new ApprovalError('--channel applies only with --to-embedded; a rollout revert acts on the group itself');
  act(run('eas', ['update:revert-update-rollout', '--group', input.group, '--message', message, '--non-interactive'], live(ctx)), 'eas update:revert-update-rollout');
  return record(ctx, env, 'release', digest, `revert the rollout of ${input.group} (branch ${update!.branch})`);
}

function prepare(ctx: ApproveContext, kind: ApprovalKind, digest: string) {
  const env = ctx.env ?? process.env;
  assertHumanUser(env);
  if (!digest) throw new ApprovalError('missing digest');
  if (existsSync(approvalPath(ctx.state, kind, digest))) {
    throw new ApprovalError(`${kind} ${digest} was already approved; approvals are single-use`);
  }
  const run = ctx.run ?? spawnRunner;
  return { run: kind === 'release' ? pinnedEas(run) : run, env };
}

// Checks `eas --version` once, before the first other eas call goes through `run`.
function pinnedEas(run: Runner): Runner {
  let checked = false;
  return (command, args, opts) => {
    if (command === 'eas' && !checked) {
      const out = text(run('eas', ['--version'], { cwd: opts.cwd, capture: true }));
      const version = /eas-cli\/(\d+\.\d+\.\d+)/.exec(out)?.[1];
      if (!version?.startsWith(`${EAS_CLI_VERSION}.`)) {
        throw new ApprovalError(`eas-cli ${version ?? `(unrecognized: ${out})`} isn't ${EAS_CLI_VERSION}.x, whose flags rnship was checked against: npm i -g eas-cli@${EAS_CLI_VERSION}.0`);
      }
      checked = true;
    }
    return run(command, args, opts);
  };
}

const query = (ctx: ApproveContext) => ({ cwd: ctx.cwd, capture: true });
const live = (ctx: ApproveContext) => ({ cwd: ctx.cwd, capture: false });

function text(result: RunResult): string {
  if (result.code !== 0) throw new ApprovalError(result.stderr.trim() || `command failed with exit ${result.code}`);
  return result.stdout.trim();
}

function sha(value: string, what: string): string {
  if (!/^[0-9a-f]{40}$/.test(value)) throw new ApprovalError(`expected a commit SHA for the ${what}, got: ${value.slice(0, 80) || '(empty)'}`);
  return value;
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
