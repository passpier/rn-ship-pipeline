import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelSpec } from '@rnship/policy';
import type { ExecRequest, ExecResult, ExecTask, Executor, ProbeResult, TaskUsage } from '../executor.ts';
import { combine, MODEL_MISMATCH, PLUGIN_MISSING, type StreamSummary } from '../streamJson.ts';
import { git, headSha, resetWorktree } from '../worktree.ts';
import { claudeArgs, limitIn, limitPatterns, probeQuota, readTranscripts, SHIM, spawnSession, timedOut, type SessionOptions, type SessionRun } from './claudeSession.ts';
import { renderReviewPrompt, renderTaskPrompt, signalOf } from './claudePPrompt.ts';

// The raw `claude -p` adapter: one fresh session per task (D4), started through the shim,
// which fails closed on a missing guard plugin or a substituted model and keeps the
// stream-json transcript. The first task that doesn't pass stops the batch, and its partial
// work (commits included) is saved as a patch and rolled back to where it started (design
// §4). A passed task must end on a commit that descends from where it started; changes
// Claude left uncommitted are committed here, so the diff check (base..HEAD) sees them.

export type ClaudePOptions = SessionOptions & {
  /** The orchestrator runs the review pass only when this is true. */
  review?: boolean;
  maxTurns?: number;
};

export type Classified = Pick<ExecResult, 'status' | 'resetAt' | 'limitKind' | 'reason' | 'failureDigest'>;

/** Lines Claude Code itself printed, as opposed to stream-json events (which carry model text). */
const plainLines = (output: string) =>
  output
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('{'))
    .join('\n');

const tail = (text: string | undefined) => (text ?? '').slice(-2000);

/** Maps one finished session to a status, or undefined when it ended with the expected signal. */
export function classifySession(input: {
  run: SessionRun;
  timedOut: boolean;
  summary: StreamSummary;
  limitPatterns: string[];
  expect: 'done' | 'review_done';
}): Classified | undefined {
  const { run, summary } = input;
  const plain = plainLines(run.output);
  for (const [marker, reason] of [
    [PLUGIN_MISSING, 'plugin_missing'],
    [MODEL_MISMATCH, 'model_mismatch'],
  ] as const) {
    const line = plain.split('\n').find((l) => l.includes(marker));
    if (line) return { status: 'crashed', reason, failureDigest: line };
  }
  if (run.aborted) return { status: input.timedOut ? 'timeout' : 'crashed', reason: 'aborted' };
  if (run.idle) return { status: 'timeout', reason: 'idle', failureDigest: 'no output from the session within the idle timeout' };

  const limit = summary.rateLimit ?? limitIn([plain, ...summary.errors].join('\n'), input.limitPatterns);
  if (limit) return { status: 'quota_exhausted', limitKind: limit.kind, resetAt: limit.resetAt, reason: summary.errors.at(-1) };

  const apiError = summary.errors.find((e) => /API Error: 5\d\d/.test(e));
  if (apiError) return { status: 'infra', reason: apiError };
  if (summary.resultSubtype === 'error_max_turns') return { status: 'validation_failed', reason: 'max turns reached', failureDigest: 'the session hit --max-turns before finishing' };
  if (run.code !== 0 || summary.errors.length > 0) {
    const reason = summary.errors[0] ?? (tail(plain).trim() || `claude exited ${run.code}`);
    return { status: 'crashed', reason, failureDigest: reason };
  }

  const signal = signalOf(summary.resultText);
  if (signal.kind === 'failed') return { status: 'validation_failed', reason: signal.reason, failureDigest: `the session gave up: ${signal.reason}` };
  if (signal.kind !== input.expect) {
    return { status: 'validation_failed', reason: 'no completion signal', failureDigest: `the session ended without its completion signal:\n${tail(summary.resultText)}` };
  }
  return undefined;
}

export class ClaudePExecutor implements Executor {
  readonly id = 'claude-p' as const;
  private readonly opts: ClaudePOptions;

  constructor(opts: ClaudePOptions) {
    this.opts = opts;
  }

  capabilities() {
    return { review: this.opts.review ?? false };
  }

  /** argv for one session; the prompt goes on stdin. */
  args(model: ModelSpec): string[] {
    return [
      '--print',
      '--model',
      model.id,
      ...(model.effort ? ['--effort', model.effort] : []),
      ...(this.opts.maxTurns ? ['--max-turns', String(this.opts.maxTurns)] : []),
      ...claudeArgs(this.opts),
    ];
  }

