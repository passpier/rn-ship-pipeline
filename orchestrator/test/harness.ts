import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRouting } from '@rnship/policy';
import { stringify } from 'yaml';
import { FakeExecutor, getTask, importTasks, openDb, parseTasks, tick, type DiffCheck, type FakeScript, type Notice, type TickOptions } from '../src/index.ts';

// A temp app repo, an orchestrator DB, a controllable clock, and the fake executor. The diff
// check gates any file under `gated/`, standing in for `rnship policy check`.

export const gitIn = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
export const commitAll = (cwd: string, message: string) => {
  gitIn(cwd, 'add', '-A');
  gitIn(cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', message);
};

export const gatedDiffCheck: DiffCheck = ({ root, baseRef }) => {
  const changed = gitIn(root, 'diff', '--name-only', `${baseRef}...HEAD`).split('\n').filter(Boolean);
  const gated = changed.filter((file) => file.startsWith('gated/'));
  return { ok: gated.length === 0, gates: gated.length > 0 ? [{ ruleId: 'test.gated', matches: gated }] : [] };
};

export type TaskSpec = { id: string; tier?: 'T0' | 'T1' | 'T2'; deps?: string[] };

export function harness(script: FakeScript = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rnship-orch-'));
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  gitIn(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), 'app\n');
  writeFileSync(join(repo, '.gitignore'), '.rnship/state/\n');
  commitAll(repo, 'base');

  const dbFile = join(dir, 'home', 'orchestrator.db');
  const db = openDb(dbFile);
  let clock = new Date('2026-10-16T00:00:00Z');
  const notices: Notice[] = [];
  let executor = new FakeExecutor(script);

  const options = (): TickOptions => ({
    db,
    executor,
    routing: loadRouting(),
    diffCheck: gatedDiffCheck,
    validate: async () => ({ ok: true }),
    notify: (notice) => notices.push(notice),
    home: join(dir, 'home'),
    now: () => clock,
    env: {},
  });

  return {
    dir,
    repo,
    db,
    dbFile,
    notices,
    get executor() {
      return executor;
    },
    set executor(next: FakeExecutor) {
      executor = next;
    },
    now: () => clock,
    advance(ms: number) {
      clock = new Date(clock.getTime() + ms);
    },
    setClock(iso: string) {
      clock = new Date(iso);
    },
    tick: (overrides: Partial<TickOptions> = {}) => tick({ ...options(), ...overrides }),
    importTasks(tasks: TaskSpec[], flow: 'A' | 'B' = 'A') {
      const yamlText = stringify({
        version: 1,
        tasks: tasks.map((t) => ({ id: t.id, title: `Task ${t.id}`, tier: t.tier ?? 'T1', deps: t.deps ?? [], validation: ['true'] })),
      });
      return importTasks(db, { app: 'demo', flow, repo, file: parseTasks(yamlText) }, clock);
    },
    task(key: string) {
      const row = db.prepare('SELECT id FROM tasks WHERE key = ?').get(key) as { id: number };
      return getTask(db, row.id);
    },
    events(key: string) {
      const { id } = db.prepare('SELECT id FROM tasks WHERE key = ?').get(key) as { id: number };
      return db.prepare('SELECT from_state, to_state, reason FROM events WHERE task_id = ? ORDER BY id').all(id) as {
        from_state: string | null;
        to_state: string;
        reason: string | null;
      }[];
    },
    worktree() {
      const row = db.prepare('SELECT worktree FROM runs ORDER BY id LIMIT 1').get() as { worktree: string };
      return row.worktree;
    },
  };
}
