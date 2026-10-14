import type { Effect, Policy, Rule } from './schema.ts';

// The parts of a project that `deps` and `config_paths` matches look at.
export type ProjectState = {
  /** Resolved Expo config (`expo config --json`, plugins included). */
  config: Record<string, unknown>;
  /** dependencies and devDependencies from package.json. */
  dependencies: Record<string, string>;
};

export type Gate = { ruleId: string; category: Rule['category']; effect: Effect; matches: string[] };

// Rules whose deps or config_paths matches differ between two project states. M1's
// `rnship policy check` passes the approved baseline as `before`; the OTA classifier
// passes the production build's source.
export function changedGates(policy: Policy, before: ProjectState, after: ProjectState): Gate[] {
  const gates: Gate[] = [];
  for (const rule of policy.rules) {
    const matches = [
      ...rule.match.config_paths.flatMap((expr) => changedConfigPaths(expr, before.config, after.config)),
      ...changedDeps(rule.match.deps, before.dependencies, after.dependencies),
    ];
    if (matches.length > 0) gates.push({ ruleId: rule.id, category: rule.category, effect: rule.effect, matches });
  }
  return gates;
}

function changedDeps(patterns: string[], before: Record<string, string>, after: Record<string, string>): string[] {
  if (patterns.length === 0) return [];
  const regexes = patterns.map(globToRegExp);
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names]
    .filter((name) => before[name] !== after[name] && regexes.some((re) => re.test(name)))
    .sort()
    .map((name) => `deps:${name}`);
}

export function globToRegExp(glob: string): RegExp {
  return new RegExp(`^${glob.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\/]/g, '\\$&')).join('.*')}$`);
}

// --- config_paths -------------------------------------------------------------
// Syntax: dot-separated keys; `/regex/` matches keys; `name[a|b]` selects entries of
// the `name` array whose plugin name is a or b (a plugin entry is "a", ["a", opts], or a function).

type Segment = { kind: 'key'; key: string } | { kind: 'regex'; re: RegExp } | { kind: 'pick'; key: string; names: string[] };

function parseConfigPath(expr: string): Segment[] {
  const segments: Segment[] = [];
  let rest = expr;
  while (rest.length > 0) {
    let token: string;
    if (rest.startsWith('/')) {
      const end = rest.indexOf('/', 1);
      if (end < 0) throw new Error(`unterminated regex in config path ${expr}`);
      token = rest.slice(0, end + 1);
      segments.push({ kind: 'regex', re: new RegExp(token.slice(1, -1)) });
    } else {
      const dot = rest.indexOf('.');
      token = dot < 0 ? rest : rest.slice(0, dot);
      const pick = /^([^[]+)\[([^\]]+)\]$/.exec(token);
      segments.push(pick ? { kind: 'pick', key: pick[1]!, names: pick[2]!.split('|') } : { kind: 'key', key: token });
    }
    rest = rest.slice(token.length);
    if (rest.startsWith('.')) rest = rest.slice(1);
  }
  return segments;
}

function resolve(value: unknown, segments: Segment[], label: string, out: Map<string, string>): void {
  const [segment, ...tail] = segments;
  if (!segment) {
    out.set(label, stableJson(value));
    return;
  }
  if (!isObject(value)) return;
  const join = (key: string) => (label ? `${label}.${key}` : key);
  if (segment.kind === 'key') {
    if (segment.key in value) resolve(value[segment.key], tail, join(segment.key), out);
  } else if (segment.kind === 'regex') {
    for (const key of Object.keys(value).filter((k) => segment.re.test(k))) resolve(value[key], tail, join(key), out);
  } else {
    const entries = value[segment.key];
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      const name = pluginName(entry);
      if (name && segment.names.includes(name)) {
        resolve(Array.isArray(entry) ? (entry[1] ?? null) : null, tail, join(`${segment.key}[${name}]`), out);
      }
    }
  }
}

function changedConfigPaths(expr: string, before: unknown, after: unknown): string[] {
  const segments = parseConfigPath(expr);
  const a = new Map<string, string>();
  const b = new Map<string, string>();
  resolve(before, segments, '', a);
  resolve(after, segments, '', b);
  const labels = new Set([...a.keys(), ...b.keys()]);
  return [...labels].filter((label) => a.get(label) !== b.get(label)).sort();
}

function pluginName(entry: unknown): string | undefined {
  if (typeof entry === 'string') return entry;
  if (typeof entry === 'function') return entry.name || undefined;
  if (Array.isArray(entry)) return pluginName(entry[0]);
  return undefined;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    isObject(v) && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => x.localeCompare(y))) : v,
  ) ?? 'undefined';
}
