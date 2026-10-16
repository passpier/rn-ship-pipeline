import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Routing, Tier } from '@rnship/policy';
import { findApproval, stateDir } from '@rnship/release';
import { transaction, type Db } from './db.ts';
import { NO_USAGE, type ExecResult, type ExecStatus, type Executor } from './executor.ts';
import { park, quotaState, recordUsage, unpark } from './ledger.ts';
import type { Notify } from './notify.ts';
import { decide } from './retry.ts';
import { getRun } from './runs.ts';
import { ACTIVE_STATES, getTask, logEvent, patchTask, transition, type State, type TaskRow } from './states.ts';
import { diffSince, ensureWorktree, headSha, resetWorktree } from './worktree.ts';

// `rnship tick`: one idempotent pass, run by the LaunchAgent every 15 minutes (design §4).
// It holds a lock for the whole pass, so at most one tick works on the DB at a time, and
// every step can be repeated after a crash:
//   1. reclaim tasks whose lease owner died (kill -9), discarding their uncommitted work
//   2. reopen the Claude quota when it resets, probing only when the reset time is unknown
//   3. move due quota_parked / retry_wait tasks back to ready, and pending tasks whose deps are done
//   4. continue tasks whose approval matches their current head
//   5. lease a same-tier batch, run the executor, validate, diff-check, and repeat until idle

export type Gate = { ruleId: string; matches: string[] };
/** The authoritative diff check (`rnship policy check`) over `baseRef..HEAD` in the worktree. */
export type DiffCheck = (input: { root: string; baseRef: string; repo: string }) => { ok: boolean; gates: Gate[] };
/** Runs validation commands in the worktree (under the validation sandbox in production). */
export type Validate = (input: { cwd: string; commands: string[] }) => Promise<{ ok: boolean; digest?: string }>;
type Env = Record<string, string | undefined>;

export type TickOptions = {
  db: Db;
  executor: Executor;
  routing: Routing;
  diffCheck: DiffCheck;
  validate: Validate;
  notify: Notify;
  /** Orchestrator home: worktrees/ and bundles/ live here. */
  home: string;
  now?: () => Date;
  env?: Env;
  pid?: number;
  batchSize?: number;
  /** Stop after this many executor batches (default: until nothing is leasable). */
  maxBatches?: number;
  timeoutSec?: number;
  idleTimeoutSec?: number;
  probeIntervalMs?: number;
};

export type BatchReport = { runId: number; phase: 'tasks' | 'review'; tier: Tier; taskKeys: string[]; status: ExecStatus };
export type TickReport = { busy: boolean; reclaimed: string[]; batches: BatchReport[]; quota: 'open' | 'parked' };

const LOCK = 'tick';

export async function tick(opts: TickOptions): Promise<TickReport> {
  const ctx = context(opts);
  if (!acquireLock(ctx)) return { busy: true, reclaimed: [], batches: [], quota: quotaState(ctx.db).open ? 'open' : 'parked' };
  try {
    const reclaimed = reclaim(ctx);
    const batches: BatchReport[] = [];
    while (batches.length < (opts.maxBatches ?? Infinity)) {
      await reopenQuota(ctx);
      releaseDue(ctx);
      await continueApproved(ctx);
      const batch = leaseBatch(ctx);
      if (!batch) break;
      batches.push(await runBatch(ctx, batch));
    }
    return { busy: false, reclaimed, batches, quota: quotaState(ctx.db).open ? 'open' : 'parked' };
  } finally {
    ctx.db.prepare('DELETE FROM locks WHERE name = ? AND pid = ?').run(LOCK, ctx.pid);
  }
}

type Ctx = Required<Omit<TickOptions, 'maxBatches'>>;

