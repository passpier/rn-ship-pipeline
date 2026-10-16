import type { Db } from './db.ts';
import type { LimitKind, Usage } from './executor.ts';

// Budget ledger (design §4). Claude's five-hour window and weekly cap are detected
// reactively from limit errors (S4 pending), so the ledger keeps a park state rather than
// a running total. Every executor call is recorded with the model ID that actually ran.
// EAS builds and Actions minutes are recorded the same way once M4 spends them.

export const CLAUDE = 'claude';

/** How long to wait before probing when a limit error carried no reset time. */
export const DEFAULT_PROBE_INTERVAL_MS = 15 * 60_000;

export type QuotaState = { open: true } | { open: false; parkedUntil: string; kind: LimitKind; needsProbe: boolean };

export function recordUsage(db: Db, entry: { taskId?: number; modelId?: string; usage: Usage; detail?: unknown }, now: Date): void {
  db.prepare('INSERT INTO ledger (task_id, budget, amount, model_id, detail, at) VALUES (?, ?, ?, ?, ?, ?)').run(
    entry.taskId ?? null,
    CLAUDE,
    entry.usage.inputTokens + entry.usage.outputTokens,
    entry.modelId ?? null,
    entry.detail === undefined ? null : JSON.stringify(entry.detail),
    now.toISOString(),
  );
}

export function quotaState(db: Db): QuotaState {
  const row = db.prepare('SELECT parked_until, kind, needs_probe FROM budget_state WHERE budget = ?').get(CLAUDE) as
    | { parked_until: string | null; kind: LimitKind | null; needs_probe: number }
    | undefined;
  if (!row?.parked_until) return { open: true };
  return { open: false, parkedUntil: row.parked_until, kind: row.kind ?? 'unknown', needsProbe: row.needs_probe === 1 };
}

/**
 * Parks all Claude work. With a known reset time it opens again at that time; without one
 * it opens only after a probe succeeds, first tried after `probeIntervalMs`.
 */
export function park(db: Db, input: { kind: LimitKind; resetAt?: string; probeIntervalMs?: number }, now: Date): string {
  // A reset time already in the past can't be trusted: probe instead of spinning.
  const resetAt = input.resetAt && new Date(input.resetAt) > now ? input.resetAt : undefined;
  const until = resetAt ?? new Date(now.getTime() + (input.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS)).toISOString();
  db.prepare(
    `INSERT INTO budget_state (budget, parked_until, kind, needs_probe) VALUES (?, ?, ?, ?)
     ON CONFLICT (budget) DO UPDATE SET parked_until = excluded.parked_until, kind = excluded.kind, needs_probe = excluded.needs_probe`,
  ).run(CLAUDE, until, input.kind, resetAt ? 0 : 1);
  return until;
}

export function unpark(db: Db): void {
  db.prepare('UPDATE budget_state SET parked_until = NULL, kind = NULL, needs_probe = 0 WHERE budget = ?').run(CLAUDE);
}
