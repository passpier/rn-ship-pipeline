import { escalate, type Tier } from '@rnship/policy';
import type { ExecStatus } from './executor.ts';
import type { State, TaskPatch } from './states.ts';

// What happens to a task after a run that didn't pass (design §4, retries by failure class).

export type Decision = { state: State; patch: TaskPatch; reason: string };

type Counters = { tier: Tier; validation_failures: number; crashes: number; infra_failures: number };

const INFRA_BACKOFF_MIN = 1;
const INFRA_BACKOFF_MAX_MIN = 60;

export function decide(
  task: Counters,
  status: Exclude<ExecStatus, 'passed'>,
  opts: { now: Date; resetAt?: string; failureDigest?: string },
): Decision {
  const at = (ms: number) => new Date(opts.now.getTime() + ms).toISOString();
  const digest = opts.failureDigest ?? null;
  switch (status) {
    case 'validation_failed': {
      // Attempt 1 at tier T, attempt 2 at T with the failure digest, attempt 3 at T+1, then you.
      const failures = task.validation_failures + 1;
      const base = { validation_failures: failures, failure_class: status, failure_digest: digest };
      if (failures >= 3) return { state: 'needs_human', patch: base, reason: `validation failed ${failures} times` };
      if (failures === 2) {
        const tier = escalate(task.tier);
        return { state: 'retry_wait', patch: { ...base, tier, resume_at: at(0) }, reason: `validation failed twice; escalating ${task.tier} → ${tier}` };
      }
      return { state: 'retry_wait', patch: { ...base, resume_at: at(0) }, reason: 'validation failed; retrying with the failure digest' };
    }
    case 'infra': {
      // npm or network trouble: back off, and it doesn't count as an attempt.
      const failures = task.infra_failures + 1;
      const minutes = Math.min(INFRA_BACKOFF_MIN * 2 ** (failures - 1), INFRA_BACKOFF_MAX_MIN);
      return {
        state: 'retry_wait',
        patch: { infra_failures: failures, failure_class: status, failure_digest: digest, resume_at: at(minutes * 60_000) },
        reason: `infrastructure failure; retrying in ${minutes} min`,
      };
    }
    case 'crashed': {
      const crashes = task.crashes + 1;
      const patch = { crashes, failure_class: status, failure_digest: digest };
      if (crashes >= 2) return { state: 'needs_human', patch, reason: 'executor crashed twice' };
      return { state: 'retry_wait', patch: { ...patch, resume_at: at(0) }, reason: 'executor crashed; retrying once' };
    }
    case 'timeout':
      return { state: 'needs_human', patch: { failure_class: status, failure_digest: digest }, reason: 'timed out; consider splitting the task' };
    case 'policy_blocked':
      return { state: 'awaiting_approval', patch: { failure_class: status, failure_digest: digest }, reason: 'blocked by policy; needs approval' };
    case 'quota_exhausted':
      // Not an attempt. resetAt is filled in by the caller from the ledger's park time.
      return { state: 'quota_parked', patch: { resume_at: opts.resetAt ?? null }, reason: 'Claude quota exhausted' };
  }
}
