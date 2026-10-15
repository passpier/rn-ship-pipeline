import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { basename, join, matchesGlob, relative } from 'node:path';
import { loadProjectState } from '@rnship/ota';
import { changedGates, PROTECTED_PATHS, type Gate, type Policy } from '@rnship/policy';
import { baselineDigest, baselineState, findApproval, loadBaseline, stateDir } from '@rnship/release';

// `rnship policy check`: the orchestrator's diff check after every executor run, and a
// PR check. It's authoritative for code changes (D1), unlike the hook.
// - files matches and protected paths fire on contact: the path changed since base-ref.
// - deps and config_paths matches fire on a change beyond the approved baseline. With no
//   approved baseline they fall back to contact on package.json / app config (fail closed).

export type CheckInput = {
  /** App project root (inside a git repo). */
  root: string;
  /** Commit the change started from, usually the task's base SHA or the PR base. */
  baseRef: string;
  policy: Policy;
  /** Defaults to <root>/.rnship/approved-baseline.yaml. */
  baselinePath?: string;
  env?: Record<string, string | undefined>;
};

export type CheckResult = {
  ok: boolean;
  baseline: { path: string; digest?: string; approved: boolean; reason?: string };
  changed_files: string[];
  gates: Gate[];
};

const MANIFESTS = ['package.json', 'app.json', 'app.config.js', 'app.config.ts', 'app.config.mjs', 'app.config.cjs'];

export function policyCheck(input: CheckInput): CheckResult {
  const env = input.env ?? process.env;
  const changed = changedFiles(input.root, input.baseRef);
  const gates: Gate[] = [];

  const protectedHits = changed.filter((file) => PROTECTED_PATHS.some((glob) => matchesGlob(file, glob)));
  if (protectedHits.length > 0) {
    gates.push({ ruleId: 'protected_path', category: 'change_scope', effect: 'deny', matches: protectedHits });
  }
  for (const rule of input.policy.rules) {
    if (rule.effect === 'allow') continue;
    const hits = changed.filter((file) => rule.match.files.some((glob) => matchesGlob(file, glob) || matchesGlob(file, `**/${glob}`)));
    if (hits.length > 0) gates.push({ ruleId: rule.id, category: rule.category, effect: rule.effect, matches: hits });
  }

  const baselinePath = input.baselinePath ?? join(input.root, '.rnship', 'approved-baseline.yaml');
  const baseline = approvedBaseline(baselinePath, input.root, env);
  if (baseline.approved) {
    const before = baselineState(loadBaseline(baselinePath));
    const after = loadProjectState(input.root);
    gates.push(...changedGates(input.policy, before, after, { depRemovals: false }).filter((g) => g.effect !== 'allow'));
  } else {
    const touched = changed.filter((file) => MANIFESTS.includes(basename(file)));
    if (touched.length > 0) {
      for (const rule of input.policy.rules) {
        if (rule.effect === 'allow' || (rule.match.deps.length === 0 && rule.match.config_paths.length === 0)) continue;
        gates.push({ ruleId: rule.id, category: rule.category, effect: rule.effect, matches: touched.map((f) => `contact:${f}`) });
      }
    }
  }

  return { ok: gates.length === 0, baseline, changed_files: changed, gates: mergeGates(gates) };
}

function approvedBaseline(path: string, root: string, env: Record<string, string | undefined>): CheckResult['baseline'] {
  if (!existsSync(path)) return { path, approved: false, reason: 'no approved baseline file; deps and config rules fire on contact' };
  const digest = baselineDigest(loadBaseline(path));
  const approval = findApproval(stateDir(root, env), 'baseline', digest, env);
  return approval.ok
    ? { path, digest, approved: true }
    : { path, digest, approved: false, reason: `${approval.reason}; deps and config rules fire on contact` };
}

// Files changed since baseRef, committed or not, relative to the project root. Paths
// outside the root (for example the repo's own .claude/) keep their `../` prefix
// and are matched by their repo-relative form too.
function changedFiles(root: string, baseRef: string): string[] {
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  const realRoot = realpathSync(root);
  const top = git('rev-parse', '--show-toplevel').trim();
  const lines = [
    ...git('diff', '--name-only', '--no-renames', `${baseRef}...HEAD`).split('\n'),
    ...git('diff', '--name-only', '--no-renames', 'HEAD').split('\n'),
    ...git('ls-files', '--others', '--exclude-standard', '--full-name').split('\n'),
  ].filter(Boolean);
  const files = new Set<string>();
  for (const repoPath of lines) {
    const rel = relative(realRoot, join(top, repoPath));
    files.add(rel.startsWith('..') ? repoPath : rel);
  }
  return [...files].sort();
}

function mergeGates(gates: Gate[]): Gate[] {
  const byRule = new Map<string, Gate>();
  for (const gate of gates) {
    const existing = byRule.get(gate.ruleId);
    if (existing) existing.matches = [...new Set([...existing.matches, ...gate.matches])];
    else byRule.set(gate.ruleId, { ...gate, matches: [...gate.matches] });
  }
  return [...byRule.values()];
}
