import { canonicalJson, sha256 } from '@rnship/release';
import type { Db } from './db.ts';

// Stage dedup (design §4): a stage whose input artifacts haven't changed is skipped and
// its recorded output reused, which makes resuming cheap.

export function stageKey(stage: string, inputs: Record<string, string>): string {
  return sha256(canonicalJson({ stage, inputs }));
}

export async function runStage(
  db: Db,
  stage: string,
  inputs: Record<string, string>,
  fn: () => Promise<string>,
  now: () => Date = () => new Date(),
): Promise<{ output: string; cached: boolean }> {
  const key = stageKey(stage, inputs);
  const hit = db.prepare('SELECT output FROM stage_cache WHERE key = ?').get(key) as { output: string } | undefined;
  if (hit) return { output: hit.output, cached: true };
  const output = await fn();
  db.prepare('INSERT OR REPLACE INTO stage_cache (key, stage, output, at) VALUES (?, ?, ?, ?)').run(key, stage, output, now().toISOString());
  return { output, cached: false };
}
