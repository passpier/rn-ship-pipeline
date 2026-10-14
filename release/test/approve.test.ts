import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MAIN = fileURLToPath(new URL('../../cli/src/main.ts', import.meta.url));
const SHA = 'a'.repeat(40);

// A clean git checkout plus fake `gh` and `eas` that log every call and print the
// canned JSON from FAKE_* env vars. `merge`, `submit`, `build`, and `republish` calls
// are the side effects the tests look for.
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'rnship-approve-'));
  const bin = join(root, 'bin');
  const work = join(root, 'work');
  const log = join(root, 'calls.log');
  mkdirSync(bin);
  mkdirSync(work);
  for (const [name, script] of Object.entries({
    gh: `if [ "$1 $2" = "pr view" ]; then printf '%s' "$FAKE_GH_PR"; fi`,
    eas: `case "$1" in build:view) printf '%s' "$FAKE_EAS_BUILD";; update:view) printf '%s' "$FAKE_EAS_UPDATE";; esac`,
  })) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\n${script}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const git = (...args: string[]) => execFileSync('git', ['-C', work, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  writeFileSync(join(work, 'README.md'), 'app\n');
  git('add', '-A');
  git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'base');
  const head = git('rev-parse', 'HEAD');

  function rnship(args: string[], env: Record<string, string> = {}) {
    const run = spawnSync(process.execPath, [MAIN, ...args], {
      cwd: work,
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: process.env.HOME,
        RNSHIP_STATE_DIR: join(root, 'state'),
        RNSHIP_AGENT_USER: 'rnship-agent-test',
        ...env,
      },
    });
    return { code: run.status, stdout: run.stdout, stderr: run.stderr };
  }
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);
  return { work, head, rnship, calls, git };
}

const asAgent = { RNSHIP_AGENT_USER: userInfo().username };

describe('rnship merge approve', () => {
  it('merges when the PR head matches the approved SHA, pinned with --match-head-commit', () => {
    const s = sandbox();
    const run = s.rnship(['merge', 'approve', SHA, '--pr', '7'], { FAKE_GH_PR: JSON.stringify({ headRefOid: SHA, state: 'OPEN' }) });

    expect(run.code).toBe(0);
    expect(s.calls()).toContain(`gh pr merge 7 --merge --match-head-commit ${SHA}`);
  });

  it('refuses when the PR head moved past the approved SHA', () => {
    const s = sandbox();
    const run = s.rnship(['merge', 'approve', SHA, '--pr', '7'], { FAKE_GH_PR: JSON.stringify({ headRefOid: 'b'.repeat(40), state: 'OPEN' }) });

    expect(run.code).toBe(1);
    expect(run.stderr).toContain('not ' + SHA);
    expect(s.calls().some((c) => c.startsWith('gh pr merge'))).toBe(false);
  });

  it('refuses to run as the agent user, before calling gh', () => {
    const s = sandbox();
    const run = s.rnship(['merge', 'approve', SHA, '--pr', '7'], { ...asAgent, FAKE_GH_PR: JSON.stringify({ headRefOid: SHA, state: 'OPEN' }) });

    expect(run.code).toBe(1);
    expect(run.stderr).toContain('agent user');
    expect(s.calls()).toEqual([]);
  });

  it('is single-use', () => {
    const s = sandbox();
    const env = { FAKE_GH_PR: JSON.stringify({ headRefOid: SHA, state: 'OPEN' }) };
    expect(s.rnship(['merge', 'approve', SHA, '--pr', '7'], env).code).toBe(0);
    const again = s.rnship(['merge', 'approve', SHA, '--pr', '7'], env);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain('single-use');
  });
});

describe('rnship release approve', () => {
  it('build refuses a SHA that is not HEAD', () => {
    const s = sandbox();
    const run = s.rnship(['release', 'approve', 'build', SHA, '--platform', 'ios']);

    expect(run.code).toBe(1);
    expect(s.calls()).toEqual([]);
  });

  it('build refuses a dirty checkout, then builds a clean HEAD', () => {
    const s = sandbox();
    writeFileSync(join(s.work, 'README.md'), 'changed\n');
    expect(s.rnship(['release', 'approve', 'build', s.head, '--platform', 'ios']).stderr).toContain('uncommitted');

    s.git('checkout', '--', 'README.md');
    expect(s.rnship(['release', 'approve', 'build', s.head, '--platform', 'ios']).code).toBe(0);
    expect(s.calls()).toContain('eas build --profile production --platform ios --non-interactive');
  });

  const build = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ id: 'build-1', status: 'FINISHED', platform: 'IOS', buildProfile: 'production', gitCommitHash: SHA, ...over });

  it('submit refuses a build ID that eas does not confirm as a finished production build', () => {
    const s = sandbox();
    for (const fake of [build({ id: 'build-2' }), build({ status: 'IN_PROGRESS' }), build({ buildProfile: 'preview' })]) {
      expect(s.rnship(['release', 'approve', 'submit', 'build-1'], { FAKE_EAS_BUILD: fake }).code).toBe(1);
    }
    expect(s.calls().some((c) => c.startsWith('eas submit'))).toBe(false);
  });

  it('submit submits a matching build', () => {
    const s = sandbox();
    const run = s.rnship(['release', 'approve', 'submit', 'build-1'], { FAKE_EAS_BUILD: build() });

    expect(run.code).toBe(0);
    expect(s.calls()).toContain('eas submit --platform ios --id build-1 --profile production --non-interactive');
  });

  const updates = (sha: string, over: Record<string, unknown> = {}) =>
    JSON.stringify(['ios', 'android'].map((platform) => ({ group: 'group-1', branch: 'staging', platform, gitCommitHash: sha, runtimeVersion: '1', ...over })));

  it('update refuses a group built from another commit or branch', () => {
    const s = sandbox();
    expect(s.rnship(['release', 'approve', 'update', 'group-1'], { FAKE_EAS_UPDATE: updates(SHA) }).code).toBe(1);
    expect(s.rnship(['release', 'approve', 'update', 'group-1'], { FAKE_EAS_UPDATE: updates(s.head, { branch: 'main' }) }).code).toBe(1);
    expect(s.calls().some((c) => c.startsWith('eas update:republish'))).toBe(false);
  });

  it('update republishes a matching staging group to production at the rollout percentage', () => {
    const s = sandbox();
    const run = s.rnship(['release', 'approve', 'update', 'group-1', '--rollout', '10'], { FAKE_EAS_UPDATE: updates(s.head) });

    expect(run.code).toBe(0);
    expect(s.calls()).toContainEqual(expect.stringMatching(/^eas update:republish --group group-1 --destination-channel production --rollout-percentage 10 /));
  });

  it('refuses every release action as the agent user', () => {
    const s = sandbox();
    expect(s.rnship(['release', 'approve', 'build', s.head, '--platform', 'ios'], asAgent).code).toBe(1);
    expect(s.rnship(['release', 'approve', 'submit', 'build-1'], { ...asAgent, FAKE_EAS_BUILD: build() }).code).toBe(1);
    expect(s.rnship(['release', 'approve', 'update', 'group-1'], { ...asAgent, FAKE_EAS_UPDATE: updates(s.head) }).code).toBe(1);
    expect(s.calls()).toEqual([]);
  });
});
