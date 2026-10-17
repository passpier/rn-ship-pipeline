import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { PolicySchema, type Policy } from './schema.ts';

export { changedGates, globToRegExp, type Gate, type ProjectState } from './changes.ts';
export {
  compilePolicy,
  GUARD_PLUGIN_ID,
  PROTECTED_PATHS,
  type ClaudeSettings,
  type CompiledPolicy,
  type ExecutorSettings,
} from './compile.ts';
export { evaluateToolCall, matchesCommandPattern, type HookDecision, type HookInput } from './hook.ts';
export { mergePolicy, type MergeError, type MergeResult } from './merge.ts';
export {
  claudeSandboxSettings,
  hostAllowed,
  NETWORK_ALLOWLIST,
  PERSISTENCE_PATHS,
  SANDBOX_ENV,
  SECRET_PATHS,
  seatbeltProfile,
} from './sandbox.ts';
export { escalate, loadRouting, parseRouting, RoutingSchema, TIERS, type ModelSpec, type Routing, type Tier } from './routing.ts';
export { parseCommand, type ParsedCommand, type SimpleCommand } from './shell.ts';
export { CATEGORIES, EFFECT_ORDER, type Effect, type Match, type Policy, type Rule } from './schema.ts';

export function parsePolicy(yamlText: string): Policy {
  return PolicySchema.parse(parse(yamlText));
}

export function loadPolicy(path: string | URL): Policy {
  return parsePolicy(readFileSync(path, 'utf8'));
}

export function loadBasePolicy(): Policy {
  return loadPolicy(new URL('../base.yaml', import.meta.url));
}
