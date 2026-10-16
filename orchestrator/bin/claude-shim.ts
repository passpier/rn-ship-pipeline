#!/usr/bin/env node
// The claude command for any executor (ralphex: `claude_command`). Runs the real claude
// ($RNSHIP_CLAUDE, default `claude`) with the same argv and stdin, passes its stream-json
// through to the caller, and keeps a copy in $RNSHIP_TRANSCRIPTS. It fails closed on the first `system/init` event: if the guard
// plugin ($RNSHIP_GUARD_PLUGIN, default `rnship`) isn't loaded or a plugin failed to load,
// it kills claude before any tool call and prints PLUGIN_MISSING, which the ralphex adapter
// puts in `claude_error_patterns` (S2 T3f, S8).
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkInit, initOf, parseLine, PLUGIN_MISSING } from '../src/streamJson.ts';

const claude = process.env.RNSHIP_CLAUDE || 'claude';
const guard = process.env.RNSHIP_GUARD_PLUGIN || 'rnship';
const dir = process.env.RNSHIP_TRANSCRIPTS;
if (!dir) {
  console.log(`${PLUGIN_MISSING}: RNSHIP_TRANSCRIPTS is not set`);
  process.exit(1);
}
mkdirSync(dir, { recursive: true });
const transcript = createWriteStream(join(dir, `${Date.now()}-${process.pid}.jsonl`), { flags: 'wx' });

const child = spawn(claude, process.argv.slice(2), { stdio: ['pipe', 'pipe', 'inherit'] });
process.stdin.pipe(child.stdin);
child.stdin.on('error', () => {});

let initChecked = false;
let refused = false;
let buffered = '';
child.stdout.on('data', (chunk: Buffer) => {
  if (refused) return;
  transcript.write(chunk);
  buffered += chunk.toString('utf8');
  const lines = buffered.split('\n');
  buffered = lines.pop() ?? '';
  for (const line of lines) {
    if (!initChecked) {
      const init = initOf(parseLine(line.trim()) ?? {});
      if (init) {
        initChecked = true;
        const check = checkInit(init, guard);
        if (!check.ok) return refuse(check.reason);
      }
    }
    process.stdout.write(line + '\n');
  }
});

function refuse(reason: string): void {
  refused = true;
  child.kill('SIGTERM');
  process.stdout.write(`${PLUGIN_MISSING}: ${reason}\n`);
}

child.on('error', (error) => {
  process.stdout.write(`rnship claude-shim: can't run ${claude}: ${error.message}\n`);
  transcript.end(() => process.exit(1));
});
child.on('close', (code, signal) => {
  if (!refused && buffered) process.stdout.write(buffered);
  // A session that exits cleanly without ever reporting init can't be trusted either.
  if (!refused && !initChecked && code === 0) refuse('no system/init event');
  transcript.end(() => process.exit(refused ? 1 : (code ?? (signal ? 128 : 1))));
});
