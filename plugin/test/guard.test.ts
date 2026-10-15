import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compilePolicy, loadBasePolicy } from '@rnship/policy';

const GUARD = fileURLToPath(new URL('../hooks/guard.ts', import.meta.url));

const rules = join(mkdtempSync(join(tmpdir(), 'rnship-guard-')), 'hook-rules.json');
writeFileSync(rules, JSON.stringify(compilePolicy(loadBasePolicy()).hookRules));

function guard(stdin: string, env: Record<string, string | undefined> = { RNSHIP_HOOK_RULES: rules }) {
  const run = spawnSync(process.execPath, [GUARD], { input: stdin, encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
  return { code: run.status, stderr: run.stderr };
}

const bashEvent = (command: string) =>
  JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: '/work/app' });

describe('guard hook', () => {
  it('exits 2 for eas submit wrapped in sh -c', () => {
    const run = guard(bashEvent('sh -c "eas submit"'));
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('store.release');
  });

  it('exits 2 on malformed stdin', () => {
    expect(guard('{not json').code).toBe(2);
    expect(guard('{}').code).toBe(2);
    expect(guard(JSON.stringify({ tool_name: 'Bash', tool_input: {} })).code).toBe(2);
  });

  it('exits 2 when the rules file is missing', () => {
    expect(guard(bashEvent('eas whoami'), {}).code).toBe(2);
    expect(guard(bashEvent('eas whoami'), { RNSHIP_HOOK_RULES: '/nonexistent/hook-rules.json' }).code).toBe(2);
  });

  it('exits 0 for an allowed command', () => {
    expect(guard(bashEvent('eas whoami'))).toEqual({ code: 0, stderr: '' });
  });

  it('is wired as a blocking PreToolUse hook', () => {
    const hooks = JSON.parse(readFileSync(fileURLToPath(new URL('../hooks/hooks.json', import.meta.url)), 'utf8'));
    const [entry] = hooks.hooks.PreToolUse;
    expect(entry.matcher.split('|')).toEqual(expect.arrayContaining(['Bash', 'Edit', 'Write', 'Read']));
    expect(entry.hooks[0]).toMatchObject({ type: 'command', onFailure: 'block' });
  });
});
