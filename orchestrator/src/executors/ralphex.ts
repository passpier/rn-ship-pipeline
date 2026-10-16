import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelSpec } from '@rnship/policy';
import type { ExecRequest, ExecResult, Executor, ProbeResult } from '../executor.ts';
import { claudeArgs, limitPatterns, probeQuota, readTranscripts, SHIM, spawnSession, timedOut, type SessionOptions } from './claudeSession.ts';
import { completedTaskNumbers, renderPlan } from './ralphexPlan.ts';
import { limitKindOf, MODEL_MISMATCH, PLUGIN_MISSING, CLAUDE_ERROR_PATTERNS, type StreamSummary } from '../streamJson.ts';

// The ralphex adapter (pinned to v1.7.0; facts in docs/spikes/S8.md). Each run gets its
// own config dir, so the app repo's `.ralphex/` never configures it, and the orchestrator
// keeps the retries (task_retry_count = 0, no --wait). claude_command is our shim, which
// fails closed on a missing guard plugin or a substituted model, and keeps the transcripts
// ralphex doesn't parse.

export type RalphexOptions = SessionOptions & {
  /** The ralphex binary. */
  ralphex: string;
  maxIterations?: number;
  /** The orchestrator runs the review pass only when this is true. */
  review?: boolean;
};

