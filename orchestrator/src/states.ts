import type { Tier } from '@rnship/policy';
import { transaction, type Db } from './db.ts';

// Task states (design §4). `failed(class)` and `approved` aren't stored: a failure is
// recorded in failure_class on its way to retry_wait or needs_human, and an approval
// moves awaiting_approval straight on.

export const STATES = [
  'pending',
  'ready',
  'leased',
  'running',
  'validating',
  'reviewing',
  'done',
  'quota_parked',
  'retry_wait',
  'awaiting_approval',
  'needs_human',
  'cancelled',
] as const;
export type State = (typeof STATES)[number];

/** States an executor or post-run step is working in. A dead lease owner sends them back to ready. */
export const ACTIVE_STATES: State[] = ['leased', 'running', 'validating', 'reviewing'];
/** States that block the rest of their run until you act. */
export const BLOCKING_STATES: State[] = ['awaiting_approval', 'needs_human'];
export const CLOSED_STATES: State[] = ['done', 'cancelled'];

const EDGES: Record<State, State[]> = {
  pending: ['ready', 'cancelled'],
  ready: ['leased', 'cancelled'],
  leased: ['running', 'reviewing', 'ready'],
  // running implements tasks and reviewing runs the review pass; both end in validating.
  running: ['validating', 'quota_parked', 'retry_wait', 'awaiting_approval', 'needs_human', 'ready'],
  reviewing: ['validating', 'quota_parked', 'retry_wait', 'awaiting_approval', 'needs_human', 'ready'],
  // validating → ready hands a task to the review pass (or back after a dead lease owner).
  validating: ['done', 'ready', 'retry_wait', 'awaiting_approval', 'needs_human'],
  quota_parked: ['ready'],
  retry_wait: ['ready'],
  // An approved gate continues to validating; an approved executor block re-runs the task.
  awaiting_approval: ['validating', 'ready', 'cancelled'],
  needs_human: ['cancelled'],
  done: [],
  cancelled: [],
};

export function canTransition(from: State, to: State): boolean {
  return EDGES[from].includes(to);
}

export type TaskRow = {
  id: number;
  run_id: number;
  key: string;
  title: string;
  body: string;
  tier: Tier;
  native: number;
  files: string;
  validation: string;
  state: State;
  phase: 'tasks' | 'review';
  priority: number;
  validation_failures: number;
  crashes: number;
  infra_failures: number;
  resume_at: string | null;
  failure_class: string | null;
  failure_digest: string | null;
  start_sha: string | null;
  head_sha: string | null;
  gates: string | null;
  lease_pid: number | null;
  updated_at: string;
};

export type TaskPatch = Partial<Omit<TaskRow, 'id' | 'run_id' | 'key' | 'state' | 'updated_at'>>;

export class TransitionError extends Error {}

export function getTask(db: Db, id: number): TaskRow {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
  if (!row) throw new Error(`no task ${id}`);
  return row;
}

/**
 * Moves a task from `from` to `to` and applies `patch`, as a compare-and-set: if the task
 * is no longer in `from` (another tick got there first), nothing changes and it returns
 * false. An edge the state machine doesn't allow throws.
 */
export function transition(db: Db, id: number, from: State, to: State, opts: { patch?: TaskPatch; reason?: string; now: Date }): boolean {
  if (!canTransition(from, to)) throw new TransitionError(`task ${id}: ${from} → ${to} isn't allowed`);
  const at = opts.now.toISOString();
  const patch = Object.entries(opts.patch ?? {});
  const sets = ['state = ?', 'updated_at = ?', ...patch.map(([column]) => `${column} = ?`)].join(', ');
  return transaction(db, () => {
    const result = db
      .prepare(`UPDATE tasks SET ${sets} WHERE id = ? AND state = ?`)
      .run(to, at, ...patch.map(([, value]) => value as string | number | null), id, from);
    if (result.changes === 0) return false;
    db.prepare('INSERT INTO events (task_id, from_state, to_state, reason, at) VALUES (?, ?, ?, ?, ?)').run(id, from, to, opts.reason ?? null, at);
    return true;
  });
}

export function logEvent(db: Db, id: number, state: State, reason: string, now: Date): void {
  db.prepare('INSERT INTO events (task_id, from_state, to_state, reason, at) VALUES (?, ?, ?, ?, ?)').run(id, state, state, reason, now.toISOString());
}

/** Updates columns without a state change (the state must still be `state`). */
export function patchTask(db: Db, id: number, state: State, patch: TaskPatch, now: Date): boolean {
  const entries = Object.entries(patch);
  const sets = ['updated_at = ?', ...entries.map(([column]) => `${column} = ?`)].join(', ');
  const result = db
    .prepare(`UPDATE tasks SET ${sets} WHERE id = ? AND state = ?`)
    .run(now.toISOString(), ...entries.map(([, value]) => value as string | number | null), id, state);
  return result.changes > 0;
}
