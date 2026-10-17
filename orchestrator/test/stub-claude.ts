#!/usr/bin/env node
// A stand-in for `claude -p --output-format stream-json`, driven by $STUB_SCENARIO (a JSON
// file). Each invocation takes the next entry of `calls` (counted in <scenario>.count):
//   done      tick the first unfinished task's boxes, commit, and signal (ALL_TASKS_DONE when none is left)
//   fail      signal TASK_FAILED
//   limit     a five-hour rate-limit rejection; limit_weekly is the seven-day one
//   commit_then_limit  (claude-p) commit partial work for the task, then the five-hour limit
//   denied    like done, plus a permission denial in the result
//   signal_in_text  (claude-p) the done signal in assistant text only, not in the final result
//   dirty     (claude-p) write the task's file but leave it uncommitted
//   noop      (claude-p) change nothing and still signal done
//   hang      print init, then nothing for 10 s
//   wrong_model  init reports another model than --model
//   api500    an API Error: 500 result
// `init` is ok (guard plugin loaded), no_plugin or plugin_error. Review prompts get REVIEW_DONE.
// With `permissions: "enforce"`, a task session applies --permission-mode dontAsk the way
// Claude Code does: unless allow rules (the --settings file's or --allowedTools) cover its
// writes in the worktree, Bash, and (ralphex) the plan file, they're denied and it gives up.
// Prompts that start with `# rnship task: <key>` (the claude-p adapter) get the work done
// for that key and the signal in the final result, as a real session would end.
// Prompts that start with `# rnship intake: <stage>` (Flow A's single calls) get the next
// answer from `intake[<stage>]` as `structured_output`, or `"limit"` for the five-hour limit.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

type Scenario = {
  init?: 'ok' | 'no_plugin' | 'plugin_error';
  calls?: string[];
  resetsAt?: number;
  permissions?: 'enforce';
  intake?: Record<string, unknown[]>;
};

const scenarioPath = process.env.STUB_SCENARIO!;
const scenario = JSON.parse(readFileSync(scenarioPath, 'utf8')) as Scenario;
const countPath = `${scenarioPath}.count`;
const n = existsSync(countPath) ? Number(readFileSync(countPath, 'utf8')) : 0;
writeFileSync(countPath, String(n + 1));
const action = scenario.calls?.[n] ?? 'done';

const argv = process.argv.slice(2);
const model = argv[argv.lastIndexOf('--model') + 1] ?? 'unknown';
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
  model: action === 'wrong_model' ? 'claude-substitute-0' : model,
  plugins: init === 'no_plugin' ? [] : [{ name: 'rnship', path: '/plugin' }],
  plugin_errors: init === 'plugin_error' ? [{ plugin: 'rnship', error: 'bad hooks.json' }] : [],
  stub_argv: argv,
  stub_prompt: prompt,
});

const intakeStage = /^# rnship intake: (\S+)/.exec(prompt)?.[1];
if (intakeStage) {
  const answers = scenario.intake?.[intakeStage] ?? [];
  const countFile = `${scenarioPath}.${intakeStage}.count`;
  const i = existsSync(countFile) ? Number(readFileSync(countFile, 'utf8')) : 0;
  writeFileSync(countFile, String(i + 1));
  const answer = answers[Math.min(i, answers.length - 1)];
  if (answer === 'limit') {
    emit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: scenario.resetsAt } });
    emit({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your session limit · resets 3pm", api_error_status: 429 });
    process.exit(1);
  }
  result({ result: JSON.stringify(answer ?? {}), structured_output: answer });
  process.exit(0);
}

const taskKey = /^# rnship task: (\S+)/.exec(prompt)?.[1];
const planPath = /Read the plan file at (\S+?\.md)/.exec(prompt)?.[1];

