import { userInfo } from 'node:os';
import { describe, expect, it } from 'vitest';
import { harness } from '../../orchestrator/test/harness.ts';
import { taskApprove } from '../src/orchestrate.ts';

describe('rnship task approve', () => {
  async function gated() {
    const h = harness({ tasks: { a: [{ status: 'passed', files: { 'gated/x.txt': '1\n' } }] } });
    h.importTasks([{ id: 'a' }]);
    await h.tick();
    return h;
  }

  it('approves the task head and lets the next tick finish the task', async () => {
    const h = await gated();
    const task = h.task('a');

    taskApprove(h.dbFile, { taskId: task.id, sha: task.head_sha! }, {});
    await h.tick();

    expect(h.task('a').state).toBe('done');
  });

  it('refuses a SHA that is not the current head, a task that is not waiting, and the agent user', async () => {
    const h = await gated();
    const task = h.task('a');

    expect(() => taskApprove(h.dbFile, { taskId: task.id, sha: 'f'.repeat(40) }, {})).toThrow(/head is/);
    expect(() => taskApprove(h.dbFile, { taskId: task.id, sha: task.head_sha! }, { RNSHIP_AGENT_USER: userInfo().username })).toThrow(/agent user/);
    taskApprove(h.dbFile, { taskId: task.id, sha: task.head_sha! }, {});
    await h.tick();
    expect(() => taskApprove(h.dbFile, { taskId: task.id, sha: task.head_sha! }, {})).toThrow(/is done/);
  });
});
