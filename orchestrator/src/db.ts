import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Orchestrator state: one SQLite file owned by rnship-agent. Every state change is a
// compare-and-set inside a transaction, so a `kill -9` at any point leaves rows the next
// tick can reclaim, and re-running an import or a signal never duplicates a task.

export type Db = DatabaseSync;

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE runs (
  id INTEGER PRIMARY KEY,
  app TEXT NOT NULL,
  flow TEXT NOT NULL CHECK (flow IN ('A', 'B')),
  repo TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  base_sha TEXT NOT NULL,
  branch TEXT,
  worktree TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX one_active_run ON runs (app, flow) WHERE status = 'active';

CREATE TABLE tasks (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs (id),
  key TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  tier TEXT NOT NULL,
  native INTEGER NOT NULL DEFAULT 0,
  files TEXT NOT NULL DEFAULT '[]',
  validation TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT 'tasks' CHECK (phase IN ('tasks', 'review')),
  priority INTEGER NOT NULL DEFAULT 0,
  validation_failures INTEGER NOT NULL DEFAULT 0,
  crashes INTEGER NOT NULL DEFAULT 0,
  infra_failures INTEGER NOT NULL DEFAULT 0,
  resume_at TEXT,
  failure_class TEXT,
  failure_digest TEXT,
  start_sha TEXT,
  head_sha TEXT,
  gates TEXT,
  lease_pid INTEGER,
  updated_at TEXT NOT NULL,
  UNIQUE (run_id, key)
);

CREATE TABLE task_deps (
  task_id INTEGER NOT NULL REFERENCES tasks (id),
  dep_id INTEGER NOT NULL REFERENCES tasks (id),
  PRIMARY KEY (task_id, dep_id)
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks (id),
  from_state TEXT,
  to_state TEXT NOT NULL,
  reason TEXT,
  at TEXT NOT NULL
);

CREATE TABLE signals (
  dedup_key TEXT PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks (id),
  count INTEGER NOT NULL,
  opened INTEGER NOT NULL DEFAULT 1,
  last_seen TEXT NOT NULL
);

CREATE TABLE stage_cache (
  key TEXT PRIMARY KEY,
  stage TEXT NOT NULL,
  output TEXT NOT NULL,
  at TEXT NOT NULL
);

CREATE TABLE ledger (
  id INTEGER PRIMARY KEY,
  task_id INTEGER REFERENCES tasks (id),
  budget TEXT NOT NULL,
  amount REAL NOT NULL,
  model_id TEXT,
  detail TEXT,
  at TEXT NOT NULL
);

CREATE TABLE budget_state (
  budget TEXT PRIMARY KEY,
  parked_until TEXT,
  kind TEXT,
  needs_probe INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE locks (
  name TEXT PRIMARY KEY,
  pid INTEGER NOT NULL,
  at TEXT NOT NULL
);
`;

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (version === 0) {
    transaction(db, () => {
      db.exec(SCHEMA);
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });
  } else if (version !== SCHEMA_VERSION) {
    throw new Error(`${path} has schema version ${version}; this rnship expects ${SCHEMA_VERSION}`);
  }
  return db;
}

/** Runs fn in an IMMEDIATE transaction, so concurrent ticks serialize on writes. Nests. */
export function transaction<T>(db: Db, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
