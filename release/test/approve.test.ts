import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MAIN = fileURLToPath(new URL('../../cli/src/main.ts', import.meta.url));
const SHA = 'a'.repeat(40);

// A clean git checkout plus fake `gh` and `eas` that log every call and print the
// canned JSON from FAKE_* env vars (FAKE_GH_MAIN: the base head; FAKE_GH_PARENT: the
// merge commit's first parent). `merge`, `submit`, `build`, and `republish` calls
// are the side effects the tests look for.
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'rnship-approve-'));
  const bin = join(root, 'bin');
  const work = join(root, 'work');
  const log = join(root, 'calls.log');
  mkdirSync(bin);
  mkdirSync(work);
  for (const [name, script] of Object.entries({
    gh: [
      'case "$1:$2:$5" in',
      `  pr:view:mergeCommit) printf '%s' "$FAKE_GH_MERGED";;`,
      `  pr:view:*) printf '%s' "$FAKE_GH_PR";;`,
      `  api:*/git/ref/heads/*) printf '%s' "$FAKE_GH_MAIN";;`,
      `  api:*/commits/*) printf '%s' "$FAKE_GH_PARENT";;`,
      'esac',
    ].join('\n'),
    eas: `case "$1" in --version) echo "eas-cli/\${FAKE_EAS_VERSION:-24.13.0} darwin-arm64 node-v24.0.0";; build:view) printf '%s' "$FAKE_EAS_BUILD";; update:view) printf '%s' "$FAKE_EAS_UPDATE";; esac`,
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
  return { root, work, head, rnship, calls, git };
}

const asAgent = { RNSHIP_AGENT_USER: userInfo().username };

const MAIN_1 = '1'.repeat(40);
const MAIN_2 = '2'.repeat(40);
const LEDGER = 'main-heads/passpier_app_main.json';

/** gh fakes for PR 7 at SHA against passpier/app, base `main` at MAIN_1, merging into MAIN_2. */
const gh = (over: { head?: string; main?: string; parent?: string } = {}) => ({
  FAKE_GH_PR: JSON.stringify({ headRefOid: over.head ?? SHA, state: 'OPEN', baseRefName: 'main', url: 'https://github.com/passpier/app/pull/7' }),
  FAKE_GH_MAIN: over.main ?? MAIN_1,
  FAKE_GH_MERGED: JSON.stringify({ mergeCommit: { oid: MAIN_2 } }),
  FAKE_GH_PARENT: over.parent ?? MAIN_1,
});

const merges = (calls: string[]) => calls.filter((c) => c.startsWith('gh pr merge'));

describe('rnship merge approve', () => {
  it('on first use, merges only with --accept-main at the current base head, then records the merge commit', () => {
    const s = sandbox();
    const first = s.rnship(['merge', 'approve', SHA, '--pr', '7'], gh());
    expect(first.code).toBe(1);
    expect(first.stderr).toContain(`--accept-main ${MAIN_1}`);
    expect(merges(s.calls())).toEqual([]);

    const run = s.rnship(['merge', 'approve', SHA, '--pr', '7', '--accept-main', MAIN_1], gh());
    expect(run.code).toBe(0);
    expect(s.calls()).toContain(`gh pr merge 7 --merge --match-head-commit ${SHA}`);
    expect(JSON.parse(readFileSync(join(s.root, 'state', LEDGER), 'utf8'))).toMatchObject({ repo: 'passpier/app', base: 'main', sha: MAIN_2 });
  });

  it('merges the next PR without --accept-main when the base is still where the last merge left it', () => {
    const s = sandbox();
    expect(s.rnship(['merge', 'approve', SHA, '--pr', '7', '--accept-main', MAIN_1], gh()).code).toBe(0);
    const next = 'c'.repeat(40);
    const run = s.rnship(['merge', 'approve', next, '--pr', '8'], gh({ head: next, main: MAIN_2, parent: MAIN_2 }));
    expect(run.code).toBe(0);
    expect(merges(s.calls())).toHaveLength(2);
  });

  it('refuses when the base moved since the last merge approve, naming both SHAs', () => {
    const s = sandbox();
    expect(s.rnship(['merge', 'approve', SHA, '--pr', '7', '--accept-main', MAIN_1], gh()).code).toBe(0);
    const moved = 'd'.repeat(40);
    const next = 'c'.repeat(40);
    const run = s.rnship(['merge', 'approve', next, '--pr', '8'], gh({ head: next, main: moved }));
    expect(run.code).toBe(1);
    expect(run.stderr).toContain(`moved from ${MAIN_2} to ${moved}`);
    expect(run.stderr).toContain(`compare/${MAIN_2}...${moved}`);
    expect(merges(s.calls())).toHaveLength(1);
  });

  it('refuses --accept-main that is not the current base head', () => {
    const s = sandbox();
    const run = s.rnship(['merge', 'approve', SHA, '--pr', '7', '--accept-main', MAIN_2], gh());
    expect(run.code).toBe(1);
    expect(run.stderr).toContain(`isn't the current main head ${MAIN_1}`);
    expect(merges(s.calls())).toEqual([]);
  });

  it('ignores a ledger entry that is writable by others or names another user', () => {
    const s = sandbox();
    expect(s.rnship(['merge', 'approve', SHA, '--pr', '7', '--accept-main', MAIN_1], gh()).code).toBe(0);
    const ledger = join(s.root, 'state', LEDGER);
    const next = 'c'.repeat(40);
    const env = gh({ head: next, main: MAIN_2, parent: MAIN_2 });

    chmodSync(ledger, 0o666);
    expect(s.rnship(['merge', 'approve', next, '--pr', '8'], env).stderr).toContain('writable by group or others');
    chmodSync(ledger, 0o644);
    const record = JSON.parse(readFileSync(ledger, 'utf8'));
    writeFileSync(ledger, JSON.stringify({ ...record, recorded_by: { uid: record.recorded_by.uid + 1, user: 'someone' } }));
    expect(s.rnship(['merge', 'approve', next, '--pr', '8'], env).stderr).toContain("isn't owned by the user it names");
    expect(merges(s.calls())).toHaveLength(1);
  });

  it("doesn't record the merge commit when its parent isn't the checked base head", () => {
    const s = sandbox();
    const run = s.rnship(['merge', 'approve', SHA, '--pr', '7', '--accept-main', MAIN_1], gh({ parent: 'e'.repeat(40) }));
    expect(run.code).toBe(0);
    expect(run.stderr).toContain('was not recorded');
    expect(existsSync(join(s.root, 'state', LEDGER))).toBe(false);
  });

  it('refuses when the PR head moved past the approved SHA', () => {
    const s = sandbox();
    const run = s.rnship(['merge', 'approve', SHA, '--pr', '7', '--accept-main', MAIN_1], gh({ head: 'b'.repeat(40) }));

    expect(run.code).toBe(1);
    expect(run.stderr).toContain('not ' + SHA);
    expect(merges(s.calls())).toEqual([]);
  });

  it('refuses to run as the agent user, before calling gh', () => {
    const s = sandbox();
    const run = s.rnship(['merge', 'approve', SHA, '--pr', '7', '--accept-main', MAIN_1], { ...asAgent, ...gh() });

    expect(run.code).toBe(1);
    expect(run.stderr).toContain('agent user');
    expect(s.calls()).toEqual([]);
  });

  it('is single-use', () => {
    const s = sandbox();
    expect(s.rnship(['merge', 'approve', SHA, '--pr', '7', '--accept-main', MAIN_1], gh()).code).toBe(0);
    const again = s.rnship(['merge', 'approve', SHA, '--pr', '7'], gh({ main: MAIN_2, parent: MAIN_2 }));
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

  it('rollout moves a group to a new percentage, once per step', () => {
    const s = sandbox();
    const env = { FAKE_EAS_UPDATE: updates(s.head, { branch: 'production' }) };
    expect(s.rnship(['release', 'approve', 'rollout', 'group-1', '--percent', '25'], env).code).toBe(0);
    expect(s.calls()).toContain('eas update:edit group-1 --rollout-percentage 25 --non-interactive');
    expect(s.rnship(['release', 'approve', 'rollout', 'group-1', '--percent', '25'], env).code).toBe(1);
    expect(s.rnship(['release', 'approve', 'rollout', 'group-1', '--percent', '50'], env).code).toBe(0);
    expect(s.rnship(['release', 'approve', 'rollout', 'group-1', '--percent', '101'], env).code).toBe(1);
  });

  it('rollback reverts a rollout, or points the channel back at the embedded update', () => {
    const s = sandbox();
    // The group's own release approval doesn't block its rollback.
    expect(s.rnship(['release', 'approve', 'update', 'group-1'], { FAKE_EAS_UPDATE: updates(s.head) }).code).toBe(0);
    expect(s.rnship(['release', 'approve', 'rollback', 'group-1'], { FAKE_EAS_UPDATE: updates(s.head) }).code).toBe(0);
    expect(s.calls()).toContainEqual(expect.stringMatching(/^eas update:revert-update-rollout --group group-1 --message .* --non-interactive$/));

    const drill = s.rnship(['release', 'approve', 'rollback', 'group-2', '--to-embedded', '--channel', 'staging'], { FAKE_EAS_UPDATE: updates(s.head, { group: 'group-2' }) });
    expect(drill.code).toBe(0);
    expect(s.calls()).toContainEqual(expect.stringMatching(/^eas update:roll-back-to-embedded --channel staging --runtime-version 1 --message .* --force-end-active-rollout --non-interactive$/));
  });

  it('rollback refuses a group that spans runtimes, and --channel without --to-embedded', () => {
    const s = sandbox();
    const mixed = JSON.stringify([
      { group: 'group-1', branch: 'production', platform: 'ios', runtimeVersion: '1' },
      { group: 'group-1', branch: 'production', platform: 'android', runtimeVersion: '2' },
    ]);
    expect(s.rnship(['release', 'approve', 'rollback', 'group-1', '--to-embedded'], { FAKE_EAS_UPDATE: mixed }).code).toBe(1);
    expect(s.rnship(['release', 'approve', 'rollback', 'group-1', '--channel', 'staging'], { FAKE_EAS_UPDATE: updates(s.head) }).code).toBe(1);
    expect(s.calls().some((c) => /^eas update:(revert|roll-back)/.test(c))).toBe(false);
  });

  it('refuses an eas-cli other than the checked minor, before any other eas call', () => {
    const s = sandbox();
    const run = s.rnship(['release', 'approve', 'submit', 'build-1'], { FAKE_EAS_BUILD: build(), FAKE_EAS_VERSION: '25.0.1' });

    expect(run.code).toBe(1);
    expect(run.stderr).toContain('eas-cli 25.0.1 isn\'t 24.13.x');
    expect(s.calls()).toEqual(['eas --version']);
    expect(s.rnship(['release', 'approve', 'submit', 'build-1'], { FAKE_EAS_BUILD: build(), FAKE_EAS_VERSION: '24.13.7' }).code).toBe(0);
  });

  it('refuses every release action as the agent user', () => {
    const s = sandbox();
    expect(s.rnship(['release', 'approve', 'build', s.head, '--platform', 'ios'], asAgent).code).toBe(1);
    expect(s.rnship(['release', 'approve', 'submit', 'build-1'], { ...asAgent, FAKE_EAS_BUILD: build() }).code).toBe(1);
    expect(s.rnship(['release', 'approve', 'update', 'group-1'], { ...asAgent, FAKE_EAS_UPDATE: updates(s.head) }).code).toBe(1);
    expect(s.rnship(['release', 'approve', 'rollout', 'group-1', '--percent', '25'], { ...asAgent, FAKE_EAS_UPDATE: updates(s.head) }).code).toBe(1);
    expect(s.rnship(['release', 'approve', 'rollback', 'group-1'], { ...asAgent, FAKE_EAS_UPDATE: updates(s.head) }).code).toBe(1);
    expect(s.calls()).toEqual([]);
  });
});
