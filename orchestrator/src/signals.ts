import type { Tier } from '@rnship/policy';
import { canonicalJson, sha256 } from '@rnship/release';
import { transaction, type Db } from './db.ts';
import { activeRun } from './runs.ts';
import { CLOSED_STATES } from './states.ts';

// B1 dedup (design §4). The key is hash(source, issue_id, runtime_version). If an open task
// already has the key, the new occurrence is attached to it and raises its priority.
// Task text is built only from these structured fields: no free text from a Sentry event
// ever reaches a task (untrusted input, design §2). Polling and triage arrive in M4.

export type Signal = { source: string; issue_id: string; runtime_version: string; count?: number };

export type IngestResult = { taskId: number; created: boolean; dedupKey: string };

export function signalKey(signal: Signal): string {
  return sha256(canonicalJson({ source: signal.source, issue_id: signal.issue_id, runtime_version: signal.runtime_version }));
}

export function ingestSignal(
  db: Db,
  input: { app: string; repo: string; signal: Signal; task: { tier: Tier; validation: string[] } },
  now: Date,
): IngestResult {
  const key = signalKey(input.signal);
  const count = input.signal.count ?? 1;
  const at = now.toISOString();
  return transaction(db, () => {
    const existing = db.prepare('SELECT s.task_id, s.opened, t.state FROM signals s JOIN tasks t ON t.id = s.task_id WHERE s.dedup_key = ?').get(key) as
      | { task_id: number; opened: number; state: string }
      | undefined;
    if (existing && !(CLOSED_STATES as string[]).includes(existing.state)) {
      db.prepare('UPDATE signals SET count = count + ?, last_seen = ? WHERE dedup_key = ?').run(count, at, key);
      db.prepare('UPDATE tasks SET priority = priority + 1, updated_at = ? WHERE id = ?').run(at, existing.task_id);
      return { taskId: existing.task_id, created: false, dedupKey: key };
    }

    // A closed task means the issue came back: open a new task under a fresh key.
    const opened = existing ? existing.opened + 1 : 1;
    const run = activeRun(db, { app: input.app, flow: 'B', repo: input.repo }, now);
    const { source, issue_id, runtime_version } = input.signal;
    const result = db
      .prepare(
        `INSERT INTO tasks (run_id, key, title, body, tier, validation, state, priority, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', 1, ?)`,
      )
      .run(
        run.id,
        `signal-${key.slice('sha256:'.length, 'sha256:'.length + 12)}-${opened}`,
        `Fix ${source} issue ${issue_id}`,
        `Signal: source=${source} issue_id=${issue_id} runtime_version=${runtime_version}`,
        input.task.tier,
        JSON.stringify(input.task.validation),
        at,
      );
    const taskId = Number(result.lastInsertRowid);
    db.prepare("INSERT INTO events (task_id, from_state, to_state, reason, at) VALUES (?, NULL, 'pending', 'signal', ?)").run(taskId, at);
    db.prepare(
      `INSERT INTO signals (dedup_key, task_id, count, opened, last_seen) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (dedup_key) DO UPDATE SET task_id = excluded.task_id, count = signals.count + excluded.count, opened = excluded.opened, last_seen = excluded.last_seen`,
    ).run(key, taskId, count, opened, at);
    return { taskId, created: true, dedupKey: key };
  });
}
