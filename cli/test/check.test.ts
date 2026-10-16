import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadProjectState } from '@rnship/ota';
import { loadBasePolicy } from '@rnship/policy';
import { stateDir, writeApproval, baselineDigest, parseBaseline } from '@rnship/release';
import { scenario } from '../../ota/test/scenario.ts';
import { policyCheck } from '../src/check.ts';

const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));

// A git repo of the fixture app with a baseline committed at the base commit. The
// baseline allowlists the app's current deps plus expo-camera (not yet used).
async function repo(opts: { approve: boolean }) {
  const s = await scenario();
  const root = s.candidate;
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  const state = loadProjectState(root);
  const baseline = {
    version: 1,
    dependencies: { ...state.dependencies, 'expo-camera': '~55.0.23' },
    config: JSON.parse(JSON.stringify(state.config)),
  };
  mkdirSync(join(root, '.rnship'), { recursive: true });
  writeFileSync(join(root, '.rnship', 'approved-baseline.yaml'), JSON.stringify(baseline, null, 2));
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n.rnship/state/\n');
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'base');
  const baseRef = git('rev-parse', 'HEAD').trim();
  if (opts.approve) {
    writeApproval(stateDir(root, {}), { kind: 'baseline', digest: baselineDigest(parseBaseline(JSON.stringify(baseline))), subject: 'baseline' }, {});
  }
  const addDep = (name: string, spec: string) => {
    const pkgPath = join(root, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    pkg.dependencies[name] = spec;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  };
  const check = () => policyCheck({ root, baseRef, policy: loadBasePolicy(), env: {} });
  return { s, root, baseRef, addDep, check };
}

describe('rnship policy check', () => {
  it('fails a change that adds react-native-purchases, which is not in the approved baseline', async () => {
    const r = await repo({ approve: true });
    r.addDep('react-native-purchases', '^9.0.0');

    const run = spawnSync(process.execPath, [MAIN, 'policy', 'check', r.root, '--base-ref', r.baseRef], { encoding: 'utf8' });

    expect(run.status).toBe(1);
    const result = JSON.parse(run.stdout);
    expect(result.baseline.approved).toBe(true);
    expect(result.gates).toContainEqual(expect.objectContaining({ ruleId: 'payment.sdk', matches: ['deps:react-native-purchases'] }));
  });

  it('passes a change that adds a dependency the baseline allowlists', async () => {
    const r = await repo({ approve: true });
    r.addDep('expo-camera', '~55.0.23');

    expect(r.check()).toMatchObject({ ok: true, gates: [] });
  });

  it('passes a JS-only change', async () => {
    const r = await repo({ approve: true });
    r.s.edit('src/App.js', (text) => text.replace('rnship fixture', 'rnship fixture v2'));

    expect(r.check()).toMatchObject({ ok: true, changed_files: ['src/App.js'] });
  });

  it('fails a dependency at a version other than the baseline pins', async () => {
    const r = await repo({ approve: true });
    r.addDep('expo-camera', '~58.0.0');

    expect(r.check().gates).toContainEqual(expect.objectContaining({ ruleId: 'deps.upgrade', matches: ['deps:expo-camera'] }));
  });

  it('fires deps and config rules on contact when the baseline is not approved', async () => {
    const r = await repo({ approve: false });
    r.addDep('expo-camera', '~55.0.23');

    const result = r.check();

    expect(result.ok).toBe(false);
    expect(result.baseline).toMatchObject({ approved: false });
    expect(result.gates).toContainEqual(expect.objectContaining({ ruleId: 'deps.upgrade', matches: ['contact:package.json'] }));
    expect(result.gates).toContainEqual(expect.objectContaining({ ruleId: 'permissions.native' }));
  });

  it('fires on contact when the baseline itself was edited after approval', async () => {
    const r = await repo({ approve: true });
    const path = join(r.root, '.rnship', 'approved-baseline.yaml');
    const baseline = JSON.parse(readFileSync(path, 'utf8'));
    baseline.dependencies['react-native-purchases'] = '^9.0.0';
    writeFileSync(path, JSON.stringify(baseline));
    r.addDep('react-native-purchases', '^9.0.0');

    const result = r.check();

    expect(result.baseline.approved).toBe(false);
    expect(result.gates).toContainEqual(expect.objectContaining({ ruleId: 'protected_path', matches: ['.rnship/approved-baseline.yaml'] }));
    expect(result.gates).toContainEqual(expect.objectContaining({ ruleId: 'payment.sdk', matches: ['contact:package.json'] }));
  });

  it('fails any change under .claude/', async () => {
    const r = await repo({ approve: true });
    r.s.write('.claude/settings.json', '{"disableAllHooks": true}\n');

    expect(r.check().gates).toContainEqual(expect.objectContaining({ ruleId: 'protected_path', matches: ['.claude/settings.json'] }));
  });

  it('fails edits to files a rule gates on contact', async () => {
    const r = await repo({ approve: true });
    r.s.write('store/products.yaml', 'products: []\n');

    expect(r.check().gates).toContainEqual(expect.objectContaining({ ruleId: 'iap.pricing', matches: ['store/products.yaml'] }));
  });
});
