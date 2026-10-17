// B1 signal-ingest from Sentry's REST API (design §2). The poller runs as its own command
// (`rnship signals poll`), never inside a tick: executors inherit the tick's env, and the
// Sentry token must not reach them. The token comes from env, never argv.
//
// Shapes are the subset we read. Everything in an event, file names and update IDs
// included, can be forged by anyone holding the app's public DSN, so triage validates
// each field before use and the raw event is never stored.

export type SentryIssue = {
  id: string;
  level?: string;
  count?: string | number;
  userCount?: number;
  metadata?: { type?: string };
};

export type SentryFrame = { filename?: string | null; absPath?: string | null; lineNo?: number | null; inApp?: boolean | null; function?: string | null };

export type SentryEvent = {
  release?: { version?: string } | string | null;
  entries?: { type: string; data?: { values?: { type?: string | null; stacktrace?: { frames?: SentryFrame[] | null } | null }[] } }[];
  contexts?: { ota_updates?: { update_id?: string; channel?: string; runtime_version?: string } };
};

export type Fetch = (url: string, init: { headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type SentryOptions = { org: string; project: string; token: string; baseUrl?: string; fetch?: Fetch };

// An all-digit value is a project ID, not a slug; Sentry rejects it (M1e).
const SLUG = /^(?!\d+$)[a-z0-9][a-z0-9_-]{0,63}$/;

export class SentryClient {
  private readonly base: string;
  private readonly opts: SentryOptions;

  constructor(opts: SentryOptions) {
    if (!SLUG.test(opts.org) || !SLUG.test(opts.project)) throw new Error('Sentry org and project must be slugs (not numeric IDs)');
    if (!opts.token) throw new Error('missing Sentry token: set SENTRY_AUTH_TOKEN');
    this.opts = opts;
    this.base = (opts.baseUrl ?? 'https://sentry.io').replace(/\/$/, '');
  }

  /** Unresolved issues seen in the period. One page: the scale (~1,000 MAU) doesn't need more. */
  issues(statsPeriod = '24h'): Promise<SentryIssue[]> {
    const query = new URLSearchParams({ query: 'is:unresolved', statsPeriod, limit: '100' });
    return this.get(`/api/0/projects/${this.opts.org}/${this.opts.project}/issues/?${query}`) as Promise<SentryIssue[]>;
  }

  latestEvent(issueId: string): Promise<SentryEvent> {
    if (!/^\d+$/.test(issueId)) throw new Error(`not a Sentry issue id: ${issueId.slice(0, 40)}`);
    return this.get(`/api/0/organizations/${this.opts.org}/issues/${issueId}/events/latest/`) as Promise<SentryEvent>;
  }

  private async get(path: string): Promise<unknown> {
    const response = await (this.opts.fetch ?? fetch)(this.base + path, { headers: { Authorization: `Bearer ${this.opts.token}` } });
    if (!response.ok) throw new Error(`Sentry answered ${response.status} for ${path.split('?')[0]}`);
    return response.json();
  }
}
