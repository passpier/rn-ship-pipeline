import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { changeDigest, checkChangeGate, type Impact, type RunRow } from '@rnship/orchestrator';
import { baselineDigest, findApproval, loadBaseline, stateDir, stringifyBaseline, writeApproval, type Baseline } from '@rnship/release';
import { describe, expect, it } from 'vitest';
import { changeApprove } from '../src/change.ts';

const FIXTURES = fileURLToPath(new URL('../../fixtures/changes', import.meta.url));
const BASELINE: Baseline = { version: 1, dependencies: { expo: '~55.0.31' }, config: { android: { permissions: [] } } };

/** A project with an approved baseline and the tank-photo change after intake (no LLM: impact written by hand). */
function project(verdict: Impact['verdict'] = 'go-dev-build') {
  const root = mkdtempSync(join(tmpdir(), 'rnship-change-'));
  mkdirSync(join(root, '.rnship'), { recursive: true });
  writeFileSync(join(root, '.rnship', 'approved-baseline.yaml'), stringifyBaseline(BASELINE));
  writeApproval(stateDir(root, {}), { kind: 'baseline', digest: baselineDigest(BASELINE), subject: 'stage 0' }, {});
  const dir = join(root, '.rnship', 'changes', 'tank-photo');
  cpSync(join(FIXTURES, 'tank-photo', 'change-request.yaml'), join(dir, 'change-request.yaml'), { recursive: true });
  const impact: Impact = { version: 1, verdict, native_build: true, store_review_risk: 'medium', rule_hits: [], install: ['expo-camera@~55.0.0'], capabilities: ['camera'] };
  writeFileSync(join(dir, 'impact.json'), JSON.stringify(impact));
  writeFileSync(join(dir, 'baseline-delta.yaml'), 'version: 1\ndependencies:\n  expo-camera: ~55.0.0\nconfig:\n  plugins: [expo-camera]\n');
  writeFileSync(join(dir, 'screens.yaml'), 'version: 1\nroutes: []\n');
  return { root, dir };
}

const run = (root: string, dir: string, digest: string): RunRow => ({
  id: 1,
  app: 'demo',
  flow: 'A',
  repo: root,
  status: 'active',
  base_sha: 'x',
  branch: null,
  worktree: null,
  change_dir: dir,
  change_digest: digest,
  hold: null,
  prepared_at: null,
  created_at: '',
});

describe('rnship change approve', () => {
  it('merges the delta into the baseline, approves both, and the gate then passes', () => {
    const { root, dir } = project();
    const digest = changeDigest(dir);
    expect(checkChangeGate(run(root, dir, digest), {})).toEqual({ ok: false, reason: expect.stringMatching(/isn't approved/) });

    const records = changeApprove({ dir, digest, project: root }, {});
    expect(records).toHaveLength(2);
    const merged = loadBaseline(join(root, '.rnship', 'approved-baseline.yaml'));
    expect(merged.dependencies['expo-camera']).toBe('~55.0.0');
    expect(merged.config).toEqual({ android: { permissions: [] }, plugins: ['expo-camera'] });
    expect(findApproval(stateDir(root, {}), 'baseline', baselineDigest(merged), {}).ok).toBe(true);
    expect(checkChangeGate(run(root, dir, digest), {})).toEqual({ ok: true });
  });

  it('refuses another digest, a stopped change, an unapproved baseline, and the agent user', () => {
    const { root, dir } = project();
    const digest = changeDigest(dir);
    expect(() => changeApprove({ dir, digest: `sha256:${'0'.repeat(64)}`, project: root }, {})).toThrow(/review it again/);
    expect(() => changeApprove({ dir, digest, project: root }, { RNSHIP_AGENT_USER: userInfo().username })).toThrow(/agent user/);

    writeFileSync(join(root, '.rnship', 'approved-baseline.yaml'), stringifyBaseline({ ...BASELINE, dependencies: { expo: '~55.0.30' } }));
    expect(() => changeApprove({ dir, digest, project: root }, {})).toThrow(/isn't approved itself/);

    const stopped = project('stop');
    expect(() => changeApprove({ dir: stopped.dir, digest: changeDigest(stopped.dir), project: stopped.root }, {})).toThrow(/needs an ADR/);
  });
});
