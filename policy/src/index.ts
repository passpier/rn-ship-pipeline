import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { PolicySchema, type Policy } from './schema.ts';

export { changedGates, type Gate, type ProjectState } from './changes.ts';
export { compilePolicy, PROTECTED_PATHS, type ClaudeSettings, type CompiledPolicy } from './compile.ts';
export { mergePolicy, type MergeError, type MergeResult } from './merge.ts';
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
