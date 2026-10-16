import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ModelSpec } from '@rnship/policy';
import { NO_USAGE, type ExecRequest, type ExecResult, type ExecStatus, type Executor, type LimitKind, type ProbeResult } from '../executor.ts';
import { git } from '../worktree.ts';

// The `fake` executor: plays a script of outcomes per task key, one per call. A passing task
// commits `tasks/<key>.txt` in the worktree, so the diff check and approvals see real git.
// A batch stops at the first task that doesn't pass, like ralphex. Call counts live in a
// file when one is given, so a script survives a `kill -9` of the process running it.

export type FakeOutcome = {
  status: ExecStatus;
  /** Sleep before finishing, to simulate a long run (the kill -9 test). */
  sleepMs?: number;
  resetAt?: string;
  limitKind?: LimitKind;
  /** Extra files to write and commit with the task, e.g. { "package.json": "..." }. */
  files?: Record<string, string>;
  failureDigest?: string;
  /** Permission denials the run reports, as stream-json `permission_denials` entries. */
  deniedToolCalls?: unknown[];
};

export type FakeScript = {
  tasks?: Record<string, FakeOutcome[]>;
  review?: FakeOutcome[];
  probe?: ProbeResult[];
  /** Whether the executor offers a review pass. */
  reviewCapable?: boolean;
  modelId?: string;
};

export type FakeCall = { phase: ExecRequest['phase']; keys: string[]; model: ModelSpec; attempt: number; failureDigest?: string };

export class FakeExecutor implements Executor {
  readonly id = 'fake' as const;
  readonly calls: FakeCall[] = [];
  private readonly script: FakeScript;
  private readonly counterFile?: string;
  private counters: Record<string, number> = {};

  constructor(script: FakeScript, opts: { counterFile?: string } = {}) {
    this.script = script;
    this.counterFile = opts.counterFile;
    if (this.counterFile && existsSync(this.counterFile)) this.counters = JSON.parse(readFileSync(this.counterFile, 'utf8'));
  }

  static fromFile(path: string): FakeExecutor {
    return new FakeExecutor(JSON.parse(readFileSync(path, 'utf8')) as FakeScript, { counterFile: `${path}.calls.json` });
  }

  capabilities() {
    return { review: this.script.reviewCapable ?? false };
  }

  async run(req: ExecRequest, signal: AbortSignal): Promise<ExecResult> {
    this.calls.push({ phase: req.phase, keys: req.tasks.map((t) => t.key), model: req.model, attempt: req.attempt, failureDigest: req.failureDigest });
    const result = (status: ExecStatus, completed: number[], outcome?: FakeOutcome): ExecResult => ({
      status,
      completedTaskIds: completed,
      resetAt: outcome?.resetAt,
      limitKind: outcome?.limitKind,
      failureDigest: outcome?.failureDigest ?? (status === 'passed' ? undefined : `fake: ${status}`),
      deniedToolCalls: outcome?.deniedToolCalls ?? [],
      usage: { ...NO_USAGE, outputTokens: 100 * completed.length },
      modelId: this.script.modelId ?? req.model.id,
    });

    if (req.phase === 'review') {
      const outcome = this.next('review:', this.script.review);
      if (outcome.sleepMs) await sleep(outcome.sleepMs, undefined, { signal });
      return result(outcome.status, outcome.status === 'passed' ? req.tasks.map((t) => t.id) : [], outcome);
    }

    const completed: number[] = [];
    for (const task of req.tasks) {
      const outcome = this.next(`task:${task.key}`, this.script.tasks?.[task.key]);
      if (outcome.sleepMs) await sleep(outcome.sleepMs, undefined, { signal });
      if (outcome.status !== 'passed') {
        // Work in progress that the orchestrator must discard.
        writeFileSync(join(req.worktree, `partial-${task.key}.txt`), 'unfinished\n');
        return result(outcome.status, completed, outcome);
      }
      const files = { [`tasks/${task.key}.txt`]: `${task.title}\n`, ...outcome.files };
      for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(req.worktree, path)), { recursive: true });
        writeFileSync(join(req.worktree, path), content);
      }
      git(req.worktree, 'add', '-A');
      git(req.worktree, '-c', 'user.email=fake@example.com', '-c', 'user.name=fake', 'commit', '-q', '-m', `feat: ${task.key}`);
      completed.push(task.id);
    }
    return result('passed', completed);
  }

  async probe(): Promise<ProbeResult> {
    const list = this.script.probe ?? [];
    const n = this.bump('probe');
    return list[Math.min(n, list.length - 1)] ?? { ok: true };
  }

  private next(key: string, outcomes: FakeOutcome[] | undefined): FakeOutcome {
    const n = this.bump(key);
    return outcomes?.[n] ?? { status: 'passed' };
  }

  private bump(key: string): number {
    const n = this.counters[key] ?? 0;
    this.counters[key] = n + 1;
    if (this.counterFile) writeFileSync(this.counterFile, JSON.stringify(this.counters));
    return n;
  }
}
