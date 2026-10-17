import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';

// Rollout policy and the per-step health window (design §5, B6). The numbers come from
// Sentry release health for the sessions that ran the new update; fetching them is the
// orchestrator's job, judging them is here.

const Percent = z.number().int().min(1).max(100);

export const RolloutSchema = z
  .object({
    version: z.literal(1),
    steps: z
      .array(Percent)
      .min(1)
      .refine((steps) => steps.every((step, i) => i === 0 || step > steps[i - 1]!), 'steps must increase')
      .refine((steps) => steps.at(-1) === 100, 'the last step must be 100'),
    window_hours: z.number().positive(),
    min_sessions: z.number().int().min(1),
    crash_free_sessions_min: z.number().gt(0).max(1),
  })
  .strict();

export type Rollout = z.infer<typeof RolloutSchema>;

export function parseRollout(yamlText: string): Rollout {
  return RolloutSchema.parse(parse(yamlText));
}

export function loadRollout(path: string | URL = new URL('../rollout.yaml', import.meta.url)): Rollout {
  return parseRollout(readFileSync(path, 'utf8'));
}

/** The step after `current`, or undefined at 100%. A percentage between steps moves to the next one up. */
export function nextStep(rollout: Rollout, current: number): number | undefined {
  return rollout.steps.find((step) => step > current);
}

export type HealthWindow = { sessions: number; crashed: number };
export type Health = { verdict: 'pass' | 'fail' | 'inconclusive'; crashFree: number | undefined; detail: string };

/**
 * Judges one rollout window. Below min_sessions it is inconclusive even with crashes in it:
 * too few sessions neither prove the update healthy nor justify a rollback on their own.
 */
export function judgeWindow(rollout: Rollout, window: HealthWindow): Health {
  const { sessions, crashed } = window;
  if (!Number.isInteger(sessions) || !Number.isInteger(crashed) || sessions < 0 || crashed < 0 || crashed > sessions) {
    throw new Error(`invalid health window: ${sessions} sessions, ${crashed} crashed`);
  }
  const crashFree = sessions === 0 ? undefined : (sessions - crashed) / sessions;
  const rate = crashFree === undefined ? 'no sessions' : `crash-free ${(crashFree * 100).toFixed(2)}%`;
  if (sessions < rollout.min_sessions) {
    return { verdict: 'inconclusive', crashFree, detail: `${sessions} sessions, below min_sessions ${rollout.min_sessions} (${rate}, ${crashed} crashed)` };
  }
  const min = `${(rollout.crash_free_sessions_min * 100).toFixed(2)}%`;
  if (crashFree! < rollout.crash_free_sessions_min) return { verdict: 'fail', crashFree, detail: `${rate} over ${sessions} sessions, below ${min}` };
  return { verdict: 'pass', crashFree, detail: `${rate} over ${sessions} sessions, at least ${min}` };
}
