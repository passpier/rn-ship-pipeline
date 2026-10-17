import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelSpec } from '@rnship/policy';
import { z } from 'zod';
import type { Db } from '../db.ts';
import type { LimitKind } from '../executor.ts';
import { claudeArgs, limitIn, limitPatterns, readTranscripts, SHIM, spawnSession, type SessionOptions } from '../executors/claudeSession.ts';
import { classifySession } from '../executors/claudeP.ts';
import { recordUsage } from '../ledger.ts';
import { runStage, stageKey } from '../stages.ts';
import type { Stage } from './prompts.ts';

// One Flow A stage as a single `claude -p --json-schema` call (design §2: "a single LLM
// call stage goes through the same Executor flags"). Same shim, guard plugin, settings
// file and model pin as the executors, but with no tools at all, so the session can only
// answer. The answer is parsed again with zod; a stage whose inputs are unchanged reuses
// its recorded answer (stage cache), so a re-run after a crash or a limit costs nothing.

export class StageError extends Error {
  readonly limit?: { kind: LimitKind; resetAt?: string };
  constructor(message: string, limit?: { kind: LimitKind; resetAt?: string }) {
    super(message);
    this.limit = limit;
  }
}

export type StageRunner = <T>(stage: Stage, prompt: string, schema: z.ZodType<T>) => Promise<T>;

export type StageOptions = SessionOptions & { db: Db; model: ModelSpec; timeoutSec?: number; now?: () => Date };

export function stageArgs(opts: SessionOptions, model: ModelSpec, jsonSchema: unknown): string[] {
  return [
    '--print',
    '--model',
    model.id,
    ...(model.effort ? ['--effort', model.effort] : []),
    '--tools',
    '',
    '--json-schema',
    JSON.stringify(jsonSchema),
    ...claudeArgs(opts),
  ];
}

export function claudeStageRunner(opts: StageOptions): StageRunner {
  const now = opts.now ?? (() => new Date());
  return async <T>(stage: Stage, prompt: string, schema: z.ZodType<T>): Promise<T> => {
    const jsonSchema = z.toJSONSchema(schema, { target: 'draft-7' });
    const inputs = { prompt, model: opts.model.id, schema: JSON.stringify(jsonSchema) };
    const { output } = await runStage(
      opts.db,
      `intake:${stage}`,
      inputs,
      async () => {
        mkdirSync(opts.workDir, { recursive: true });
        const dir = mkdtempSync(join(opts.workDir, `intake-${stage}-`));
        writeFileSync(join(dir, 'prompt.md'), prompt);
        const transcripts = join(dir, 'transcripts');
        const signal = AbortSignal.timeout((opts.timeoutSec ?? 900) * 1000);
        const run = await spawnSession(opts, SHIM, stageArgs(opts, opts.model, jsonSchema), { cwd: dir, transcripts, signal, stdin: prompt, idleTimeoutSec: 300 });
        writeFileSync(join(dir, 'session.log'), run.output);
        const summary = readTranscripts(transcripts);
        recordUsage(opts.db, { modelId: summary.init?.model ?? opts.model.id, usage: summary.usage, detail: { stage: `intake:${stage}` } }, now());
        const failed = classifySession({ run, timedOut: signal.aborted, summary, limitPatterns: limitPatterns(opts), expect: 'done' });
        if (failed?.status === 'quota_exhausted') {
          throw new StageError(`${stage}: Claude limit reached${failed.resetAt ? `, resets ${failed.resetAt}` : ''}`, { kind: failed.limitKind ?? 'unknown', resetAt: failed.resetAt });
        }
        // A stage answers with JSON, not the executor's completion signal: only a failure
        // before the answer counts here.
        if (failed && failed.reason !== 'no completion signal') throw new StageError(`${stage}: ${failed.reason ?? failed.status} (transcript: ${dir})`);
        const value = summary.structuredOutput ?? jsonIn(summary.resultText);
        if (value === undefined) {
          const limit = limitIn(summary.resultText ?? '', limitPatterns(opts));
          throw new StageError(`${stage}: the session returned no JSON (transcript: ${dir})`, limit);
        }
        return JSON.stringify(value);
      },
      now,
    );
    const parsed = schema.safeParse(JSON.parse(output));
    if (!parsed.success) {
      // Don't keep a bad answer in the cache: the next run asks again.
      opts.db.prepare('DELETE FROM stage_cache WHERE key = ?').run(stageKey(`intake:${stage}`, inputs));
      throw new StageError(`${stage}: the answer doesn't match its schema: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    }
    return parsed.data;
  };
}

/** A JSON object in result text: the whole text, or its first fenced block. */
function jsonIn(text: string | undefined): unknown {
  if (!text) return undefined;
  for (const candidate of [text, /```(?:json)?\n([\s\S]*?)\n```/.exec(text)?.[1]]) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate.trim()) as unknown;
    } catch {
      // Try the next one.
    }
  }
  return undefined;
}
