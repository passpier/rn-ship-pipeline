#!/usr/bin/env node
// A stand-in for `claude -p --output-format stream-json`, driven by $STUB_SCENARIO (a JSON
// file). Each invocation takes the next entry of `calls` (counted in <scenario>.count):
//   done      tick the first unfinished task's boxes, commit, and signal (ALL_TASKS_DONE when none is left)
//   fail      signal TASK_FAILED
//   limit     a five-hour rate-limit rejection; limit_weekly is the seven-day one
//   denied    like done, plus a permission denial in the result
// `init` is ok (guard plugin loaded), no_plugin or plugin_error. Review prompts get REVIEW_DONE.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

type Scenario = { init?: 'ok' | 'no_plugin' | 'plugin_error'; calls?: string[]; resetsAt?: number };

const scenarioPath = process.env.STUB_SCENARIO!;
const scenario = JSON.parse(readFileSync(scenarioPath, 'utf8')) as Scenario;
const countPath = `${scenarioPath}.count`;
const n = existsSync(countPath) ? Number(readFileSync(countPath, 'utf8')) : 0;
writeFileSync(countPath, String(n + 1));
const action = scenario.calls?.[n] ?? 'done';

const argv = process.argv.slice(2);
const model = argv[argv.indexOf('--model') + 1] ?? 'unknown';
const promptFlag = argv.indexOf('-p');
const prompt = promptFlag >= 0 ? argv[promptFlag + 1]! : readFileSync(0, 'utf8');

const emit = (event: unknown) => process.stdout.write(JSON.stringify(event) + '\n');
const say = (text: string) => emit({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const result = (extra: Record<string, unknown> = {}) =>
  emit({ type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: { input_tokens: 10, output_tokens: 5 }, permission_denials: [], ...extra });

const init = scenario.init ?? 'ok';
emit({
  type: 'system',
  subtype: 'init',
  model,
  plugins: init === 'no_plugin' ? [] : [{ name: 'rnship', path: '/plugin' }],
  plugin_errors: init === 'plugin_error' ? [{ plugin: 'rnship', error: 'bad hooks.json' }] : [],
});

if (action === 'limit' || action === 'limit_weekly') {
  const weekly = action === 'limit_weekly';
  emit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: weekly ? 'seven_day' : 'five_hour', resetsAt: scenario.resetsAt } });
  const text = weekly ? "You've hit your weekly limit · resets 1pm" : "You've hit your session limit · resets 3pm";
  emit({ type: 'assistant', message: { content: [{ type: 'text', text }] }, error: 'rate_limit', is_api_error_message: true });
  emit({ type: 'result', subtype: 'success', is_error: true, result: text, api_error_status: 429 });
  process.exit(1);
}

const planPath = /Read the plan file at (\S+?\.md)/.exec(prompt)?.[1];
if (!planPath) {
  // The probe, or a review pass.
  if (prompt !== 'ok') say('<<<RALPHEX:REVIEW_DONE>>>');
  result();
  process.exit(0);
}
if (action === 'fail') {
  say('<<<RALPHEX:TASK_FAILED>>>');
  result();
  process.exit(0);
}

// Tick the boxes of the first task section that still has an open one, then commit.
const lines = readFileSync(planPath, 'utf8').split('\n');
let task: string | undefined;
let current: string | undefined;
for (let i = 0; i < lines.length; i++) {
  const line = lines[i]!;
  const header = /^### Task (\d+):/.exec(line);
  if (header || /^#{1,2}\s/.test(line)) {
    if (task) break;
    current = header?.[1];
    continue;
  }
  if (current && line.startsWith('- [ ]')) {
    task = current;
    lines[i] = line.replace('- [ ]', '- [x]');
  }
}
writeFileSync(planPath, lines.join('\n'));
if (task) {
  mkdirSync('stub', { recursive: true });
  writeFileSync(join('stub', `${basename(planPath, '.md')}-task-${task}.txt`), `task ${task}\n`);
  execFileSync('git', ['add', 'stub']);
  execFileSync('git', ['-c', 'user.email=stub@example.com', '-c', 'user.name=stub', 'commit', '-q', '-m', `feat: task ${task}`]);
}
const remaining = lines.some((l) => l.startsWith('- [ ]'));
say(remaining ? `finished task ${task}` : '<<<RALPHEX:ALL_TASKS_DONE>>>');
result(action === 'denied' ? { permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'npm install left-pad' } }] } : {});
