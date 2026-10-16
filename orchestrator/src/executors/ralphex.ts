import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModelSpec } from '@rnship/policy';
import type { ExecRequest, ExecResult, Executor, ProbeResult } from '../executor.ts';
import { completedTaskNumbers, renderPlan } from './ralphexPlan.ts';
import { combine, limitKindOf, matchPattern, PLUGIN_MISSING, CLAUDE_ERROR_PATTERNS, CLAUDE_LIMIT_PATTERNS, summarize, type StreamSummary } from '../streamJson.ts';

// The ralphex adapter (pinned to v1.7.0; facts in docs/spikes/S8.md). Each run gets its
// own config dir, so the app repo's `.ralphex/` never configures it, and the orchestrator
// keeps the retries (task_retry_count = 0, no --wait). claude_command is our shim, which
// fails closed on a missing guard plugin and keeps the transcripts ralphex doesn't parse.

export const SHIM = fileURLToPath(new URL('../../bin/claude-shim.ts', import.meta.url));

/** Claude Code session markers ralphex v1.7.0 strips from claude's env; we strip them from ralphex's. */
const SESSION_ENV = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
];

type Env = Record<string, string | undefined>;

export type RalphexOptions = {
  /** The ralphex binary. */
  ralphex: string;
  /** The real claude command the shim runs. */
  claude?: string;
  /** The guard plugin dir (`plugin/`), always loaded. */
  pluginDir: string;
  /** Optional knowledge plugins, e.g. plugins/rn-game. */
  extraPluginDirs?: string[];
  /** The compiled executor-settings.json (ADR 0002: a file, never inline JSON). */
  settingsFile: string;
  guardPlugin?: string;
  /** Per-run config dirs, plans and transcripts go here. */
  workDir: string;
  /** Limit patterns beyond ralphex's defaults (from S4). */
  extraLimitPatterns?: string[];
  maxIterations?: number;
  /** The orchestrator runs the review pass only when this is true. */
  review?: boolean;
  env?: Env;
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

  /** Flags every Claude session gets, in ralphex's claude_args and in the probe. */
  claudeArgs(): string[] {
    return [
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'dontAsk',
      '--plugin-dir',
      this.opts.pluginDir,
      ...(this.opts.extraPluginDirs ?? []).flatMap((dir) => ['--plugin-dir', dir]),
      '--settings',
      this.opts.settingsFile,
      '--setting-sources',
      'user',
    ];
  }

  limitPatterns(): string[] {
    return [...CLAUDE_LIMIT_PATTERNS, ...(this.opts.extraLimitPatterns ?? [])];
  }

  config(): string {
    const errorPatterns = [...new Set([...CLAUDE_ERROR_PATTERNS, ...(this.opts.extraLimitPatterns ?? []), PLUGIN_MISSING])];
    return [
      `claude_command = ${SHIM}`,
      `claude_args = ${this.claudeArgs().map(ralphexArg).join(' ')}`,
      `claude_limit_patterns = ${this.limitPatterns().join(',')}`,
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
    writeFileSync(join(configDir, 'config'), this.config());
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
    const run = await this.spawn(this.opts.ralphex, args, req.worktree, transcripts, signal);
    writeFileSync(join(dir, 'ralphex.log'), run.output);

    const summary = readTranscripts(transcripts);
    const progress = readProgress(req.worktree, stem);
    const completed = req.phase === 'review' ? [] : completedTaskNumbers(readFileSync(plan, 'utf8')).map((n) => req.tasks[n - 1]?.id);
    const result = classify({
      exitCode: run.code,
      aborted: run.aborted,
      timedOut: signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError',
      output: run.output,
      footer: progress.footer,
      summary,
      limitPatterns: this.limitPatterns(),
    });
    return {
      ...result,
      completedTaskIds:
        result.reason === 'plugin_missing'
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

  async probe(model: ModelSpec): Promise<ProbeResult> {
    mkdirSync(this.opts.workDir, { recursive: true });
    const transcripts = join(mkdtempSync(join(this.opts.workDir, 'probe-')), 'transcripts');
    const args = ['-p', 'ok', '--model', model.id, '--max-turns', '1', ...this.claudeArgs()];
    const run = await this.spawn(SHIM, args, this.opts.workDir, transcripts, AbortSignal.timeout(120_000));
    const summary = readTranscripts(transcripts);
    const limit = summary.rateLimit ?? limitIn([run.output, ...summary.errors].join('\n'), this.limitPatterns());
    if (limit) return { ok: false, resetAt: limit.resetAt, limitKind: limit.kind };
    // Anything else that went wrong is also "not open yet": park until the next probe (design §4).
    return run.code === 0 ? { ok: true } : { ok: false, limitKind: 'unknown' };
  }

  private spawn(command: string, args: string[], cwd: string, transcripts: string, signal: AbortSignal) {
    const env: Env = { ...process.env, ...this.opts.env };
    for (const name of SESSION_ENV) delete env[name];
    env.RNSHIP_CLAUDE = this.opts.claude ?? env.RNSHIP_CLAUDE ?? 'claude';
    env.RNSHIP_TRANSCRIPTS = transcripts;
    env.RNSHIP_GUARD_PLUGIN = this.opts.guardPlugin ?? 'rnship';
    // Own process group, stdin from /dev/null: ralphex's pause prompt must never read input,
    // and an abort stops it with SIGTERM to the whole group, never SIGQUIT (S8 X1).
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    let aborted = false;
    const stop = () => {
      aborted = true;
      if (child.pid) process.kill(-child.pid, 'SIGTERM');
    };
    signal.addEventListener('abort', stop, { once: true });
    return new Promise<{ code: number; output: string; aborted: boolean }>((resolve) => {
      child.once('error', (error) => resolve({ code: 127, output: `${output}\n${error.message}`, aborted }));
      child.once('close', (code, sig) => {
        signal.removeEventListener('abort', stop);
        resolve({ code: code ?? (sig ? 128 : 1), output, aborted });
      });
    });
  }
}

function readTranscripts(dir: string): StreamSummary {
  if (!existsSync(dir)) return combine([]);
  return combine(readdirSync(dir).sort().map((file) => summarize(readFileSync(join(dir, file), 'utf8'))));
}

function readProgress(worktree: string, stem: string): { footer?: string; tail: string } {
  const dir = join(worktree, '.ralphex', 'progress');
  const file = existsSync(dir) ? readdirSync(dir).find((f) => f.startsWith(`progress-${stem}`)) : undefined;
  if (!file) return { tail: '' };
  const lines = readFileSync(join(dir, file), 'utf8').trimEnd().split('\n');
  const footer = lines.findLast((l) => /^(Completed|Failed): /.test(l));
  return { footer, tail: lines.slice(-20).join('\n').slice(-2000) };
}

function limitIn(text: string, patterns: string[]): { kind: ReturnType<typeof limitKindOf>; resetAt?: string } | undefined {
  const hit = matchPattern(text, patterns);
  return hit ? { kind: limitKindOf(hit) } : undefined;
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
