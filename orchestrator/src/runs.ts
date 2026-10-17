import { execFileSync } from 'node:child_process';
import { transaction, type Db } from './db.ts';

export type RunRow = {
  id: number;
  app: string;
  flow: 'A' | 'B';
  repo: string;
  status: 'active' | 'closed';
  base_sha: string;
  branch: string | null;
  worktree: string | null;
  /** Flow A: the change folder and the scope digest the run implements (change_scope gate). */
  change_dir: string | null;
  change_digest: string | null;
  /** Why tick holds the run, as last notified; null when it isn't held. */
  hold: string | null;
  /** When the run's change was prepared in its worktree (A3b delta install, smoke flows). */
  prepared_at: string | null;
  created_at: string;
};

/**
 * The one active run for (app, flow), created from the repo's current HEAD if there is none.
 * A Flow A run is bound to one change: importing another change's tasks into it fails.
 */
export function activeRun(db: Db, input: { app: string; flow: 'A' | 'B'; repo: string; change?: { dir: string; digest: string } }, now: Date): RunRow {
  return transaction(db, () => {
    const existing = db.prepare("SELECT * FROM runs WHERE app = ? AND flow = ? AND status = 'active'").get(input.app, input.flow) as RunRow | undefined;
    if (existing) {
      if (existing.repo !== input.repo) throw new Error(`the active ${input.app} flow ${input.flow} run uses ${existing.repo}, not ${input.repo}`);
      if ((existing.change_dir ?? undefined) !== input.change?.dir || (existing.change_digest ?? undefined) !== input.change?.digest) {
        throw new Error(`the active ${input.app} flow ${input.flow} run implements ${existing.change_dir ?? 'no change'} at ${existing.change_digest ?? '-'}; close it before importing another change`);
      }
      return existing;
    }
    const baseSha = execFileSync('git', ['-C', input.repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const { lastInsertRowid } = db
      .prepare('INSERT INTO runs (app, flow, repo, base_sha, change_dir, change_digest, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(input.app, input.flow, input.repo, baseSha, input.change?.dir ?? null, input.change?.digest ?? null, now.toISOString());
    return getRun(db, Number(lastInsertRowid));
  });
}

export function getRun(db: Db, id: number): RunRow {
  const row = db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined;
  if (!row) throw new Error(`no run ${id}`);
  return row;
}
