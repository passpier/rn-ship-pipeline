import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModelSpec } from '@rnship/policy';
import type { LimitKind, ProbeResult } from '../executor.ts';
import { CLAUDE_LIMIT_PATTERNS, combine, limitKindOf, matchPattern, summarize, type StreamSummary } from '../streamJson.ts';

// What every live adapter shares: the ADR 0002 flags, starting Claude (or a runner that
// starts it) through the shim, reading the shim's transcripts, and the quota probe.

export const SHIM = fileURLToPath(new URL('../../bin/claude-shim.ts', import.meta.url));

/** Claude Code session markers ralphex v1.7.0 strips from claude's env; we strip them too. */
const SESSION_ENV = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
];

export type Env = Record<string, string | undefined>;

export type SessionOptions = {
  /** The real claude command the shim runs. */
  claude?: string;
  /** The guard plugin dir (`plugin/`), always loaded. */
  pluginDir: string;
  /** Optional knowledge plugins, e.g. plugins/rn-game. */
  extraPluginDirs?: string[];
  /** The compiled executor-settings.json (ADR 0002: a file, never inline JSON). */
  settingsFile: string;
  guardPlugin?: string;
  /** Per-run files (plans, prompts, transcripts) go here. */
  workDir: string;
  /** Limit patterns beyond Claude Code's known ones (from S4). */
  extraLimitPatterns?: string[];
  env?: Env;
};

/** Flags every Claude session gets. */
export function claudeArgs(opts: SessionOptions): string[] {
  return [
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'dontAsk',
    '--plugin-dir',
    opts.pluginDir,
    ...(opts.extraPluginDirs ?? []).flatMap((dir) => ['--plugin-dir', dir]),
    '--settings',
    opts.settingsFile,
    '--setting-sources',
    'user',
  ];
}

export function limitPatterns(opts: SessionOptions): string[] {
  return [...CLAUDE_LIMIT_PATTERNS, ...(opts.extraLimitPatterns ?? [])];
}

export type SessionRun = { code: number; output: string; aborted: boolean; idle: boolean };

/**
 * Runs `command` in its own process group with the shim's env. An abort, or no output for
 * `idleTimeoutSec`, stops the whole group with SIGTERM (never SIGQUIT: S8 X1). Without
 * `stdin`, stdin is /dev/null, so nothing can wait on input.
 */
export function spawnSession(
  opts: SessionOptions,
  command: string,
  args: string[],
  run: { cwd: string; transcripts: string; signal: AbortSignal; stdin?: string; idleTimeoutSec?: number },
): Promise<SessionRun> {
  const env: Env = { ...process.env, ...opts.env };
  for (const name of SESSION_ENV) delete env[name];
  env.RNSHIP_CLAUDE = opts.claude ?? env.RNSHIP_CLAUDE ?? 'claude';
  env.RNSHIP_TRANSCRIPTS = run.transcripts;
  env.RNSHIP_GUARD_PLUGIN = opts.guardPlugin ?? 'rnship';
  const child = spawn(command, args, { cwd: run.cwd, env, stdio: [run.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], detached: true });
  if (child.stdin) {
    child.stdin.on('error', () => {});
    child.stdin.end(run.stdin);
  }

  let output = '';
  let aborted = false;
  let idle = false;
  const stopGroup = () => {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
  };
  let idleTimer: NodeJS.Timeout | undefined;
  const armIdle = () => {
    if (run.idleTimeoutSec === undefined) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idle = true;
      stopGroup();
    }, run.idleTimeoutSec * 1000);
  };
  const onData = (chunk: Buffer) => {
    output += chunk.toString('utf8');
    armIdle();
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  armIdle();
  const stop = () => {
    aborted = true;
    stopGroup();
  };
  if (run.signal.aborted) stop();
  else run.signal.addEventListener('abort', stop, { once: true });
  return new Promise((resolve) => {
    const done = (result: SessionRun) => {
      clearTimeout(idleTimer);
      run.signal.removeEventListener('abort', stop);
      resolve(result);
    };
    child.once('error', (error) => done({ code: 127, output: `${output}\n${error.message}`, aborted, idle }));
    child.once('close', (code, sig) => done({ code: code ?? (sig ? 128 : 1), output, aborted, idle }));
  });
}

export function readTranscripts(dir: string): StreamSummary {
  if (!existsSync(dir)) return combine([]);
  return combine(readdirSync(dir).sort().map((file) => summarize(readFileSync(join(dir, file), 'utf8'))));
}

export function limitIn(text: string, patterns: string[]): { kind: LimitKind; resetAt?: string } | undefined {
  const hit = matchPattern(text, patterns);
  return hit ? { kind: limitKindOf(hit) } : undefined;
}

export const timedOut = (signal: AbortSignal) => signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError';

/** `claude -p "ok" --max-turns 1` through the shim: is the quota open again? */
export async function probeQuota(opts: SessionOptions, model: ModelSpec): Promise<ProbeResult> {
  mkdirSync(opts.workDir, { recursive: true });
  const transcripts = join(mkdtempSync(join(opts.workDir, 'probe-')), 'transcripts');
  const args = ['-p', 'ok', '--model', model.id, '--max-turns', '1', ...claudeArgs(opts)];
  const run = await spawnSession(opts, SHIM, args, { cwd: opts.workDir, transcripts, signal: AbortSignal.timeout(120_000) });
  const summary = readTranscripts(transcripts);
  const limit = summary.rateLimit ?? limitIn([run.output, ...summary.errors].join('\n'), limitPatterns(opts));
  if (limit) return { ok: false, resetAt: limit.resetAt, limitKind: limit.kind };
  // Anything else that went wrong is also "not open yet": park until the next probe (design §4).
  return run.code === 0 ? { ok: true } : { ok: false, limitKind: 'unknown' };
}
