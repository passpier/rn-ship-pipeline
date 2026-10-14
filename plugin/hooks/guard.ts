#!/usr/bin/env node
// PreToolUse guard. Reads the hook event on stdin and the compiled rules from
// $RNSHIP_HOOK_RULES (`rnship policy compile` writes hook-rules.json and points the
// executor settings at it). Exit 2 blocks the call and feeds stderr back to Claude.
// Every failure blocks: bad stdin, missing rules, or a crash (fail closed).
import { readFileSync } from 'node:fs';
import { evaluateToolCall, type HookInput } from '../../policy/src/hook.ts';
import type { Policy } from '../../policy/src/schema.ts';

function block(reason: string): never {
  process.stderr.write(reason.endsWith('\n') ? reason : `${reason}\n`);
  process.exit(2);
}

try {
  const rulesPath = process.env.RNSHIP_HOOK_RULES;
  if (!rulesPath) block('rnship guard: RNSHIP_HOOK_RULES is not set, so every tool call is blocked');
  const policy = JSON.parse(readFileSync(rulesPath, 'utf8')) as Policy;
  if (!Array.isArray(policy?.rules)) block(`rnship guard: ${rulesPath} has no rules array`);

  let input: HookInput;
  try {
    input = JSON.parse(readFileSync(0, 'utf8')) as HookInput;
  } catch {
    block('rnship guard: hook input is not valid JSON');
  }
  if (typeof input?.tool_name !== 'string' || typeof input.tool_input !== 'object' || input.tool_input === null) {
    block('rnship guard: hook input has no tool_name or tool_input');
  }

  const decision = evaluateToolCall(policy, input);
  if (decision.block) block(decision.reason);
  process.exit(0);
} catch (error) {
  block(`rnship guard: ${error instanceof Error ? error.message : String(error)}`);
}
