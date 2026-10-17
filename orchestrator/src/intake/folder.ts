import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { canonicalJson, sha256 } from '@rnship/release';
import { parse } from 'yaml';
import {
  BaselineDeltaSchema,
  ChangeRequestSchema,
  ImpactSchema,
  ScreensSchema,
  type BaselineDelta,
  type ChangeRequest,
  type Impact,
  type Screens,
} from './schema.ts';

// The change folder on disk, its digest, and A1's deterministic checks.

export const FILES = {
  request: 'change-request.yaml',
  impact: 'impact.json',
  delta: 'baseline-delta.yaml',
  screens: 'screens.yaml',
  /** A5's output: tasks.yaml and smoke/*.yaml. Not part of the scope digest. */
  tasksDir: 'tasks',
} as const;

/** The files `rnship change approve` binds to, in a fixed order. design.md is optional. */
const SCOPE_FILES = [FILES.request, FILES.impact, FILES.delta, FILES.screens, 'design.md'];

export class IntakeError extends Error {}

export function loadRequest(dir: string): ChangeRequest {
  const path = join(dir, FILES.request);
  if (!existsSync(path)) throw new IntakeError(`${path} is missing`);
  const parsed = ChangeRequestSchema.safeParse(parse(readFileSync(path, 'utf8')));
  if (!parsed.success) throw new IntakeError(`${path}: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`);
  return parsed.data;
}

export function loadImpact(dir: string): Impact | undefined {
  const path = join(dir, FILES.impact);
  return existsSync(path) ? ImpactSchema.parse(JSON.parse(readFileSync(path, 'utf8'))) : undefined;
}

export function loadDelta(dir: string): BaselineDelta | undefined {
  const path = join(dir, FILES.delta);
  return existsSync(path) ? BaselineDeltaSchema.parse(parse(readFileSync(path, 'utf8'))) : undefined;
}

export function loadScreens(dir: string): Screens | undefined {
  const path = join(dir, FILES.screens);
  return existsSync(path) ? ScreensSchema.parse(parse(readFileSync(path, 'utf8'))) : undefined;
}

/**
 * Digest of the change's scope: the bytes of each scope file present, plus any ADRs under
 * adr/. Any edit, even whitespace, gives a new digest, which invalidates an approval of the
 * old one (design §2 A4b).
 */
export function changeDigest(dir: string): string {
  const parts: Record<string, string> = {};
  for (const name of SCOPE_FILES) {
    const path = join(dir, name);
    if (existsSync(path)) parts[name] = fileHash(path);
  }
  const adrs = join(dir, 'adr');
  if (existsSync(adrs)) for (const name of readdirSync(adrs).sort()) parts[`adr/${name}`] = fileHash(join(adrs, name));
  if (!parts[FILES.request]) throw new IntakeError(`${join(dir, FILES.request)} is missing`);
  return sha256(canonicalJson(parts));
}

function fileHash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Has intake run on this request as it is now? impact.json and screens.yaml exist (or the change was stopped). */
export function intakeDone(dir: string): boolean {
  const impact = loadImpact(dir);
  return impact !== undefined && (impact.verdict === 'stop' || existsSync(join(dir, FILES.screens)));
}

// --- A1 checks ------------------------------------------------------------------

const MIN_COPIED = 24;

const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * A1: the request passes its schema (loadRequest), every AC id is unique, each research
 * file exists inside the repo with the recorded hash, and no free-text field carries a
 * line of a research file (the research source is unknown, so it's untrusted).
 */
export function checkRequest(request: ChangeRequest, repo: string): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const ac of request.acceptance_criteria) {
    if (ids.has(ac.id)) problems.push(`acceptance criterion ${ac.id} is listed twice`);
    ids.add(ac.id);
  }
  const freeText = normalize(
    [request.goal, ...request.areas, ...request.acceptance_criteria.flatMap((ac) => [ac.given ?? '', ac.when, ac.then])].join('\n'),
  );
  const root = resolve(repo);
  for (const ref of request.research) {
    const path = resolve(root, ref.path);
    if (!path.startsWith(root + sep)) {
      problems.push(`research ${ref.path} is outside the repo`);
      continue;
    }
    if (!existsSync(path)) {
      problems.push(`research ${ref.path} doesn't exist`);
      continue;
    }
    if (fileHash(path) !== ref.sha256) problems.push(`research ${ref.path} doesn't match its recorded sha256`);
    const copied = researchLines(readFileSync(path, 'utf8')).find((line) => freeText.includes(line));
    if (copied) problems.push(`the request copies text from research ${ref.path}: "${copied.slice(0, 60)}…"; write it in your own words`);
  }
  return problems;
}

/** The research file's lines and sentences long enough to count as copied. */
export function researchLines(text: string): string[] {
  return text
    .split(/[\n.!?]/)
    .map(normalize)
    .filter((line) => line.length >= MIN_COPIED);
}
