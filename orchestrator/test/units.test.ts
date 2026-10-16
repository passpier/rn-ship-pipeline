import { describe, expect, it } from 'vitest';
import { canTransition, decide, openDb, parseTasks, runStage, transition, TransitionError } from '../src/index.ts';
import { harness } from './harness.ts';

const now = new Date('2026-10-16T00:00:00Z');
const fresh = { tier: 'T1' as const, validation_failures: 0, crashes: 0, infra_failures: 0 };

describe('state machine', () => {
  it('refuses edges the design does not allow', () => {
    expect(canTransition('ready', 'done')).toBe(false);
    expect(canTransition('needs_human', 'ready')).toBe(false);
    expect(canTransition('done', 'ready')).toBe(false);
    const h = harness();
    h.importTasks([{ id: 'a' }]);
    expect(() => transition(h.db, h.task('a').id, 'pending', 'done', { now })).toThrow(TransitionError);
  });

  it('is a compare-and-set: a transition from a state the task already left changes nothing', () => {
    const h = harness();
    h.importTasks([{ id: 'a' }]);
    const id = h.task('a').id;
    expect(transition(h.db, id, 'pending', 'ready', { now })).toBe(true);
    expect(transition(h.db, id, 'pending', 'ready', { now })).toBe(false);
    expect(h.events('a').map((e) => e.to_state)).toEqual(['pending', 'ready']);
  });
});

describe('retry ladder', () => {
  it('retries validation at the same tier, then one tier up, then hands over', () => {
    const first = decide(fresh, 'validation_failed', { now });
    expect(first).toMatchObject({ state: 'retry_wait', patch: { validation_failures: 1 } });
    expect(first.patch).not.toHaveProperty('tier');
    expect(decide({ ...fresh, validation_failures: 1 }, 'validation_failed', { now })).toMatchObject({ state: 'retry_wait', patch: { tier: 'T2' } });
    expect(decide({ ...fresh, tier: 'T2', validation_failures: 1 }, 'validation_failed', { now }).patch.tier).toBe('T2');
    expect(decide({ ...fresh, validation_failures: 2 }, 'validation_failed', { now }).state).toBe('needs_human');
  });

  it('backs off on infrastructure failures without counting an attempt', () => {
    const first = decide(fresh, 'infra', { now });
    const third = decide({ ...fresh, infra_failures: 2 }, 'infra', { now });
    expect(first.patch).toMatchObject({ resume_at: '2026-10-16T00:01:00.000Z', infra_failures: 1 });
    expect(first.patch.validation_failures).toBeUndefined();
    expect(third.patch.resume_at).toBe('2026-10-16T00:04:00.000Z');
  });

  it('retries a crash once, sends a timeout to you, and gates a policy block', () => {
    expect(decide(fresh, 'crashed', { now }).state).toBe('retry_wait');
    expect(decide({ ...fresh, crashes: 1 }, 'crashed', { now }).state).toBe('needs_human');
    expect(decide(fresh, 'timeout', { now }).state).toBe('needs_human');
    expect(decide(fresh, 'policy_blocked', { now }).state).toBe('awaiting_approval');
    expect(decide(fresh, 'quota_exhausted', { now, resetAt: 'x' })).toMatchObject({ state: 'quota_parked', patch: { resume_at: 'x' } });
  });
});

describe('tasks.yaml', () => {
  const file = (tasks: string) => `version: 1\ntasks:\n${tasks}`;
  const task = (id: string, deps: string[] = []) => `  - { id: ${id}, title: ${id}, tier: T1, deps: [${deps.join(', ')}], validation: ["true"] }\n`;

  it('rejects cycles, unknown deps, duplicates, and tasks without validation commands', () => {
    expect(() => parseTasks(file(task('a', ['b']) + task('b', ['a'])))).toThrow(/cycle: a → b → a/);
    expect(() => parseTasks(file(task('a', ['zz'])))).toThrow(/unknown task zz/);
    expect(() => parseTasks(file(task('a') + task('a')))).toThrow(/listed twice/);
    expect(() => parseTasks(file('  - { id: a, title: a, tier: T1, validation: [] }\n'))).toThrow(/validation commands/);
  });

  it('runs a task only after its dependencies are done', async () => {
    const h = harness();
    h.importTasks([{ id: 'b', deps: ['a'] }, { id: 'a' }]);
    await h.tick();
    expect(h.executor.calls.map((c) => c.keys)).toEqual([['a'], ['b']]);
    expect(h.task('b').state).toBe('done');
  });
});

describe('stage cache', () => {
  it('skips a stage whose inputs have not changed', async () => {
    const db = openDb(':memory:');
    let runs = 0;
    const stage = (hash: string) => runStage(db, 'triage', { signal: hash }, async () => `out-${++runs}`);
    expect(await stage('h1')).toEqual({ output: 'out-1', cached: false });
    expect(await stage('h1')).toEqual({ output: 'out-1', cached: true });
    expect(await stage('h2')).toEqual({ output: 'out-2', cached: false });
  });
});

describe('tick', () => {
  it('runs the review pass after validation when the executor offers one', async () => {
    const h = harness({ reviewCapable: true });
    h.importTasks([{ id: 'a' }]);
    await h.tick();
    expect(h.executor.calls.map((c) => c.phase)).toEqual(['tasks', 'review']);
    expect(h.events('a').map((e) => e.to_state)).toEqual(['pending', 'ready', 'leased', 'running', 'validating', 'ready', 'leased', 'reviewing', 'validating', 'done']);
  });

  it('discards the work of a batch that fails validation and records the usage of every run', async () => {
    const h = harness();
    h.importTasks([{ id: 'a' }]);
    let calls = 0;
    await h.tick({ validate: async () => (++calls === 1 ? { ok: false, digest: 'tsc: 1 error' } : { ok: true }) });
    expect(h.executor.calls.map((c) => c.failureDigest)).toEqual([undefined, 'tsc: 1 error']);
    expect(h.task('a').state).toBe('done');
    const id = h.task('a').id;
    expect(h.db.prepare('SELECT task_id, model_id FROM ledger').all()).toEqual([
      { task_id: id, model_id: 'claude-sonnet-5-5' },
      { task_id: id, model_id: 'claude-sonnet-5-5' },
    ]);
  });

  it('records a multi-task batch as one row when the executor gives no per-task usage', async () => {
    const h = harness();
    h.importTasks([{ id: 'a' }, { id: 'b' }]);
    await h.tick();
    expect(h.db.prepare('SELECT task_id, detail FROM ledger').all()).toEqual([{ task_id: null, detail: JSON.stringify({ tasks: ['a', 'b'], phase: 'tasks', status: 'passed' }) }]);
  });

  it('skips a pass while another live tick holds the lock', async () => {
    const h = harness();
    h.db.prepare("INSERT INTO locks (name, pid, at) VALUES ('tick', ?, 'x')").run(process.ppid);
    expect(await h.tick()).toMatchObject({ busy: true });
  });
});
