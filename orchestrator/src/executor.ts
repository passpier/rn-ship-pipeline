import type { ModelSpec } from '@rnship/policy';

// The executor is a stateless "run these tasks to green" function (D2). The orchestrator
// owns all state; ralphex, raw `claude -p`, the API and the fake are adapters behind this.

export type ExecStatus = 'passed' | 'validation_failed' | 'quota_exhausted' | 'policy_blocked' | 'timeout' | 'crashed' | 'infra';

/** Five-hour window, weekly cap, or a limit error we couldn't classify (S4). */
export type LimitKind = 'five_hour' | 'weekly' | 'unknown';

export type ExecTask = { id: number; key: string; title: string; body: string; validation: string[] };

export type ExecRequest = {
  tasks: ExecTask[];
  /** `review` runs the review pass over the tasks' commits instead of implementing them. */
  phase: 'tasks' | 'review';
  attempt: number;
  worktree: string;
  baseSha: string;
  model: ModelSpec;
  /** Digest of the previous attempt's failure, for attempt 2 and later. */
  failureDigest?: string;
  timeoutSec: number;
  idleTimeoutSec: number;
};

export type Usage = { inputTokens: number; outputTokens: number };

export type ExecResult = {
  status: ExecStatus;
  /** Tasks finished before the run stopped. A mid-batch quota hit keeps these. */
  completedTaskIds: number[];
  /** On quota_exhausted: when the limit resets, if the executor could tell. */
  resetAt?: string;
  limitKind?: LimitKind;
  /** Why it crashed, e.g. `plugin_missing`. */
  reason?: string;
  deniedToolCalls: unknown[];
  usage: Usage;
  /** The model that actually ran, from `system/init`. */
  modelId?: string;
  transcriptPath?: string;
  failureDigest?: string;
};

export type ProbeResult = { ok: true } | { ok: false; resetAt?: string; limitKind: LimitKind };

export interface Executor {
  id: 'ralphex' | 'claude-p' | 'anthropic-api' | 'fake';
  capabilities(): { review: boolean };
  run(req: ExecRequest, signal: AbortSignal): Promise<ExecResult>;
  /** A minimal call that tells whether the Claude quota is open again. */
  probe(model: ModelSpec): Promise<ProbeResult>;
}

export const NO_USAGE: Usage = { inputTokens: 0, outputTokens: 0 };
