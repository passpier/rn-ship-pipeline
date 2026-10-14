import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scenario } from '../../ota/test/scenario.ts';

const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));

function rnship(...args: string[]) {
  const run = spawnSync(process.execPath, [MAIN, ...args], { encoding: 'utf8' });
  return { code: run.status, stdout: run.stdout, stderr: run.stderr };
}

function projectPolicy(yamlText: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'rnship-cli-')), 'policy.yaml');
  writeFileSync(path, yamlText);
  return path;
}

describe('rnship policy', () => {
  it('merge exits non-zero and names the rule when the project layer relaxes a locked rule', () => {
    const project = projectPolicy('version: 1\nrules:\n  - id: store.release\n    category: store_release\n    effect: allow\n');

    const run = rnship('policy', 'merge', project);

    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('store.release');
    expect(run.stdout).toBe('');
  });

  it('merge prints the merged policy as JSON', () => {
    const project = projectPolicy('version: 1\nrules:\n  - id: store.release\n    category: store_release\n    effect: deny\n');

    const run = rnship('policy', 'merge', project);

    expect(run.code).toBe(0);
    const merged = JSON.parse(run.stdout);
    expect(merged.rules).toContainEqual(expect.objectContaining({ id: 'store.release', effect: 'deny', locked: true }));
  });

  it('compile writes Claude settings with deny and ask rules plus the hook rules', () => {
    const out = mkdtempSync(join(tmpdir(), 'rnship-compile-'));
    const project = projectPolicy('version: 1\nrules: []\n');

    const run = rnship('policy', 'compile', project, '--out', out);

    expect(run.code).toBe(0);
    const settings = JSON.parse(readFileSync(join(out, 'settings.json'), 'utf8'));
    expect(settings.permissions.deny).toEqual(
      expect.arrayContaining(['Bash(eas credentials*)', 'Bash(npm install*)', 'Read(**/*.p8)', 'Edit(.claude/**)']),
    );
    expect(settings.permissions.ask).toEqual(expect.arrayContaining(['Bash(eas submit*)', 'Edit(store/products.yaml)']));
    const hookRules = JSON.parse(readFileSync(join(out, 'hook-rules.json'), 'utf8'));
    expect(hookRules.rules.map((r: { id: string }) => r.id)).toContain('payment.sdk');
  });
});

describe('rnship ota', () => {
  it('record writes the fingerprint and native manifest for each platform', async () => {
    const s = await scenario();
    const out = mkdtempSync(join(tmpdir(), 'rnship-record-'));

    const run = rnship('ota', 'record', s.base, '--out', out, '--build-id', 'build-42');

    expect(run.code).toBe(0);
    for (const file of ['build.json', 'fingerprint.ios.json', 'fingerprint.android.json', 'native-manifest.ios.json', 'native-manifest.android.json']) {
      expect(existsSync(join(out, file))).toBe(true);
    }
  });

  it('classify prints the per-platform verdict as JSON', async () => {
    const s = await scenario();
    s.write('src/foo.js', "import { requireNativeModule } from 'expo';\nexport default requireNativeModule('Foo');\n");

    const run = rnship('ota', 'classify', '--base', s.base, '--artifacts', s.artifacts, '--candidate', s.candidate);

    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ ios: 'BUILD', android: 'BUILD', base_build_id: 'fixture-build-1' });
  });
});