function context(opts: TickOptions): Ctx {
  return {
    ...opts,
    now: opts.now ?? (() => new Date()),
    env: opts.env ?? process.env,
    pid: opts.pid ?? process.pid,
    batchSize: opts.batchSize ?? 3,
    timeoutSec: opts.timeoutSec ?? 3600,
    idleTimeoutSec: opts.idleTimeoutSec ?? 600,
    probeIntervalMs: opts.probeIntervalMs ?? 15 * 60_000,
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function acquireLock(ctx: Ctx): boolean {
  return transaction(ctx.db, () => {
    const row = ctx.db.prepare('SELECT pid FROM locks WHERE name = ?').get(LOCK) as { pid: number } | undefined;
    if (row && row.pid !== ctx.pid && alive(row.pid)) return false;
    ctx.db.prepare('INSERT OR REPLACE INTO locks (name, pid, at) VALUES (?, ?, ?)').run(LOCK, ctx.pid, ctx.now().toISOString());
    return true;
  });
}

const tasksIn = (ctx: Ctx, states: State[]) =>
  ctx.db.prepare(`SELECT * FROM tasks WHERE state IN (${states.map(() => '?').join(', ')}) ORDER BY id`).all(...states) as TaskRow[];

function bundleDir(ctx: Ctx, task: TaskRow): string {
  return join(ctx.home, 'bundles', `task-${task.id}`);
}

// 1. We hold the tick lock, so no live tick is working on any active task: they were all
// left behind by a tick that died. Their work was never validated, so the worktree goes
// back to where the batch started (saving a patch), and the task is ready again. A
// reclaim isn't an attempt.
function reclaim(ctx: Ctx): string[] {
  const reclaimed: string[] = [];
  for (const task of tasksIn(ctx, ACTIVE_STATES)) {
    if (task.lease_pid !== null && task.lease_pid !== ctx.pid && alive(task.lease_pid)) continue;
    const run = getRun(ctx.db, task.run_id);
    if (run.worktree) {
      resetWorktree(run.worktree, { sha: task.start_sha ?? undefined, patchPath: join(bundleDir(ctx, task), `reclaimed-${Date.now()}.patch`) });
    }
    const why = `reclaimed: lease owner ${task.lease_pid ?? '(none)'} is gone`;
    if (transition(ctx.db, task.id, task.state, 'ready', { patch: { lease_pid: null }, reason: why, now: ctx.now() })) reclaimed.push(task.key);
  }
  return reclaimed;
}

// 2. Quota: a known reset time reopens by itself; an unknown one needs a probe, tried only
// when a parked task is waiting (a probe still costs a Claude Code start-up).
async function reopenQuota(ctx: Ctx): Promise<void> {
  const quota = quotaState(ctx.db);
  if (quota.open || ctx.now() < new Date(quota.parkedUntil)) return;
  if (!quota.needsProbe) return unpark(ctx.db);
  if (tasksIn(ctx, ['quota_parked']).length === 0) return;
  const probe = await ctx.executor.probe(ctx.routing.tiers.T0);
  if (probe.ok) return unpark(ctx.db);
  park(ctx.db, { kind: probe.limitKind, resetAt: probe.resetAt, probeIntervalMs: ctx.probeIntervalMs }, ctx.now());
}

// 3.
function releaseDue(ctx: Ctx): void {
  const now = ctx.now();
  const due = (task: TaskRow) => task.resume_at === null || new Date(task.resume_at) <= now;
  const quotaOpen = quotaState(ctx.db).open;
  for (const task of tasksIn(ctx, ['retry_wait', 'quota_parked'])) {
    if (task.state === 'quota_parked' && !quotaOpen) continue;
    if (due(task)) transition(ctx.db, task.id, task.state, 'ready', { patch: { resume_at: null }, reason: 'due', now });
  }
  const unblocked = ctx.db
    .prepare(
      `SELECT * FROM tasks t WHERE t.state = 'pending' AND NOT EXISTS (
         SELECT 1 FROM task_deps d JOIN tasks dep ON dep.id = d.dep_id WHERE d.task_id = t.id AND dep.state != 'done')`,
    )
    .all() as TaskRow[];
  for (const task of unblocked) transition(ctx.db, task.id, 'pending', 'ready', { reason: 'dependencies done', now });
}

// 4. An approval binds to the task's head SHA. A new commit moves the head, and the old
// approval no longer matches anything.
async function continueApproved(ctx: Ctx): Promise<void> {
  const groups = new Map<string, TaskRow[]>();
  for (const task of tasksIn(ctx, ['awaiting_approval'])) {
    const run = getRun(ctx.db, task.run_id);
    if (!run.worktree) continue;
    const head = headSha(run.worktree);
    if (head !== task.head_sha) {
      patchTask(ctx.db, task.id, 'awaiting_approval', { head_sha: head }, ctx.now());
      logEvent(ctx.db, task.id, 'awaiting_approval', `head moved from ${task.head_sha} to ${head}; approve ${head}`, ctx.now());
      continue;
    }
    const approval = findApproval(stateDir(run.repo, ctx.env), 'task', head, ctx.env);
    if (!approval.ok || approval.record.subject !== approvalSubject(run.id)) continue;
    const by = `approved ${head} by ${approval.record.approved_by.user}`;
    if (task.failure_class === 'policy_blocked') {
      // The executor was stopped before finishing: run the task again.
      transition(ctx.db, task.id, 'awaiting_approval', 'ready', { reason: by, now: ctx.now() });
      continue;
    }
    if (!transition(ctx.db, task.id, 'awaiting_approval', 'validating', { reason: by, now: ctx.now() })) continue;
    const key = `${run.id}:${task.start_sha}`;
    groups.set(key, [...(groups.get(key) ?? []), getTask(ctx.db, task.id)]);
  }
  for (const tasks of groups.values()) await finish(ctx, tasks, { approvedSha: tasks[0]!.head_sha! });
}

export function approvalSubject(runId: number): string {
  return `run ${runId}`;
}

// 5. One batch: ready tasks of one run with the same tier and phase, highest priority
// first. A run with a task awaiting approval is held, so its head stays what you review.
function leaseBatch(ctx: Ctx): TaskRow[] | undefined {
  if (!quotaState(ctx.db).open) return undefined;
  const first = ctx.db
    .prepare(
      `SELECT t.* FROM tasks t JOIN runs r ON r.id = t.run_id
       WHERE t.state = 'ready' AND r.status = 'active'
         AND NOT EXISTS (SELECT 1 FROM tasks b WHERE b.run_id = t.run_id AND b.state = 'awaiting_approval')
       ORDER BY t.priority DESC, t.id LIMIT 1`,
    )
    .get() as TaskRow | undefined;
  if (!first) return undefined;
  return ctx.db
    .prepare(`SELECT * FROM tasks WHERE run_id = ? AND state = 'ready' AND tier = ? AND phase = ? ORDER BY priority DESC, id LIMIT ?`)
    .all(first.run_id, first.tier, first.phase, ctx.batchSize) as TaskRow[];
}

async function runBatch(ctx: Ctx, batch: TaskRow[]): Promise<BatchReport> {
  const first = batch[0]!;
  const run = getRun(ctx.db, first.run_id);
  const worktree = ensureWorktree(ctx.db, run, join(ctx.home, 'worktrees'));
  const startSha = headSha(worktree);
  const working: State = first.phase === 'review' ? 'reviewing' : 'running';
  const leased = batch.filter((task) =>
    transition(ctx.db, task.id, 'ready', 'leased', { patch: { lease_pid: ctx.pid, start_sha: startSha }, now: ctx.now() }),
  );
  for (const task of leased) transition(ctx.db, task.id, 'leased', working, { now: ctx.now() });
  if (leased.length === 0) throw new Error(`run ${run.id}: no task of the batch could be leased`);
  const tasks = leased.map((task) => getTask(ctx.db, task.id));
  const report = { runId: run.id, phase: first.phase, tier: first.tier, taskKeys: tasks.map((t) => t.key) };

  const model = ctx.routing.tiers[first.tier];
  const attempt = Math.max(...tasks.map((t) => t.validation_failures)) + 1;
  let result: ExecResult;
  try {
    result = await ctx.executor.run(
      {
        tasks: tasks.map((t) => ({ id: t.id, key: t.key, title: t.title, body: t.body, validation: JSON.parse(t.validation) as string[] })),
        phase: first.phase,
        attempt,
        worktree,
        baseSha: startSha,
        model,
        failureDigest: attempt > 1 ? (tasks.find((t) => t.failure_digest)?.failure_digest ?? undefined) : undefined,
        timeoutSec: ctx.timeoutSec,
        idleTimeoutSec: ctx.idleTimeoutSec,
      },
      AbortSignal.timeout(ctx.timeoutSec * 1000),
    );
  } catch (error) {
    result = { status: 'crashed', completedTaskIds: [], reason: String(error), failureDigest: String(error), deniedToolCalls: [], usage: NO_USAGE };
  }
  recordUsage(ctx.db, { modelId: result.modelId ?? model.id, usage: result.usage, detail: { tasks: report.taskKeys, phase: first.phase, status: result.status } }, ctx.now());

  // A crashed run leaves the worktree in an unknown state (or, with plugin_missing, holds
  // work from a session without the guard): none of its tasks count, and the reset below
  // goes all the way back to where the batch started.
  const crashed = result.status === 'crashed';
  const completed = new Set(crashed ? [] : result.completedTaskIds);
  const finished = tasks.filter((t) => completed.has(t.id));
  const unfinished = tasks.filter((t) => !completed.has(t.id));
  if (unfinished.length > 0) {
    // A "passed" run that left tasks unfinished is an executor bug: treat it as a crash.
    const status = result.status === 'passed' ? 'crashed' : result.status;
    resetWorktree(worktree, {
      sha: crashed ? startSha : undefined,
      patchPath: join(bundleDir(ctx, unfinished[0]!), `attempt-${attempt}-${Date.now()}.patch`),
    });
    let resetAt: string | undefined;
    if (status === 'quota_exhausted') {
      const kind = result.limitKind ?? 'unknown';
      resetAt = park(ctx.db, { kind, resetAt: result.resetAt, probeIntervalMs: ctx.probeIntervalMs }, ctx.now());
      if (kind === 'weekly') ctx.notify({ title: 'weekly cap reached', message: `all tasks parked until ${resetAt}`, taskIds: unfinished.map((t) => t.id) });
    }
    for (const task of unfinished) fail(ctx, task, working, status, { resetAt, failureDigest: result.failureDigest ?? result.reason, worktree });
  }
  if (finished.length > 0) {
    for (const task of finished) transition(ctx.db, task.id, working, 'validating', { patch: { lease_pid: null }, now: ctx.now() });
    await finish(ctx, finished.map((t) => getTask(ctx.db, t.id)), {});
  }
  return { ...report, status: result.status };
}

function fail(
  ctx: Ctx,
  task: TaskRow,
  from: State,
  status: Exclude<ExecStatus, 'passed'>,
  opts: { resetAt?: string; failureDigest?: string; worktree: string; gates?: Gate[] },
): void {
  const decision = decide(task, status, { now: ctx.now(), resetAt: opts.resetAt, failureDigest: opts.failureDigest });
  const head = headSha(opts.worktree);
  const patch = { ...decision.patch, lease_pid: null, ...(decision.state === 'awaiting_approval' ? { head_sha: head, gates: JSON.stringify(opts.gates ?? []) } : {}) };
  if (!transition(ctx.db, task.id, from, decision.state, { patch, reason: decision.reason, now: ctx.now() })) return;
  if (decision.state === 'needs_human') {
    const bundle = writeBundle(ctx, getTask(ctx.db, task.id), opts.worktree);
    ctx.notify({ title: `task ${task.key} needs you`, message: decision.reason, taskIds: [task.id], bundle });
  } else if (decision.state === 'awaiting_approval') {
    const rules = (opts.gates ?? []).map((g) => g.ruleId).join(', ') || status;
    ctx.notify({ title: `task ${task.key} needs approval`, message: `${rules}: run rnship task approve ${task.id} ${head}`, taskIds: [task.id] });
  }
}

// After the executor: validate, diff-check against where the batch started, then either
// hand the tasks to the review pass or mark them done. Tasks arrive in `validating`.
async function finish(ctx: Ctx, tasks: TaskRow[], opts: { approvedSha?: string }): Promise<void> {
  const first = tasks[0]!;
  const run = getRun(ctx.db, first.run_id);
  const worktree = run.worktree!;
  const startSha = first.start_sha!;
  const head = headSha(worktree);

  const commands = [...new Set(tasks.flatMap((t) => JSON.parse(t.validation) as string[]))];
  const validation = await ctx.validate({ cwd: worktree, commands });
  if (!validation.ok) {
    resetWorktree(worktree, { sha: startSha, patchPath: join(bundleDir(ctx, first), `validation-${Date.now()}.patch`) });
    for (const task of tasks) fail(ctx, task, 'validating', 'validation_failed', { failureDigest: validation.digest, worktree });
    return;
  }

  if (opts.approvedSha !== head) {
    const check = ctx.diffCheck({ root: worktree, baseRef: startSha, repo: run.repo });
    if (!check.ok) {
      for (const task of tasks) {
        fail(ctx, task, 'validating', 'policy_blocked', { worktree, gates: check.gates, failureDigest: check.gates.map((g) => g.ruleId).join(', ') });
        // A gate on finished work continues to validation once approved; it isn't re-run.
        patchTask(ctx.db, task.id, 'awaiting_approval', { failure_class: 'policy_gate' }, ctx.now());
      }
      return;
    }
  }

  for (const task of tasks) {
    if (task.phase === 'tasks' && ctx.executor.capabilities().review) {
      transition(ctx.db, task.id, 'validating', 'ready', { patch: { phase: 'review', head_sha: head }, reason: 'to review', now: ctx.now() });
    } else {
      transition(ctx.db, task.id, 'validating', 'done', { patch: { head_sha: head, failure_class: null, failure_digest: null }, now: ctx.now() });
    }
  }
}

function writeBundle(ctx: Ctx, task: TaskRow, worktree: string): string {
  const dir = bundleDir(ctx, task);
  mkdirSync(dir, { recursive: true });
  const run = getRun(ctx.db, task.run_id);
  const events = ctx.db.prepare('SELECT * FROM events WHERE task_id = ? ORDER BY id').all(task.id);
  writeFileSync(join(dir, 'task.json'), JSON.stringify({ task, run, routing: ctx.routing.tiers[task.tier], events }, null, 2) + '\n');
  writeFileSync(join(dir, 'failure.txt'), `${task.failure_class ?? ''}\n${task.failure_digest ?? ''}\n`);
  writeFileSync(join(dir, 'diff.patch'), diffSince(worktree, run.base_sha));
  return dir;
}
