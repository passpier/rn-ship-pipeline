import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertHumanUser, untrustedReason } from './approvals.ts';

// The main-head ledger: the base-branch SHA that the last `rnship merge approve` left
// behind, per repo and branch. On Free private repos nothing server-side stops the
// broker's App token from pushing to main (S0 G4), so the next merge approve refuses
// if main moved since then, until you inspect the change and vouch for it.

type Env = Record<string, string | undefined>;

export type MainHeadRecord = {
  repo: string;
  base: string;
  sha: string;
  recorded_by: { uid: number; user: string };
  recorded_at: string;
};

export type MainHeadLookup = { ok: true; record: MainHeadRecord } | { ok: false; reason: string };

export function mainHeadPath(dir: string, repo: string, base: string): string {
  return join(dir, 'main-heads', `${`${repo}_${base}`.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
}

export function readMainHead(dir: string, repo: string, base: string, env: Env = process.env): MainHeadLookup {
  const path = mainHeadPath(dir, repo, base);
  if (!existsSync(path)) return { ok: false, reason: `no recorded ${base} head for ${repo}` };
  let record: MainHeadRecord;
  try {
    record = JSON.parse(readFileSync(path, 'utf8')) as MainHeadRecord;
  } catch {
    return { ok: false, reason: `${path} is not valid JSON` };
  }
  if (record.repo !== repo || record.base !== base) return { ok: false, reason: `${path} doesn't match ${repo} ${base}` };
  const untrusted = untrustedReason(path, record.recorded_by, env);
  if (untrusted) return { ok: false, reason: untrusted };
  return { ok: true, record };
}

/** Replaces the ledger entry atomically: write a fresh file you own, then rename it over the old one. */
export function writeMainHead(dir: string, head: { repo: string; base: string; sha: string }, env: Env = process.env): string {
  const recordedBy = assertHumanUser(env);
  const path = mainHeadPath(dir, head.repo, head.base);
  mkdirSync(join(dir, 'main-heads'), { recursive: true, mode: 0o755 });
  const record: MainHeadRecord = { ...head, recorded_by: recordedBy, recorded_at: new Date().toISOString() };
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', { mode: 0o644, flag: 'wx' });
  renameSync(tmp, path);
  return path;
}
