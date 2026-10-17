import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { hostAllowed, NETWORK_ALLOWLIST, SANDBOX_ENV, seatbeltProfile } from '@rnship/policy';

// `rnship sandbox run -- <command>`: runs a validation command (tsc, jest, expo export,
// …) under `sandbox-exec` with the Seatbelt profile from policy/src/sandbox.ts. The
// profile allows outbound network to localhost only; this process runs a CONNECT
// proxy there that tunnels to allowlisted hosts, and points the child at it. Each
// refused target goes to stderr, so a failed build shows which hosts it needed.

export type Proxy = { port: number; close(): Promise<void> };

export function startProxy(
  allowlist: string[] = NETWORK_ALLOWLIST,
  onRefused: (target: string) => void = (target) => process.stderr.write(`rnship sandbox: refused ${target}\n`),
): Promise<Proxy> {
  const server: Server = createServer((req, res) => {
    onRefused(req.headers.host ?? req.url ?? '?');
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('rnship sandbox: only HTTPS (CONNECT) to allowlisted hosts is proxied\n');
  });
  server.on('connect', (req, client, head) => {
    // A client that resets after its 403 (curl does) must not crash the proxy.
    client.on('error', () => client.destroy());
    const target = parseTarget(req.url ?? '');
    if (!target || !hostAllowed(target.host, allowlist)) {
      onRefused(req.url ?? '?');
      client.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\nrnship sandbox: ${req.url} is not on the network allowlist\n`);
      return;
    }
    const upstream = connect(target.port, target.host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
    client.on('error', () => upstream.destroy());
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') return reject(new Error('proxy has no port'));
      resolve({
        port: address.port,
        close: () => new Promise((done) => {
          server.closeAllConnections();
          server.close(() => done());
        }),
      });
    });
  });
}

function parseTarget(url: string): { host: string; port: number } | undefined {
  const m = /^\[?([^\]]+?)\]?:(\d+)$/.exec(url);
  return m ? { host: m[1]!, port: Number(m[2]) } : undefined;
}

/** Exit code of a run stopped by `timeoutSec`, as coreutils `timeout` uses. */
export const TIMED_OUT = 124;

export async function sandboxRun(
  command: string[],
  opts: { home: string; cwd?: string; allowlist?: string[]; timeoutSec?: number },
): Promise<number> {
  if (process.platform !== 'darwin') throw new Error('rnship sandbox run needs macOS sandbox-exec');
  if (command.length === 0) throw new Error('no command to run');
  const dir = mkdtempSync(join(tmpdir(), 'rnship-sandbox-'));
  const profile = join(dir, 'profile.sb');
  // Under /Users only the home, the worktree and the Node install rnship runs on stay
  // readable: validation commands run on that same toolchain.
  const toolchain = dirname(dirname(realpathSync(process.execPath)));
  writeFileSync(profile, seatbeltProfile({ home: opts.home, readable: [opts.cwd ?? process.cwd(), toolchain] }));
  const proxy = await startProxy(opts.allowlist);
  const url = `http://127.0.0.1:${proxy.port}`;
  try {
    // With a timeout the command gets its own process group, so the whole tree can be stopped.
    const child = spawn('sandbox-exec', ['-f', profile, ...command], {
      cwd: opts.cwd,
      stdio: 'inherit',
      detached: opts.timeoutSec !== undefined,
      env: {
        ...process.env,
        ...SANDBOX_ENV,
        HTTPS_PROXY: url,
        HTTP_PROXY: url,
        https_proxy: url,
        http_proxy: url,
        NO_PROXY: 'localhost,127.0.0.1',
        NODE_USE_ENV_PROXY: '1',
      },
    });
    return await new Promise<number>((resolve, reject) => {
      let timedOut = false;
      const timers: NodeJS.Timeout[] = [];
      const stop = (signal: NodeJS.Signals) => {
        try {
          process.kill(-child.pid!, signal);
        } catch {
          // The group is already gone.
        }
      };
      if (opts.timeoutSec !== undefined) {
        timers.push(
          setTimeout(() => {
            timedOut = true;
            process.stderr.write(`rnship sandbox: stopped after ${opts.timeoutSec}s\n`);
            stop('SIGTERM');
            timers.push(setTimeout(() => stop('SIGKILL'), 5000));
          }, opts.timeoutSec * 1000),
        );
      }
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        timers.forEach(clearTimeout);
        if (timedOut) stop('SIGKILL');
        resolve(timedOut ? TIMED_OUT : (code ?? (signal ? 128 : 1)));
      });
    });
  } finally {
    await proxy.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
