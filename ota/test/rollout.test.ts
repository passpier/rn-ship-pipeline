import { describe, expect, it } from 'vitest';
import { judgeWindow, loadRollout, nextStep, parseRollout } from '../src/index.ts';

const rollout = loadRollout();

describe('rollout policy', () => {
  it('starts production at 10% and needs 50 sessions per window by default', () => {
    expect(rollout).toMatchObject({ steps: [10, 25, 50, 100], min_sessions: 50 });
  });

  it('rejects steps that do not increase or never reach 100', () => {
    const yaml = (steps: string) => `version: 1\nsteps: ${steps}\nwindow_hours: 24\nmin_sessions: 50\ncrash_free_sessions_min: 0.99\n`;
    expect(() => parseRollout(yaml('[10, 10, 100]'))).toThrow(/increase/);
    expect(() => parseRollout(yaml('[10, 50]'))).toThrow(/100/);
  });

  it('moves to the next step up, and nowhere after 100', () => {
    expect(nextStep(rollout, 10)).toBe(25);
    expect(nextStep(rollout, 30)).toBe(50);
    expect(nextStep(rollout, 100)).toBeUndefined();
  });
});

describe('health window', () => {
  it('is inconclusive below min_sessions, even with crashes', () => {
    expect(judgeWindow(rollout, { sessions: 49, crashed: 0 })).toMatchObject({ verdict: 'inconclusive' });
    expect(judgeWindow(rollout, { sessions: 12, crashed: 12 })).toMatchObject({ verdict: 'inconclusive', crashFree: 0 });
    expect(judgeWindow(rollout, { sessions: 0, crashed: 0 })).toMatchObject({ verdict: 'inconclusive', crashFree: undefined });
  });

  it('passes at or above the crash-free minimum and fails below it', () => {
    expect(judgeWindow(rollout, { sessions: 1000, crashed: 5 })).toMatchObject({ verdict: 'pass' });
    expect(judgeWindow(rollout, { sessions: 1000, crashed: 6 })).toMatchObject({ verdict: 'fail' });
  });

  it('refuses impossible counts', () => {
    expect(() => judgeWindow(rollout, { sessions: 10, crashed: 11 })).toThrow(/invalid/);
    expect(() => judgeWindow(rollout, { sessions: -1, crashed: 0 })).toThrow(/invalid/);
  });
});
