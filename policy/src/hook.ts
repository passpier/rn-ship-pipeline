import { isAbsolute, matchesGlob, relative } from 'node:path';
import { globToRegExp } from './changes.ts';
import { PROTECTED_PATHS } from './compile.ts';
import type { Policy, Rule } from './schema.ts';
import { parseCommand, type SimpleCommand } from './shell.ts';

// Decides one PreToolUse call for the guard plugin (plugin/hooks/guard.ts). This is
// early feedback for the executor, not the gate: `rnship policy check` and identity
// separation are. deps and config_paths matches are left to `rnship policy check`,
// which sees the resulting files instead of a partial edit.

export type HookInput = { tool_name: string; tool_input: Record<string, unknown>; cwd?: string };

export type HookDecision = { block: false } | { block: true; ruleId: string; reason: string };

const ALLOW: HookDecision = { block: false };
const PROTECTED = 'protected_path';

// Commands whose path arguments they write to.
const WRITERS = new Set(['cp', 'mv', 'tee', 'rm', 'rmdir', 'mkdir', 'touch', 'ln', 'chmod', 'chown', 'install', 'rsync', 'sed', 'perl', 'truncate', 'dd', 'unzip', 'tar', 'git']);

export function evaluateToolCall(policy: Policy, input: HookInput): HookDecision {
  const cwd = input.cwd ?? process.cwd();
  switch (input.tool_name) {
    case 'Bash':
      return evaluateBash(policy, stringField(input, 'command'), cwd);
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
      return evaluateWrite(policy, stringField(input, 'file_path'), cwd);
    case 'NotebookEdit':
      // The docs don't name NotebookEdit's path field; accept either spelling.
      return evaluateWrite(policy, stringField(input, 'notebook_path', 'file_path'), cwd);
    case 'Read':
      return evaluateRead(policy, stringField(input, 'file_path'), cwd);
    default:
      return ALLOW;
  }
}

class BadInput extends Error {}

function stringField(input: HookInput, ...names: string[]): string {
  for (const name of names) {
    const value = input.tool_input?.[name];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  throw new BadInput(`${input.tool_name} call without ${names.join(' or ')}`);
}

/** Thrown for tool input the hook can't evaluate; the guard blocks on it. */
export { BadInput as MalformedToolInput };

function evaluateBash(policy: Policy, command: string, cwd: string): HookDecision {
  const parsed = parseCommand(command);
  if (!parsed.ok) {
    return { block: true, ruleId: 'malformed_command', reason: `rnship: can't parse this command (${parsed.error}), so it is blocked` };
  }
  for (const simple of parsed.commands) {
    for (const rule of policy.rules) {
      if (rule.effect === 'allow') continue;
      const pattern = rule.match.commands.find((p) => matchesCommandPattern(p, simple.words));
      if (pattern) return blocked(rule, `\`${simple.words.join(' ')}\` matches \`${pattern}\``);
    }
    for (const path of writtenPaths(simple)) {
      const decision = evaluateWrite(policy, path, cwd);
      if (decision.block) return decision;
    }
    for (const word of simple.words.slice(1)) {
      if (word.startsWith('-')) continue;
      const decision = evaluateRead(policy, word, cwd);
      if (decision.block) return decision;
    }
  }
  return ALLOW;
}

function writtenPaths(command: SimpleCommand): string[] {
  const [name, ...args] = command.words;
  const paths = [...command.writes];
  if (name && WRITERS.has(name)) paths.push(...args.filter((a) => !a.startsWith('-')));
  return paths;
}

function evaluateWrite(policy: Policy, path: string, cwd: string): HookDecision {
  const candidates = pathCandidates(path, cwd);
  for (const glob of PROTECTED_PATHS) {
    if (candidates.some((p) => matchesGlob(p, glob) || matchesGlob(p, `**/${glob}`))) {
      return {
        block: true,
        ruleId: PROTECTED,
        reason: `rnship: ${path} is under ${glob}, which the executor may never change. Stop and report what you needed.`,
      };
    }
  }
  return fileRule(policy, candidates, path, () => true);
}

function evaluateRead(policy: Policy, path: string, cwd: string): HookDecision {
  return fileRule(policy, pathCandidates(path, cwd), path, (rule) => rule.effect === 'deny');
}

function fileRule(policy: Policy, candidates: string[], path: string, applies: (rule: Rule) => boolean): HookDecision {
  for (const rule of policy.rules) {
    if (rule.effect === 'allow' || !applies(rule)) continue;
    const glob = rule.match.files.find((g) => candidates.some((p) => matchesGlob(p, g) || matchesGlob(p, `**/${g}`)));
    if (glob) return blocked(rule, `${path} matches \`${glob}\``);
  }
  return ALLOW;
}

// The path as given, and relative to the session's working directory when it is inside it.
function pathCandidates(path: string, cwd: string): string[] {
  const out = [path];
  if (isAbsolute(path)) {
    const rel = relative(cwd, path);
    if (!rel.startsWith('..') && !isAbsolute(rel)) out.push(rel);
  } else if (path.startsWith('./')) {
    out.push(path.slice(2));
  }
  return out;
}

function blocked(rule: Rule, what: string): HookDecision {
  const action =
    rule.effect === 'deny'
      ? 'This is denied by policy.'
      : 'This needs a human approval outside this session. Stop and report that the task is waiting for approval.';
  return { block: true, ruleId: rule.id, reason: `rnship: rule ${rule.id} (${rule.category}): ${what}. ${action}` };
}

// A command pattern matches the command line as a glob (`eas submit*`), or token-wise:
// its leading words match the command's leading words and each `--flag value` pair
// appears somewhere in the command, in any order.
export function matchesCommandPattern(pattern: string, words: string[]): boolean {
  if (globToRegExp(pattern).test(words.join(' '))) return true;
  const parts = pattern.split(/\s+/).filter(Boolean);
  let i = 0;
  for (; i < parts.length && !parts[i]!.startsWith('-'); i++) {
    if (words[i] === undefined || !globToRegExp(parts[i]!).test(words[i]!)) return false;
  }
  if (i === parts.length) return false;
  while (i < parts.length) {
    const flag = parts[i]!;
    const value = parts[i + 1] !== undefined && !parts[i + 1]!.startsWith('-') ? parts[i + 1] : undefined;
    const found = words.some(
      (w, k) => globToRegExp(flag).test(w) && (value === undefined || (words[k + 1] !== undefined && globToRegExp(value).test(words[k + 1]!))),
    );
    if (!found) return false;
    i += value === undefined ? 1 : 2;
  }
  return true;
}