if (scenario.permissions === 'enforce' && argv[argv.indexOf('--permission-mode') + 1] === 'dontAsk') {
  const settings = JSON.parse(readFileSync(argv[argv.indexOf('--settings') + 1]!, 'utf8')) as { permissions?: { allow?: string[] } };
  const allowed = [...(settings.permissions?.allow ?? []), ...argv.flatMap((arg, i) => (argv[i - 1] === '--allowedTools' ? arg.split(',') : []))];
  const needs = planPath ? ['Edit(./**)', 'Bash', `Edit(/${planPath})`] : taskKey ? ['Edit(./**)', 'Bash'] : [];
  const missing = needs.filter((rule) => !allowed.includes(rule));
  if (missing.length > 0) {
    const denials = missing.map((rule) => ({ tool_name: rule.split('(')[0], tool_input: rule === 'Bash' ? { command: 'git commit' } : { file_path: rule.slice(5, -1) } }));
    if (planPath) say('<<<RALPHEX:TASK_FAILED>>>');
    result({ result: `${missing.join(', ')} denied in dontAsk mode\n<<<RNSHIP:TASK_FAILED>>> nothing could be written`, permission_denials: denials });
    process.exit(0);
  }
}
const commit = (file: string, message: string) => {
  mkdirSync('stub', { recursive: true });
  writeFileSync(join('stub', file), `${message}\n`);
  execFileSync('git', ['add', 'stub']);
  execFileSync('git', ['-c', 'user.email=stub@example.com', '-c', 'user.name=stub', 'commit', '-q', '-m', message]);
};

if (action === 'commit_then_limit') commit(`${taskKey}-partial.txt`, `wip: ${taskKey}`);
if (action === 'limit' || action === 'limit_weekly' || action === 'commit_then_limit') {
  const weekly = action === 'limit_weekly';
  emit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: weekly ? 'seven_day' : 'five_hour', resetsAt: scenario.resetsAt } });
  const text = weekly ? "You've hit your weekly limit · resets 1pm" : "You've hit your session limit · resets 3pm";
  emit({ type: 'assistant', message: { content: [{ type: 'text', text }] }, error: 'rate_limit', is_api_error_message: true });
  emit({ type: 'result', subtype: 'success', is_error: true, result: text, api_error_status: 429 });
  process.exit(1);
}

if (action === 'hang') {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000);
  process.exit(0);
}
if (action === 'api500') {
  emit({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: 500 {"type":"error","error":{"type":"api_error"}}' });
  process.exit(1);
}

if (taskKey) {
  const denials = action === 'denied' ? [{ tool_name: 'Bash', tool_input: { command: 'npm install left-pad' } }] : [];
  if (action === 'fail') {
    result({ result: 'tests keep failing\n<<<RNSHIP:TASK_FAILED>>> jest: 2 failing' });
    process.exit(0);
  }
  if (action === 'dirty') {
    mkdirSync('stub', { recursive: true });
    writeFileSync(join('stub', `${taskKey}.txt`), 'uncommitted\n');
  } else if (action !== 'noop') {
    commit(`${taskKey}.txt`, `feat: ${taskKey}`);
  }
  if (action === 'signal_in_text') {
    say('<<<RNSHIP:TASK_DONE>>>');
    result({ result: 'stopped early' });
  } else {
    result({ result: `done ${taskKey}\n<<<RNSHIP:TASK_DONE>>>`, permission_denials: denials });
  }
  process.exit(0);
}
if (/^# rnship review: /.test(prompt)) {
  result({ result: 'looks good\n<<<RNSHIP:REVIEW_DONE>>>' });
  process.exit(0);
}

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
if (task) commit(`${basename(planPath, '.md')}-task-${task}.txt`, `feat: task ${task}`);
const remaining = lines.some((l) => l.startsWith('- [ ]'));
say(remaining ? `finished task ${task}` : '<<<RALPHEX:ALL_TASKS_DONE>>>');
result(action === 'denied' ? { permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'npm install left-pad' } }] } : {});
