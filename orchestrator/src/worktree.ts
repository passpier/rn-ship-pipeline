import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Db } from './db.ts';
import type { RunRow } from './runs.ts';

// One git worktree per run, on branch `agent/run-<id>`, so the app repo's own checkout is
// never touched. Tasks checkpoint at commits (D4): anything uncommitted when a run stops
// is saved as a patch for context and then discarded.

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export function headSha(cwd: string): string {
  return git(cwd, 'rev-parse', 'HEAD').trim();
}

/** The run's worktree, created on first use from the run's base SHA. */
export function ensureWorktree(db: Db, run: RunRow, worktreesDir: string): string {
  const path = run.worktree ?? join(worktreesDir, `run-${run.id}`);
  const branch = run.branch ?? `agent/run-${run.id}`;
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    git(run.repo, 'worktree', 'prune');
    const branchExists = git(run.repo, 'branch', '--list', branch).trim() !== '';
    if (branchExists) git(run.repo, 'worktree', 'add', path, branch);
    else git(run.repo, 'worktree', 'add', '-b', branch, path, run.base_sha);
  }
  if (run.worktree !== path || run.branch !== branch) db.prepare('UPDATE runs SET worktree = ?, branch = ? WHERE id = ?').run(path, branch, run.id);
  return path;
}

/**
 * Saves uncommitted work (untracked files included) to `patchPath` if there is any, then
 * resets the worktree to `sha` (default: HEAD) and removes untracked files. Ignored files
 * such as node_modules stay.
 */
export function resetWorktree(cwd: string, opts: { sha?: string; patchPath?: string } = {}): void {
  git(cwd, 'add', '-A', '--intent-to-add');
  const patch = git(cwd, 'diff', 'HEAD', '--binary');
  if (patch && opts.patchPath) {
    mkdirSync(dirname(opts.patchPath), { recursive: true });
    writeFileSync(opts.patchPath, patch);
  }
  git(cwd, 'reset', '-q', '--hard', opts.sha ?? 'HEAD');
  git(cwd, 'clean', '-q', '-fd');
}

/** Committed and uncommitted changes since `base`, for a needs_human bundle. */
export function diffSince(cwd: string, base: string): string {
  git(cwd, 'add', '-A', '--intent-to-add');
  return git(cwd, 'diff', base, '--binary');
}
