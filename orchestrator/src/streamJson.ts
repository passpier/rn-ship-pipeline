import type { LimitKind, Usage } from './executor.ts';

// Reads Claude Code `--output-format stream-json` transcripts. ralphex ignores most of what
// matters to us here (S8 X4, X7): the plugin list, usage, permission denials, and the
// rate-limit event with its reset time. So the shim keeps a copy of every stream, and the
// adapter reads it.

/** ralphex v1.7.0's default `claude_limit_patterns` (S8 X3). Extend from S4's captures. */
export const RALPHEX_LIMIT_PATTERNS = [
  "You've hit your limit",
  "You've hit your session limit",
  "You've hit your weekly limit",
  'API Error: 429',
  'Your usage allocation has been disabled by your admin',
  "You've hit your org's monthly usage limit",
  "You've hit your individual spend limit",
];

/** ralphex v1.7.0's default `claude_error_patterns`. */
export const RALPHEX_ERROR_PATTERNS = [
  ...RALPHEX_LIMIT_PATTERNS.slice(0, 3),
  'API Error: 400',
  'API Error: 401',
  'API Error: 403',
  'API Error: 404',
  'API Error: 413',
  'API Error: 429',
  'API Error: 500',
  'cannot be launched inside another Claude Code session',
  'Not logged in',
  ...RALPHEX_LIMIT_PATTERNS.slice(4),
];

/** What the shim prints when the guard plugin isn't loaded. It's an error pattern for ralphex. */
export const PLUGIN_MISSING = 'RNSHIP: plugin_missing';

export type InitEvent = { model?: string; plugins: string[]; pluginErrors: unknown[] };

export type StreamSummary = {
  init?: InitEvent;
  usage: Usage;
  permissionDenials: unknown[];
  rateLimit?: { kind: LimitKind; resetAt?: string };
  /** Text of error-shaped events: is_error results and API-error assistant messages. */
  errors: string[];
};

type Event = Record<string, unknown>;

export function parseLine(line: string): Event | undefined {
  if (!line.startsWith('{')) return undefined;
  try {
    const value = JSON.parse(line) as unknown;
    return typeof value === 'object' && value !== null ? (value as Event) : undefined;
  } catch {
    return undefined;
  }
}

export function initOf(event: Event): InitEvent | undefined {
  if (event.type !== 'system' || event.subtype !== 'init') return undefined;
  const plugins = Array.isArray(event.plugins) ? event.plugins : [];
  return {
    model: typeof event.model === 'string' ? event.model : undefined,
    plugins: plugins.map((p) => (typeof p === 'string' ? p : String((p as { name?: unknown }).name ?? ''))),
    pluginErrors: Array.isArray(event.plugin_errors) ? event.plugin_errors : [],
  };
}

/** Fails closed: the guard must be listed and no plugin may have failed to load (S2 T3f). */
export function checkInit(init: InitEvent | undefined, guard: string): { ok: true } | { ok: false; reason: string } {
  if (!init) return { ok: false, reason: 'no system/init event' };
  if (!init.plugins.includes(guard)) return { ok: false, reason: `guard plugin ${guard} is not loaded (plugins: ${init.plugins.join(', ') || 'none'})` };
  if (init.pluginErrors.length > 0) return { ok: false, reason: `plugin errors: ${JSON.stringify(init.pluginErrors)}` };
  return { ok: true };
}

export function limitKindOf(text: string): LimitKind {
  if (/weekly|seven_day/i.test(text)) return 'weekly';
  if (/session limit|five_hour|5-hour/i.test(text)) return 'five_hour';
  return 'unknown';
}

export function matchPattern(text: string, patterns: string[]): string | undefined {
  const lower = text.toLowerCase();
  return patterns.find((p) => lower.includes(p.toLowerCase()));
}

function resetTime(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  return undefined;
}

export function summarize(text: string): StreamSummary {
  const summary: StreamSummary = { usage: { inputTokens: 0, outputTokens: 0 }, permissionDenials: [], errors: [] };
  for (const line of text.split('\n')) {
    const event = parseLine(line.trim());
    if (!event) continue;
    const init = initOf(event);
    if (init) summary.init ??= init;
    if (event.type === 'rate_limit_event') {
      const info = (event.rate_limit_info ?? {}) as Record<string, unknown>;
      if (info.status === 'rejected') {
        summary.rateLimit = { kind: limitKindOf(String(info.rateLimitType ?? '')), resetAt: resetTime(info.resetsAt) };
      }
    }
    if (event.type === 'assistant' && (event.is_api_error_message === true || event.error)) {
      const content = ((event.message as { content?: { type?: string; text?: string }[] } | undefined)?.content ?? []);
      summary.errors.push(...content.filter((c) => c.type === 'text' && c.text).map((c) => c.text!));
    }
    if (event.type === 'result') {
      const usage = (event.usage ?? {}) as Record<string, unknown>;
      summary.usage.inputTokens += Number(usage.input_tokens ?? 0);
      summary.usage.outputTokens += Number(usage.output_tokens ?? 0);
      if (Array.isArray(event.permission_denials)) summary.permissionDenials.push(...event.permission_denials);
      if (event.is_error === true && typeof event.result === 'string') summary.errors.push(event.result);
    }
  }
  return summary;
}

/** Combines the summaries of several sessions (one per ralphex iteration). */
export function combine(summaries: StreamSummary[]): StreamSummary {
  return {
    init: summaries.find((s) => s.init)?.init,
    usage: {
      inputTokens: summaries.reduce((n, s) => n + s.usage.inputTokens, 0),
      outputTokens: summaries.reduce((n, s) => n + s.usage.outputTokens, 0),
    },
    permissionDenials: summaries.flatMap((s) => s.permissionDenials),
    rateLimit: summaries.findLast((s) => s.rateLimit)?.rateLimit,
    errors: summaries.flatMap((s) => s.errors),
  };
}