  async run(req: ExecRequest, signal: AbortSignal): Promise<ExecResult> {
    mkdirSync(this.opts.workDir, { recursive: true });
    const dir = mkdtempSync(join(this.opts.workDir, `run-${req.tasks[0]!.id}-`));
    const summaries: StreamSummary[] = [];
    const taskUsage: TaskUsage[] = [];
    const completed: number[] = [];
    const finish = (outcome: Classified): ExecResult => {
      const all = combine(summaries);
      const unguarded = outcome.reason === 'plugin_missing' || outcome.reason === 'model_mismatch';
      return {
        ...outcome,
        completedTaskIds: unguarded ? [] : outcome.status === 'passed' ? req.tasks.map((t) => t.id) : completed,
        deniedToolCalls: all.permissionDenials,
        usage: all.usage,
        modelId: all.init?.model,
        taskUsage: taskUsage.length > 0 ? taskUsage : undefined,
        transcriptPath: dir,
        failureDigest: outcome.status === 'passed' ? undefined : (outcome.failureDigest ?? outcome.reason),
      };
    };

    const sessions: { name: string; prompt: string; task?: ExecTask }[] =
      req.phase === 'review'
        ? [{ name: 'review', prompt: renderReviewPrompt(req.tasks, req.baseSha) }]
        : req.tasks.map((task, i) => ({ name: `${i + 1}-${task.key}`, prompt: renderTaskPrompt(task, { failureDigest: req.failureDigest }), task }));

    for (const session of sessions) {
      const start = headSha(req.worktree);
      const branch = currentBranch(req.worktree);
      const transcripts = join(dir, session.name);
      writeFileSync(join(dir, `${session.name}.prompt.md`), session.prompt);
      const run = await spawnSession(this.opts, SHIM, this.args(req.model), {
        cwd: req.worktree,
        transcripts,
        signal,
        stdin: session.prompt,
        idleTimeoutSec: req.idleTimeoutSec,
      });
      writeFileSync(join(dir, `${session.name}.log`), run.output);
      const summary = readTranscripts(transcripts);
      summaries.push(summary);
      if (session.task) taskUsage.push({ taskId: session.task.id, usage: summary.usage, modelId: summary.init?.model });

      const outcome = classifySession({
        run,
        timedOut: timedOut(signal),
        summary,
        limitPatterns: limitPatterns(this.opts),
        expect: session.task ? 'done' : 'review_done',
      });
      const stop = (failed: Classified) => {
        rollBack(req.worktree, { branch, start, patchPath: join(dir, `${session.name}.partial.patch`) });
        return finish(failed);
      };
      if (outcome) return stop(outcome);

      try {
        if (currentBranch(req.worktree) !== branch || !isAncestor(req.worktree, start)) {
          return stop({ status: 'crashed', reason: 'history_rewritten', failureDigest: `HEAD left ${branch} or no longer descends from ${start}` });
        }
        commitLeftovers(req.worktree, session.task ? `feat: ${session.task.key}` : 'fix: review');
      } catch (error) {
        return stop({ status: 'crashed', reason: String(error) });
      }
      if (session.task) {
        if (headSha(req.worktree) === start) return stop({ status: 'validation_failed', reason: 'no changes', failureDigest: 'the session reported done but changed nothing' });
        completed.push(session.task.id);
      }
    }
    return finish({ status: 'passed' });
  }

  probe(model: ModelSpec): Promise<ProbeResult> {
    return probeQuota(this.opts, model);
  }
}

function currentBranch(cwd: string): string {
  return git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
}

function isAncestor(cwd: string, sha: string): boolean {
  try {
    git(cwd, 'merge-base', '--is-ancestor', sha, 'HEAD');
    return true;
  } catch {
    return false;
  }
}

/** Saves the session's work since `start` (commits and uncommitted changes) as a patch, then goes back to `start` on `branch`. */
function rollBack(cwd: string, opts: { branch: string; start: string; patchPath: string }): void {
  git(cwd, 'add', '-A', '--intent-to-add');
  const patch = git(cwd, 'diff', opts.start, '--binary');
  if (patch) writeFileSync(opts.patchPath, patch);
  if (currentBranch(cwd) !== opts.branch) git(cwd, 'checkout', '-q', '-f', opts.branch);
  resetWorktree(cwd, { sha: opts.start });
}

/** Commits whatever the session left uncommitted, without running any of the repo's git hooks. */
function commitLeftovers(cwd: string, message: string): void {
  if (git(cwd, 'status', '--porcelain').trim() === '') return;
  git(cwd, 'add', '-A');
  git(cwd, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '--no-verify', '-m', message);
}