/** ralphex splits args on spaces with quote grouping (S8 X5): quote paths, refuse what can't be quoted. */
export function ralphexArg(value: string): string {
  if (/['"\\\n\t]/.test(value)) throw new Error(`can't pass ${JSON.stringify(value)} through ralphex claude_args`);
  return value.includes(' ') ? `'${value}'` : value;
}

const modelSpec = (model: ModelSpec) => (model.effort ? `${model.id}:${model.effort}` : model.id);

export class RalphexExecutor implements Executor {
  readonly id = 'ralphex' as const;
  private readonly opts: RalphexOptions;

  constructor(opts: RalphexOptions) {
    this.opts = opts;
  }

  capabilities() {
    return { review: this.opts.review ?? false };
  }

  /**
   * The run's ralphex config. Claude ticks the plan's checkboxes, and the plan lives outside
   * the worktree, where dontAsk denies everything: so the session may read and edit that one
   * file. Not its directory, which holds this config and its claude_command.
   */
  config(plan: string): string {
    const errorPatterns = [...new Set([...CLAUDE_ERROR_PATTERNS, ...(this.opts.extraLimitPatterns ?? []), PLUGIN_MISSING, MODEL_MISMATCH])];
    const planTools = `Read(/${plan}),Edit(/${plan})`; // `//path` is an absolute path in a permission rule
    return [
      `claude_command = ${SHIM}`,
      `claude_args = ${[...claudeArgs(this.opts), '--allowedTools', planTools].map(ralphexArg).join(' ')}`,
      `claude_limit_patterns = ${limitPatterns(this.opts).join(',')}`,
      `claude_error_patterns = ${errorPatterns.join(',')}`,
      'task_retry_count = 0',
      'move_plan_on_completion = false',
      'external_review_tool = none',
      'codex_enabled = false',
      'iteration_delay_ms = 0',
      '',
    ].join('\n');
  }

  async run(req: ExecRequest, signal: AbortSignal): Promise<ExecResult> {
    mkdirSync(this.opts.workDir, { recursive: true });
    const dir = mkdtempSync(join(this.opts.workDir, `run-${req.tasks[0]!.id}-`));
    const configDir = join(dir, 'config');
    const transcripts = join(dir, 'transcripts');
    const stem = `rnship-${req.tasks.map((t) => t.id).join('-')}-a${req.attempt}${req.phase === 'review' ? '-review' : ''}`;
    const plan = join(dir, `${stem}.md`);
    mkdirSync(configDir);
    writeFileSync(join(configDir, 'config'), this.config(plan));
    writeFileSync(plan, renderPlan(req));

    const phaseArgs =
      req.phase === 'review'
        ? ['--review', '--review-model', modelSpec(req.model), '--base-ref', req.baseSha]
        : ['--tasks-only', '--task-model', modelSpec(req.model)];
    const args = [
      '--config-dir',
      configDir,
      '--no-color',
      ...phaseArgs,
      '--max-iterations',
      String(this.opts.maxIterations ?? Math.max(5, req.tasks.length * 3)),
      '--session-timeout',
      `${req.timeoutSec}s`,
      '--idle-timeout',
      `${req.idleTimeoutSec}s`,
      plan,
    ];
    const run = await spawnSession(this.opts, this.opts.ralphex, args, { cwd: req.worktree, transcripts, signal });
    writeFileSync(join(dir, 'ralphex.log'), run.output);

    const summary = readTranscripts(transcripts);
    const progress = readProgress(req.worktree, stem);
    const completed = req.phase === 'review' ? [] : completedTaskNumbers(readFileSync(plan, 'utf8')).map((n) => req.tasks[n - 1]?.id);
    const result = classify({
      exitCode: run.code,
      aborted: run.aborted,
      timedOut: timedOut(signal),
      output: run.output,
      footer: progress.footer,
      summary,
      limitPatterns: limitPatterns(this.opts),
    });
    return {
      ...result,
      completedTaskIds:
        result.reason === 'plugin_missing' || result.reason === 'model_mismatch'
          ? []
          : result.status === 'passed' && req.phase === 'review'
            ? req.tasks.map((t) => t.id)
            : completed.filter((id) => id !== undefined),
      deniedToolCalls: summary.permissionDenials,
      usage: summary.usage,
      modelId: summary.init?.model,
      transcriptPath: transcripts,
      failureDigest: result.status === 'passed' ? undefined : (result.failureDigest ?? progress.tail),
    };
  }

  probe(model: ModelSpec): Promise<ProbeResult> {
    return probeQuota(this.opts, model);
  }
}

function readProgress(worktree: string, stem: string): { footer?: string; tail: string } {
  const dir = join(worktree, '.ralphex', 'progress');
  const file = existsSync(dir) ? readdirSync(dir).find((f) => f.startsWith(`progress-${stem}`)) : undefined;
  if (!file) return { tail: '' };
  const lines = readFileSync(join(dir, file), 'utf8').trimEnd().split('\n');
  const footer = lines.findLast((l) => /^(Completed|Failed): /.test(l));
  return { footer, tail: lines.slice(-20).join('\n').slice(-2000) };
}

export type Classified = Pick<ExecResult, 'status' | 'resetAt' | 'limitKind' | 'reason' | 'failureDigest'>;

/** Maps a finished ralphex run to an ExecResult status (S8 X1-X2: the exit code alone can't). */
export function classify(input: {
  exitCode: number;
  aborted: boolean;
  timedOut: boolean;
  output: string;
  footer?: string;
  summary: StreamSummary;
  limitPatterns: string[];
}): Classified {
  const errorLine = input.output.split('\n').findLast((l) => l.startsWith('error: '));
  const reason = errorLine ?? input.footer;
  if (input.aborted) return { status: input.timedOut ? 'timeout' : 'crashed', reason: 'aborted' };
  if (input.output.includes(PLUGIN_MISSING)) return { status: 'crashed', reason: 'plugin_missing', failureDigest: lineWith(input.output, PLUGIN_MISSING) };
  if (input.output.includes(MODEL_MISMATCH)) return { status: 'crashed', reason: 'model_mismatch', failureDigest: lineWith(input.output, MODEL_MISMATCH) };

  const limit = /detected limit pattern: "([^"]*)"/.exec(input.output)?.[1];
  if (limit !== undefined || input.summary.rateLimit) {
    const kind = input.summary.rateLimit?.kind !== 'unknown' && input.summary.rateLimit ? input.summary.rateLimit.kind : limitKindOf(limit ?? '');
    return { status: 'quota_exhausted', limitKind: kind, resetAt: input.summary.rateLimit?.resetAt, reason };
  }

  if (input.exitCode === 0 && input.footer?.startsWith('Completed:')) return { status: 'passed' };
  if (/FAILED signal received|max iterations \(\d+\) reached/.test(input.output)) return { status: 'validation_failed', reason };
  const errorPattern = /detected error pattern: "([^"]*)"/.exec(input.output)?.[1];
  if (errorPattern && /API Error: (5\d\d)/.test(errorPattern)) return { status: 'infra', reason };
  return { status: 'crashed', reason: reason ?? `ralphex exited ${input.exitCode}` };
}

function lineWith(text: string, needle: string): string {
  return text.split('\n').find((l) => l.includes(needle)) ?? needle;
}
