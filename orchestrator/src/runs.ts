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
  created_at: string;
};

/** The one active run for (app, flow), created from the repo's current HEAD if there is none. */
export function activeRun(db: Db, input: { app: string; flow: 'A' | 'B'; repo: string }, now: Date): RunRow {
  return transaction(db, () => {
    const existing = db.prepare("SELECT * FROM runs WHERE app = ? AND flow = ? AND status = 'active'").get(input.app, input.flow) as RunRow | undefined;
    if (existing) {
      if (existing.repo !== input.repo) throw new Error(`the active ${input.app} flow ${input.flow} run uses ${existing.repo}, not ${input.repo}`);
      return existing;
    }
    const baseSha = execFileSync('git', ['-C', input.repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const { lastInsertRowid } = db
      .prepare('INSERT INTO runs (app, flow, repo, base_sha, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(input.app, input.flow, input.repo, baseSha, now.toISOString());
    return getRun(db, Number(lastInsertRowid));
  });
}

export function getRun(db: Db, id: number): RunRow {
  const row = db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined;
  if (!row) throw new Error(`no run ${id}`);
  return row;
}
