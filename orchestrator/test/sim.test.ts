import { spawn } from 'node:child_process';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { stateDir, writeApproval } from '@rnship/release';
import { describe, expect, it } from 'vitest';
import { approvalSubject, FakeExecutor, ingestSignal, quotaState } from '../src/index.ts';
import { commitAll, gitIn, harness } from './harness.ts';

const MAIN = fileURLToPath(new URL('../../cli/src/main.ts', import.meta.url));
const HOUR = 3_600_000;

// The M2 acceptance tests (design §7): simulations with the fake executor, no LLM.
describe('orchestrator simulation', () => {
  it('parks a quota hit mid-batch, keeps the finished task, and resumes after resetAt', async () => {
    const h = harness({ tasks: { b: [{ status: 'quota_exhausted', resetAt: '2026-10-16T05:00:00Z', limitKind: 'five_hour' }] } });
    h.importTasks([{ id: 'a' }, { id: 'b' }]);

    const first = await h.tick();

    expect(first.batches).toEqual([expect.objectContaining({ taskKeys: ['a', 'b'], status: 'quota_exhausted' })]);
    expect(h.task('a').state).toBe('done');
    expect(h.task('b')).toMatchObject({ state: 'quota_parked', resume_at: '2026-10-16T05:00:00Z', validation_failures: 0 });
    expect(quotaState(h.db)).toMatchObject({ open: false, kind: 'five_hour', needsProbe: false });
    expect(existsSync(join(h.worktree(), 'partial-b.txt'))).toBe(false);
    expect(readdirSync(join(h.dir, 'home', 'bundles', `task-${h.task('b').id}`))).toEqual([expect.stringMatching(/^attempt-1-.*\.patch$/)]);

    h.advance(HOUR);
    expect((await h.tick()).batches).toEqual([]);

    h.setClock('2026-10-16T05:00:01Z');
    const resumed = await h.tick();

    expect(resumed.batches).toEqual([expect.objectContaining({ taskKeys: ['b'], status: 'passed' })]);
    expect(h.task('b').state).toBe('done');
    expect(h.executor.calls.map((c) => c.keys)).toEqual([['a', 'b'], ['b']]);
    expect(gitIn(h.worktree(), 'log', '--format=%s', 'main..HEAD').split('\n')).toEqual(['feat: b', 'feat: a']);
  });

  it('probes before resuming when the limit error had no reset time', async () => {
    const h = harness({
      tasks: { a: [{ status: 'quota_exhausted' }] },
      probe: [{ ok: false, limitKind: 'unknown' }, { ok: true }],
    });
    h.importTasks([{ id: 'a' }]);
    const probes = () => h.executor.calls.length;

    await h.tick();
    expect(quotaState(h.db)).toMatchObject({ open: false, kind: 'unknown', needsProbe: true });

    h.advance(15 * 60_000);
    await h.tick();
    expect(h.task('a').state).toBe('quota_parked');

    h.advance(15 * 60_000);
    await h.tick();
    expect(h.task('a').state).toBe('done');
    expect(probes()).toBe(2);
  });

  it('restarts after kill -9 without duplicating tasks or work', async () => {
    const h = harness();
    h.importTasks([{ id: 'a' }]);
    const script = join(h.dir, 'fake.json');
    writeFileSync(script, JSON.stringify({ tasks: { a: [{ status: 'passed', sleepMs: 60_000 }] } }));

    const child = spawn(process.execPath, [MAIN, 'tick', '--db', h.dbFile, '--executor', 'fake', '--fake-script', script], { stdio: 'ignore' });
    const reader = new DatabaseSync(h.dbFile, { readOnly: true });
    const state = () => (reader.prepare("SELECT state FROM tasks WHERE key = 'a'").get() as { state: string }).state;
    for (let i = 0; i < 200 && state() !== 'running'; i++) await sleep(50);
    expect(state()).toBe('running');
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
    reader.close();

    // Re-running the import after the crash adds nothing.
    expect(h.importTasks([{ id: 'a' }])).toMatchObject({ created: [], existing: ['a'] });
    h.executor = FakeExecutor.fromFile(script);
    const report = await h.tick();

    expect(report.reclaimed).toEqual(['a']);
    expect(h.task('a').state).toBe('done');
    expect(h.db.prepare('SELECT count(*) AS n FROM tasks').get()).toEqual({ n: 1 });
    expect(gitIn(h.worktree(), 'log', '--format=%s', 'main..HEAD')).toBe('feat: a');
    expect(h.events('a').map((e) => e.to_state)).toEqual(['pending', 'ready', 'leased', 'running', 'ready', 'leased', 'running', 'validating', 'done']);
    expect(h.db.prepare('SELECT count(*) AS n FROM locks').get()).toEqual({ n: 0 });
  });

  it('escalates the tier after two validation failures, then needs a human after the third', async () => {
    const failed = { status: 'validation_failed' as const, failureDigest: 'jest: 2 failing' };
    const h = harness({ tasks: { a: [failed, failed, failed] } });
    h.importTasks([{ id: 'a', tier: 'T1' }]);

    await h.tick();

    expect(h.executor.calls.map((c) => [c.model.id, c.attempt, c.failureDigest])).toEqual([
      ['claude-sonnet-5-5', 1, undefined],
      ['claude-sonnet-5-5', 2, 'jest: 2 failing'],
      ['claude-opus-5-5', 3, 'jest: 2 failing'],
    ]);
    expect(h.task('a')).toMatchObject({ state: 'needs_human', tier: 'T2', validation_failures: 3 });
    expect(h.notices).toEqual([expect.objectContaining({ title: 'task a needs you' })]);
    const bundle = h.notices[0]!.bundle!;
    expect(readdirSync(bundle)).toEqual(expect.arrayContaining(['task.json', 'failure.txt', 'diff.patch']));
  });

  it('hands a task whose tool calls were denied straight to you, without a retry or a bigger model', async () => {
    const denied = {
      status: 'validation_failed' as const,
      failureDigest: 'the session gave up: Write, Edit and Bash are all denied',
      deniedToolCalls: [{ tool_name: 'Write', tool_input: { file_path: 'src/Counter.tsx', content: '…' } }],
    };
    const h = harness({ tasks: { a: [denied] } });
    h.importTasks([{ id: 'a', tier: 'T1' }]);

    await h.tick();

    expect(h.executor.calls).toHaveLength(1);
    expect(h.task('a')).toMatchObject({ state: 'needs_human', tier: 'T1', validation_failures: 0, failure_class: 'denied' });
    expect(h.task('a').failure_digest).toBe('denied: Write(src/Counter.tsx)\nthe session gave up: Write, Edit and Bash are all denied');
    expect(h.notices).toEqual([expect.objectContaining({ title: 'task a needs you' })]);
  });

  it('turns a duplicate signal into one task', () => {
    const h = harness();
    const signal = { source: 'sentry', issue_id: '123', runtime_version: 'fp-abc' };
    const ingest = (s = signal) => ingestSignal(h.db, { app: 'demo', repo: h.repo, signal: s, task: { tier: 'T1', validation: ['true'] } }, h.now());

    const first = ingest();
    const second = ingest();
    const otherRuntime = ingest({ ...signal, runtime_version: 'fp-def' });

    expect(second).toEqual({ ...first, created: false });
    expect(otherRuntime.created).toBe(true);
    expect(h.db.prepare('SELECT count(*) AS n FROM tasks').get()).toEqual({ n: 2 });
    expect(h.db.prepare('SELECT priority FROM tasks WHERE id = ?').get(first.taskId)).toEqual({ priority: 2 });
    expect(h.db.prepare('SELECT count FROM signals WHERE dedup_key = ?').get(first.dedupKey)).toEqual({ count: 2 });

    // Once its task is closed, the same signal opens a new task.
    h.db.prepare("UPDATE tasks SET state = 'done' WHERE id = ?").run(first.taskId);
    expect(ingest()).toMatchObject({ created: true });
  });

  it('continues a gated task once you approve its head, and a new commit invalidates the approval', async () => {
    const h = harness({ tasks: { a: [{ status: 'passed', files: { 'gated/flag.txt': 'on\n' } }] } });
    h.importTasks([{ id: 'a' }, { id: 'b' }]);
    const approve = (sha: string) =>
      writeApproval(stateDir(h.repo, {}), { kind: 'task', digest: sha, subject: approvalSubject(h.task('a').run_id) }, {});

    await h.tick({ batchSize: 1 });
    const gated = h.task('a');
    expect(gated).toMatchObject({ state: 'awaiting_approval', failure_class: 'policy_gate' });
    expect(JSON.parse(gated.gates!)).toEqual([{ ruleId: 'test.gated', matches: ['gated/flag.txt'] }]);
    expect(h.notices[0]!.message).toContain(`rnship task approve ${gated.id} ${gated.head_sha}`);
    // The run is held while it waits, so the head you review stays put.
    expect(h.task('b').state).toBe('ready');

    approve(gated.head_sha!);
    writeFileSync(join(h.worktree(), 'later.txt'), 'x\n');
    commitAll(h.worktree(), 'a later commit');
    await h.tick({ batchSize: 1 });

    const moved = h.task('a');
    expect(moved.state).toBe('awaiting_approval');
    expect(moved.head_sha).not.toBe(gated.head_sha);
    expect(h.events('a').at(-1)!.reason).toContain(`approve ${moved.head_sha}`);

    approve(moved.head_sha!);
    await h.tick({ batchSize: 1 });

    expect(h.task('a').state).toBe('done');
    expect(h.task('b').state).toBe('done');
  });
});
