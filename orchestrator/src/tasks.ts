import { readFileSync } from 'node:fs';
import { TIERS } from '@rnship/policy';
import { parse } from 'yaml';
import { z } from 'zod';
import { transaction, type Db } from './db.ts';
import { activeRun } from './runs.ts';

// The M2 subset of `tasks.yaml` (A5/B3 output). Smoke flows and risk tags come with M4/M5.

const TaskSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits and dashes'),
    title: z.string().min(1),
    tier: z.enum(TIERS),
    deps: z.array(z.string()).default([]),
    files: z.array(z.string()).default([]),
    validation: z.array(z.string()).min(1, 'every task needs validation commands'),
    native: z.boolean().default(false),
    body: z.string().default(''),
  })
  .strict();

export const TasksFileSchema = z.object({ version: z.literal(1), tasks: z.array(TaskSchema).min(1) }).strict();
export type TasksFile = z.infer<typeof TasksFileSchema>;

export function parseTasks(yamlText: string): TasksFile {
  const file = TasksFileSchema.parse(parse(yamlText));
  const ids = new Set<string>();
  for (const task of file.tasks) {
    if (ids.has(task.id)) throw new Error(`task ${task.id} is listed twice`);
    ids.add(task.id);
  }
  for (const task of file.tasks) {
    for (const dep of task.deps) if (!ids.has(dep)) throw new Error(`task ${task.id} depends on unknown task ${dep}`);
  }
  const cycle = findCycle(file.tasks);
  if (cycle) throw new Error(`task dependencies have a cycle: ${cycle.join(' → ')}`);
  return file;
}

export function loadTasks(path: string): TasksFile {
  return parseTasks(readFileSync(path, 'utf8'));
}

function findCycle(tasks: { id: string; deps: string[] }[]): string[] | undefined {
  const deps = new Map(tasks.map((t) => [t.id, t.deps]));
  const state = new Map<string, 'visiting' | 'done'>();
  const path: string[] = [];
  const visit = (id: string): string[] | undefined => {
    if (state.get(id) === 'done') return undefined;
    if (state.get(id) === 'visiting') return [...path.slice(path.indexOf(id)), id];
    state.set(id, 'visiting');
    path.push(id);
    for (const dep of deps.get(id) ?? []) {
      const cycle = visit(dep);
      if (cycle) return cycle;
    }
    path.pop();
    state.set(id, 'done');
    return undefined;
  };
  for (const task of tasks) {
    const cycle = visit(task.id);
    if (cycle) return cycle;
  }
  return undefined;
}

export type ImportResult = { runId: number; created: string[]; existing: string[] };

/**
 * Adds the tasks to the active run for (app, flow). Idempotent: a task whose id is already
 * in the run is left as it is, so re-running an import after a crash adds nothing.
 */
export function importTasks(db: Db, input: { app: string; flow: 'A' | 'B'; repo: string; file: TasksFile }, now: Date): ImportResult {
  return transaction(db, () => {
    const run = activeRun(db, input, now);
    const at = now.toISOString();
    const insert = db.prepare(
      `INSERT INTO tasks (run_id, key, title, body, tier, native, files, validation, state, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?) ON CONFLICT (run_id, key) DO NOTHING`,
    );
    const created: string[] = [];
    const existing: string[] = [];
    for (const task of input.file.tasks) {
      const result = insert.run(run.id, task.id, task.title, task.body, task.tier, task.native ? 1 : 0, JSON.stringify(task.files), JSON.stringify(task.validation), at);
      (result.changes > 0 ? created : existing).push(task.id);
      if (result.changes > 0) {
        db.prepare("INSERT INTO events (task_id, from_state, to_state, reason, at) VALUES (?, NULL, 'pending', 'imported', ?)").run(Number(result.lastInsertRowid), at);
      }
    }
    const idOf = db.prepare('SELECT id FROM tasks WHERE run_id = ? AND key = ?');
    const link = db.prepare('INSERT OR IGNORE INTO task_deps (task_id, dep_id) VALUES (?, ?)');
    for (const task of input.file.tasks) {
      const { id } = idOf.get(run.id, task.id) as { id: number };
      for (const dep of task.deps) link.run(id, (idOf.get(run.id, dep) as { id: number }).id);
    }
    return { runId: run.id, created, existing };
  });
}
