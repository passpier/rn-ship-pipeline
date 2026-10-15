import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApprovalError, baselineDigest, findApproval, parseBaseline, writeApproval } from '../src/index.ts';

const dir = () => mkdtempSync(join(tmpdir(), 'rnship-approvals-'));
const asAgent = { RNSHIP_AGENT_USER: userInfo().username };

describe('approval records', () => {
  it('round-trips a record written by a human user', () => {
    const state = dir();
    writeApproval(state, { kind: 'baseline', digest: 'sha256:abc', subject: '.rnship/approved-baseline.yaml' }, {});

    const found = findApproval(state, 'baseline', 'sha256:abc', {});

    expect(found).toMatchObject({ ok: true, record: { kind: 'baseline', approved_by: { user: userInfo().username } } });
    expect(findApproval(state, 'baseline', 'sha256:other', {})).toMatchObject({ ok: false });
  });

  it('refuses to write an approval as the agent user', () => {
    expect(() => writeApproval(dir(), { kind: 'merge', digest: 'abc', subject: 'PR 1' }, asAgent)).toThrow(ApprovalError);
  });

  it('is single-use', () => {
    const state = dir();
    writeApproval(state, { kind: 'release', digest: 'build-1', subject: 'submit' }, {});
    expect(() => writeApproval(state, { kind: 'release', digest: 'build-1', subject: 'submit' }, {})).toThrow(/single-use/);
  });

  it('rejects a record that names another user, or that others can write', () => {
    const state = dir();
    const path = writeApproval(state, { kind: 'baseline', digest: 'd1', subject: 'x' }, {});
    const record = JSON.parse(readFileSync(path, 'utf8'));

    writeFileSync(path, JSON.stringify({ ...record, approved_by: { uid: record.approved_by.uid + 1, user: 'someone' } }));
    expect(findApproval(state, 'baseline', 'd1', {})).toMatchObject({ ok: false, reason: expect.stringContaining('owned') });

    writeFileSync(path, JSON.stringify(record));
    chmodSync(path, 0o666);
    expect(findApproval(state, 'baseline', 'd1', {})).toMatchObject({ ok: false, reason: expect.stringContaining('writable') });
  });

  it('rejects a record when its owner is the agent user', () => {
    const state = dir();
    writeApproval(state, { kind: 'baseline', digest: 'd2', subject: 'x' }, {});
    expect(findApproval(state, 'baseline', 'd2', asAgent)).toMatchObject({ ok: false, reason: expect.stringContaining('agent') });
  });
});

describe('baseline digest', () => {
  it('ignores formatting and key order', () => {
    const a = parseBaseline('version: 1\ndependencies:\n  expo: "~57.0.0"\n  react: "19.2.0"\n');
    const b = parseBaseline('version: 1\ndependencies: { react: "19.2.0", expo: "~57.0.0" }\nconfig: {}\n');
    expect(baselineDigest(a)).toBe(baselineDigest(b));
    expect(baselineDigest(a)).not.toBe(baselineDigest(parseBaseline('version: 1\ndependencies: { expo: "~57.0.1" }\n')));
  });
});
