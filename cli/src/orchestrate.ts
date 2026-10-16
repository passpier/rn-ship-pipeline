import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { FakeExecutor, getRun, getTask, approvalSubject, desktopNotify, openDb, type DiffCheck, type Executor, type Validate } from '@rnship/orchestrator';
import { loadBasePolicy, loadPolicy, mergePolicy } from '@rnship/policy';
import { ApprovalError, stateDir, writeApproval } from '@rnship/release';
import { policyCheck } from './check.ts';
import { sandboxRun } from './sandbox.ts';

// Wiring for `rnship tick`, `rnship tasks …` and `rnship task approve`. The orchestrator
// package takes its diff check and validation runner as functions, so the CLI plugs in
// `rnship policy check` and the validation sandbox here.

type Env = Record<string, string | undefined>;

export function dbPath(flag: string | undefined, env: Env = process.env): string {
  return flag ?? env.RNSHIP_DB ?? join(homedir(), '.rnship', 'orchestrator.db');
}

export function orchestratorHome(db: string, flag?: string): string {
  return flag ?? dirname(db);
}

/** `rnship policy check` over the worktree, with approvals read from the app repo's state dir. */
export const policyDiffCheck: DiffCheck = ({ root, baseRef, repo }) => {
  const env = { ...process.env, RNSHIP_STATE_DIR: stateDir(repo) };
  const projectPolicy = join(root, '.rnship', 'policy.yaml');
  let policy = loadBasePolicy();
  if (existsSync(projectPolicy)) {
    const merged = mergePolicy(policy, loadPolicy(projectPolicy));
    // A project layer that fails to merge blocks everything (fail closed).
    if (!merged.ok) return { ok: false, gates: merged.errors.map((e) => ({ ruleId: `policy.${e.code}`, matches: [e.message] })) };
    policy = merged.policy;
  }
  const result = policyCheck({ root, baseRef, policy, env });
  return { ok: result.ok, gates: result.gates.map((g) => ({ ruleId: g.ruleId, matches: g.matches })) };
};

/** Each validation command under the validation sandbox, stopping at the first failure. */
export const sandboxValidate: Validate = async ({ cwd, commands }) => {
  for (const command of commands) {
    const code = await sandboxRun(['/bin/sh', '-c', command], { home: homedir(), cwd });
    if (code !== 0) return { ok: false, digest: `\`${command}\` exited ${code}` };
  }
  return { ok: true };
};

export function makeExecutor(kind: string | undefined, opts: { fakeScript?: string }): Executor {
  if (kind === 'fake') {
    if (!opts.fakeScript) throw new Error('--executor fake needs --fake-script <json>');
    return FakeExecutor.fromFile(opts.fakeScript);
  }
  throw new Error(`unknown executor: ${kind ?? '(none)'}; use --executor fake`);
}

export { desktopNotify };

/**
 * `rnship task approve`: run as you. Refuses a SHA that isn't the task's current head, so
 * you approve exactly the commit you reviewed. The approval covers every task of the run
 * waiting at that head.
 */
export function taskApprove(db: string, input: { taskId: number; sha: string }, env: Env = process.env): string {
  const conn = openDb(db);
  try {
    const task = getTask(conn, input.taskId);
    if (task.state !== 'awaiting_approval') throw new ApprovalError(`task ${task.id} is ${task.state}, not awaiting_approval`);
    if (task.head_sha !== input.sha) {
      throw new ApprovalError(`task ${task.id} head is ${task.head_sha}, not ${input.sha}; review the new commits and approve that SHA`);
    }
    const run = getRun(conn, task.run_id);
    return writeApproval(stateDir(run.repo, env), { kind: 'task', digest: input.sha, subject: approvalSubject(run.id) }, env);
  } finally {
    conn.close();
  }
}
