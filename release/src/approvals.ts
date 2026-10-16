import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';

// Approval records live in a shared state dir that only your user writes
// (`.rnship/state/approvals/`, group-readable by rnship-agent). A record counts only
// if the file is owned by the user it names, that user isn't the agent, and nobody
// else can write it.

export type ApprovalKind = 'baseline' | 'merge' | 'release' | 'change' | 'task';

export type ApprovalRecord = {
  kind: ApprovalKind;
  digest: string;
  subject: string;
  approved_by: { uid: number; user: string };
  approved_at: string;
};

export class ApprovalError extends Error {}

type Env = Record<string, string | undefined>;

export function agentUser(env: Env = process.env): string {
  return env.RNSHIP_AGENT_USER || 'rnship-agent';
}

export function stateDir(projectRoot: string, env: Env = process.env): string {
  return env.RNSHIP_STATE_DIR || join(projectRoot, '.rnship', 'state');
}

/** Approving is a human act: refuse to run as the agent user. */
export function assertHumanUser(env: Env = process.env): { uid: number; user: string } {
  const me = userInfo();
  if (me.username === agentUser(env)) {
    throw new ApprovalError(`refusing to approve as ${me.username}: approvals must be run by a human, never by the agent user`);
  }
  return { uid: me.uid, user: me.username };
}

export function approvalPath(dir: string, kind: ApprovalKind, digest: string): string {
  return join(dir, 'approvals', `${kind}-${digest.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
}

export function writeApproval(
  dir: string,
  approval: { kind: ApprovalKind; digest: string; subject: string },
  env: Env = process.env,
): string {
  const approvedBy = assertHumanUser(env);
  const path = approvalPath(dir, approval.kind, approval.digest);
  if (existsSync(path)) throw new ApprovalError(`${approval.kind} ${approval.digest} is already approved (${path}); approvals are single-use`);
  mkdirSync(join(dir, 'approvals'), { recursive: true, mode: 0o755 });
  const record: ApprovalRecord = { ...approval, approved_by: approvedBy, approved_at: new Date().toISOString() };
  writeFileSync(path, JSON.stringify(record, null, 2) + '\n', { mode: 0o644, flag: 'wx' });
  return path;
}

export type ApprovalLookup = { ok: true; record: ApprovalRecord; path: string } | { ok: false; reason: string };

export function findApproval(dir: string, kind: ApprovalKind, digest: string, env: Env = process.env): ApprovalLookup {
  const path = approvalPath(dir, kind, digest);
  if (!existsSync(path)) return { ok: false, reason: `no ${kind} approval for ${digest}` };
  let record: ApprovalRecord;
  try {
    record = JSON.parse(readFileSync(path, 'utf8')) as ApprovalRecord;
  } catch {
    return { ok: false, reason: `${path} is not valid JSON` };
  }
  if (record.kind !== kind || record.digest !== digest) return { ok: false, reason: `${path} doesn't match ${kind} ${digest}` };
  const untrusted = untrustedReason(path, record.approved_by, env);
  if (untrusted) return { ok: false, reason: untrusted };
  return { ok: true, record, path };
}

/**
 * Why a state file written by a human can't be trusted, or undefined if it can: it must be
 * owned by the user it names, that user isn't the agent, and nobody else can write it.
 */
export function untrustedReason(path: string, by: { uid: number; user: string } | undefined, env: Env = process.env): string | undefined {
  const stat = statSync(path);
  if (stat.uid !== by?.uid) return `${path} isn't owned by the user it names`;
  if (by.user === agentUser(env) || stat.uid === uidOf(agentUser(env))) return `${path} was written by the agent user`;
  if ((stat.mode & 0o022) !== 0) return `${path} is writable by group or others`;
  return undefined;
}

function uidOf(user: string): number | undefined {
  const run = spawnSync('id', ['-u', user], { encoding: 'utf8' });
  return run.status === 0 ? Number(run.stdout.trim()) : undefined;
}
