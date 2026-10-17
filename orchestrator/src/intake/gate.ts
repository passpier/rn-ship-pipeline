import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { baselineDigest, findApproval, loadBaseline, stateDir } from '@rnship/release';
import type { RunRow } from '../runs.ts';
import { git } from '../worktree.ts';
import { FILES, loadDelta, loadImpact, loadRequest } from './folder.ts';
import { baselineCovers, deltaIsEmpty } from './impact.ts';
import { scopeApproved } from './intake.ts';

// What tick checks before it leases any task of a Flow A run (change_scope, design §3),
// and the one-time preparation of the run's worktree once the gate passes.

type Env = Record<string, string | undefined>;

export type GateCheck = { ok: true } | { ok: false; reason: string };
export type ChangeGate = (run: RunRow) => GateCheck;

export const BASELINE_FILE = join('.rnship', 'approved-baseline.yaml');

/**
 * The run's change folder, as it is now in the app repo, must still have the digest the run
 * was imported with, carry your change approval, not be stopped, and, when it has a
 * baseline delta, the repo's approved baseline must hold the delta and be approved itself.
 */
export function checkChangeGate(run: RunRow, env: Env = process.env): GateCheck {
  if (!run.change_dir) return { ok: true };
  try {
    const scope = scopeApproved(run.change_dir, run.repo, env);
    if (scope.digest !== run.change_digest) return { ok: false, reason: `change edited after its tasks were imported: ${run.change_digest} is now ${scope.digest}` };
    if (!scope.ok) return { ok: false, reason: scope.reason };
    const impact = loadImpact(run.change_dir);
    if (!impact) return { ok: false, reason: 'the change has no impact.json' };
    if (impact.verdict === 'stop') return { ok: false, reason: 'the change was stopped by the change-impact gate' };
    const delta = loadDelta(run.change_dir);
    if (delta && !deltaIsEmpty(delta)) {
      const path = join(run.repo, BASELINE_FILE);
      if (!existsSync(path)) return { ok: false, reason: `the change has a baseline delta and ${path} doesn't exist` };
      const baseline = loadBaseline(path);
      if (!baselineCovers(baseline, delta)) return { ok: false, reason: `${path} doesn't hold the change's baseline delta yet` };
      const approval = findApproval(stateDir(run.repo, env), 'baseline', baselineDigest(baseline), env);
      if (!approval.ok) return { ok: false, reason: `the baseline with the change's delta isn't approved: ${approval.reason}` };
    }
    return { ok: true };
  } catch (error) {
    // Fail closed: a change folder that can't be read holds the run.
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Runs `npx expo install <packages>` in the worktree (under the validation sandbox in production). */
export type Installer = (input: { cwd: string; packages: string[] }) => Promise<{ ok: boolean; digest?: string }>;
export type Prepare = (input: { run: RunRow; worktree: string }) => Promise<GateCheck>;

const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'];

/**
 * A3b for the change's delta, outside Claude (executors may never install): install the
 * approved packages so package.json and the lockfile change together, bring in the
 * approved baseline and the smoke flows (protected paths an executor can't write), and
 * commit it all before the first task starts. Tasks' diff checks start after this commit.
 */
export function changePreparer(install: Installer): Prepare {
  return async ({ run, worktree }) => {
    const dir = run.change_dir!;
    const request = loadRequest(dir);
    const impact = loadImpact(dir)!;

    const baseline = join(run.repo, BASELINE_FILE);
    if (existsSync(baseline)) {
      mkdirSync(join(worktree, '.rnship'), { recursive: true });
      copyFileSync(baseline, join(worktree, BASELINE_FILE));
    }
    const smoke = join(dir, FILES.tasksDir, 'smoke');
    if (existsSync(smoke)) {
      mkdirSync(join(worktree, 'smoke'), { recursive: true });
      for (const name of readdirSync(smoke).filter((n) => n.endsWith('.yaml'))) copyFileSync(join(smoke, name), join(worktree, 'smoke', name));
    }

    if (impact.install.length > 0) {
      const result = await install({ cwd: worktree, packages: impact.install });
      if (!result.ok) return { ok: false, reason: `installing ${impact.install.join(' ')} failed: ${result.digest ?? 'no detail'}` };
      const pkg = JSON.parse(readFileSync(join(worktree, 'package.json'), 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      const off = impact.install.filter((spec) => {
        const at = spec.lastIndexOf('@');
        return deps[spec.slice(0, at)] !== spec.slice(at + 1);
      });
      if (off.length > 0) return { ok: false, reason: `after the install, package.json doesn't pin ${off.join(', ')} as approved` };
      const changed = git(worktree, 'status', '--porcelain').split('\n').map((l) => l.slice(3));
      if (!changed.some((file) => LOCKFILES.includes(file))) return { ok: false, reason: 'the install changed no lockfile' };
    }

    if (git(worktree, 'status', '--porcelain').trim() !== '') {
      git(worktree, 'add', '-A');
      git(worktree, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '--no-verify', '-m', `chore: prepare change ${request.id}`);
    }
    return { ok: true };
  };
}
