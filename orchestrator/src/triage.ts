import type { SentryEvent, SentryIssue } from './sentry.ts';
import type { Signal } from './signals.ts';

// B2 triage (design §2): turns a Sentry issue and its latest event into `triage.json`.
// Structured fields only. Every value is checked against a strict pattern or the repo's
// own file list, and anything that fails is dropped, so no free text from an event (the
// message, breadcrumbs, tags, user context) can reach a task prompt. Nothing else from
// the event is kept, which is also the PII scrub: there is nothing left to scrub.

export const LEVELS = ['fatal', 'error', 'warning', 'info', 'debug'] as const;
export type Level = (typeof LEVELS)[number];

export type SuspectFrame = { path: string; line?: number; fn?: string };

export type Triage = {
  version: 1;
  signal: Required<Pick<Signal, 'source' | 'issue_id' | 'runtime_version'>> & Pick<Signal, 'update_id' | 'release'>;
  level: Level;
  error_class: string;
  counts: { events: number; users: number };
  suspect_files: SuspectFrame[];
  action: 'fix' | 'ignore' | 'rollback';
};

export type TriageOptions = {
  /** Every tracked file at the commit the release was built from (`git ls-tree -r --name-only`). */
  repoFiles: string[];
  /** Below either count the issue is ignored. */
  minEvents?: number;
  minUsers?: number;
  /** Updates currently rolling out. A fatal crash on one of them asks you for a rollback. */
  rollingOut?: string[];
};

export class TriageError extends Error {}

const IDENT = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
const RUNTIME = /^[\w.-]{1,128}$/;
const UPDATE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RELEASE = /^[\w.@+-]{1,200}$/;
const MAX_FRAMES = 5;

const pick = <T>(value: unknown, test: (v: string) => boolean, fallback: T): string | T =>
  typeof value === 'string' && test(value) ? value : fallback;

const count = (value: unknown): number => {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : 0;
};

/**
 * A frame's file as a repo path: the longest tracked file the frame path ends with, on a
 * `/` boundary. Symbolicated paths are absolute build paths (`/home/runner/work/…/src/a.ts`)
 * or `app:///src/a.ts`, so a suffix match against the repo is what ties them to a file.
 */
export function repoPath(framePath: string, files: Set<string>): string | undefined {
  const path = framePath.replace(/^[a-z]+:\/\/\/?/i, '/').replace(/\\/g, '/');
  if (path.split('/').includes('..') || path.includes('node_modules/')) return undefined;
  const parts = path.split('/').filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const candidate = parts.slice(i).join('/');
    if (files.has(candidate)) return candidate;
  }
  return undefined;
}

/** In-app frames that resolve to repo files, innermost (the throwing frame) first. */
export function suspectFrames(event: SentryEvent, files: Set<string>): SuspectFrame[] {
  const out: SuspectFrame[] = [];
  const seen = new Set<string>();
  const exceptions = (event.entries ?? []).filter((e) => e.type === 'exception').flatMap((e) => e.data?.values ?? []);
  // Sentry lists chained exceptions and frames oldest first; the last frame of the last value threw.
  for (const value of [...exceptions].reverse()) {
    for (const frame of [...(value.stacktrace?.frames ?? [])].reverse()) {
      if (!frame.inApp) continue;
      const path = [frame.filename, frame.absPath].map((p) => (typeof p === 'string' ? repoPath(p, files) : undefined)).find(Boolean);
      if (!path) continue;
      const line = count(frame.lineNo) || undefined;
      const fn = pick(frame.function, (v) => v.length <= 80 && IDENT.test(v), undefined);
      const key = `${path}:${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ path, ...(line ? { line } : {}), ...(fn ? { fn } : {}) });
      if (out.length === MAX_FRAMES) return out;
    }
  }
  return out;
}

export function triage(issue: SentryIssue, event: SentryEvent, opts: TriageOptions): Triage {
  if (!/^\d+$/.test(issue.id)) throw new TriageError(`not a Sentry issue id: ${String(issue.id).slice(0, 40)}`);
  const ota = event.contexts?.ota_updates ?? {};
  const runtime = pick(ota.runtime_version, (v) => RUNTIME.test(v), undefined);
  if (!runtime) throw new TriageError(`issue ${issue.id}: the event has no valid runtime version; you take over`);
  const updateId = pick(ota.update_id, (v) => UPDATE_ID.test(v), undefined);
  const releaseName = typeof event.release === 'string' ? event.release : event.release?.version;
  const release = pick(releaseName, (v) => RELEASE.test(v), undefined);

  const level = pick(issue.level, (v) => (LEVELS as readonly string[]).includes(v), 'error') as Level;
  const errorClass = pick(issue.metadata?.type, (v) => v.length <= 80 && IDENT.test(v), 'UnknownError');
  const counts = { events: count(issue.count), users: count(issue.userCount) };
  const suspects = suspectFrames(event, new Set(opts.repoFiles));

  const base = {
    version: 1 as const,
    signal: { source: 'sentry', issue_id: issue.id, runtime_version: runtime, ...(updateId ? { update_id: updateId } : {}), ...(release ? { release } : {}) },
    level,
    error_class: errorClass,
    counts,
    suspect_files: suspects,
  };
  if (counts.events < (opts.minEvents ?? 1) || counts.users < (opts.minUsers ?? 1)) return { ...base, action: 'ignore' };
  if (level === 'fatal' && updateId && opts.rollingOut?.includes(updateId)) return { ...base, action: 'rollback' };
  if (suspects.length === 0) throw new TriageError(`issue ${issue.id}: no in-app frame resolves to a repo file; you take over`);
  return { ...base, action: 'fix' };
}

/** The task text for a `fix` triage. Built only from the validated fields above. */
export function triageTaskBody(t: Triage): string {
  const lines = [
    `Signal: source=${t.signal.source} issue_id=${t.signal.issue_id} runtime_version=${t.signal.runtime_version}`,
    ...(t.signal.update_id ? [`Update: ${t.signal.update_id}`] : []),
    ...(t.signal.release ? [`Release: ${t.signal.release}`] : []),
    `Error: ${t.error_class} (${t.level}), ${t.counts.events} events, ${t.counts.users} users`,
    'Suspect frames, innermost first:',
    ...t.suspect_files.map((f) => `- ${f.path}${f.line ? `:${f.line}` : ''}${f.fn ? ` in ${f.fn}` : ''}`),
    '',
    'Find and fix the cause of this crash in the suspect files. Add a test that reproduces it when the code allows.',
  ];
  return lines.join('\n');
}
