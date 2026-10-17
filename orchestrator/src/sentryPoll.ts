import type { Tier } from '@rnship/policy';
import type { Db } from './db.ts';
import type { Notify } from './notify.ts';
import type { SentryClient } from './sentry.ts';
import { ingestSignal } from './signals.ts';
import { triage, TriageError, triageTaskBody, type Triage } from './triage.ts';
import { git } from './worktree.ts';

// One B1 → B3 pass: poll unresolved issues, triage each from its latest event, and open or
// attach a task for each `fix`. A `rollback` or a triage you have to take over only
// notifies you: rollbacks run through `rnship release approve rollback`, as you.

export type PollOptions = {
  app: string;
  repo: string;
  /** The commit suspect files must exist at. */
  at: string;
  task: { tier: Tier; validation: string[] };
  minEvents?: number;
  minUsers?: number;
  rollingOut?: string[];
  statsPeriod?: string;
  notify: Notify;
};

export type PollReport = { fixed: { issue: string; taskId: number; created: boolean }[]; ignored: string[]; rollback: string[]; takeover: string[] };

export async function pollSentry(db: Db, client: SentryClient, opts: PollOptions, now: Date): Promise<PollReport> {
  const repoFiles = git(opts.repo, 'ls-tree', '-r', '--name-only', opts.at).split('\n').filter(Boolean);
  const report: PollReport = { fixed: [], ignored: [], rollback: [], takeover: [] };
  for (const issue of await client.issues(opts.statsPeriod)) {
    let result: Triage;
    try {
      result = triage(issue, await client.latestEvent(issue.id), { repoFiles, minEvents: opts.minEvents, minUsers: opts.minUsers, rollingOut: opts.rollingOut });
    } catch (error) {
      if (!(error instanceof TriageError)) throw error;
      report.takeover.push(issue.id);
      opts.notify({ title: 'triage needs you', message: error.message, taskIds: [] });
      continue;
    }
    if (result.action === 'ignore') {
      report.ignored.push(issue.id);
    } else if (result.action === 'rollback') {
      report.rollback.push(issue.id);
      opts.notify({ title: 'rollback suggested', message: `fatal ${result.error_class} on rolling-out update ${result.signal.update_id} (issue ${issue.id})`, taskIds: [] });
    } else {
      const ingested = ingestSignal(
        db,
        {
          app: opts.app,
          repo: opts.repo,
          signal: { ...result.signal, total: result.counts.events, users: result.counts.users },
          task: { ...opts.task, title: `Fix ${result.error_class} (Sentry issue ${issue.id})`, body: triageTaskBody(result), files: [...new Set(result.suspect_files.map((f) => f.path))] },
        },
        now,
      );
      report.fixed.push({ issue: issue.id, taskId: ingested.taskId, created: ingested.created });
    }
  }
  return report;
}
