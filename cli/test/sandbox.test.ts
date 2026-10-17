import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { connect as connectTcp, createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { seatbeltProfile } from '@rnship/policy';
import { startProxy } from '../src/sandbox.ts';

const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));

function connectThrough(port: number, target: string): Promise<number> {
  return new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, method: 'CONNECT', path: target })
      .on('connect', (res, socket) => {
        socket.destroy();
        resolve(res.statusCode ?? 0);
      })
      .on('error', reject)
      .end();
  });
}

describe('allowlisting proxy', () => {
  it('tunnels to allowlisted hosts and refuses others, reporting each refusal', async () => {
    const upstream = createTcpServer((socket) => socket.end('hi')).listen(0, '127.0.0.1');
    await new Promise((r) => upstream.once('listening', r));
    const upstreamPort = (upstream.address() as { port: number }).port;
    const refused: string[] = [];
    const proxy = await startProxy(['127.0.0.1'], (target) => refused.push(target));
    try {
      expect(await connectThrough(proxy.port, `127.0.0.1:${upstreamPort}`)).toBe(200);
      expect(await connectThrough(proxy.port, 'evil.example.com:443')).toBe(403);
      expect(refused).toEqual(['evil.example.com:443']);
    } finally {
      await proxy.close();
      upstream.close();
    }
  });

  it('survives a client that resets after its 403', async () => {
    const proxy = await startProxy(['127.0.0.1'], () => {});
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = connectTcp(proxy.port, '127.0.0.1', () => socket.write('CONNECT evil.example.com:443 HTTP/1.1\r\n\r\n'));
        socket.once('data', () => {
          socket.resetAndDestroy();
          resolve();
        });
        socket.once('error', reject);
      });
      await new Promise((r) => setTimeout(r, 50));
      expect(await connectThrough(proxy.port, 'evil.example.com:443')).toBe(403);
    } finally {
      await proxy.close();
    }
  });
});

describe('seatbelt profile', () => {
  it('opens the home under /Users before the secret denies, so they still win', () => {
    const profile = seatbeltProfile({ home: '/Users/rnship-test-agent' });
    const open = profile.indexOf('(allow file-read*\n  (subpath "/Users/rnship-test-agent")');
    expect(open).toBeGreaterThan(profile.indexOf('(deny file-read* (subpath "/Users"))'));
    expect(profile.indexOf('(subpath "/Users/rnship-test-agent/.expo")')).toBeGreaterThan(open);
  });
});

// Acceptance (f). sandbox-exec is macOS-only, so CI (ubuntu) skips this; run it locally.
describe.skipIf(process.platform !== 'darwin')('rnship sandbox run', () => {
  const home = mkdtempSync(join(tmpdir(), 'rnship-home-'));
  mkdirSync(join(home, '.expo'));
  writeFileSync(join(home, '.expo', 'state.json'), '{"auth":{"sessionSecret":"fake"}}');
  const work = mkdtempSync(join(tmpdir(), 'rnship-work-'));
  writeFileSync(join(work, 'source.js'), 'ok');

  // Agent-written test code, as jest would run it.
  const sandboxed = (script: string) =>
    spawnSync(process.execPath, [MAIN, 'sandbox', 'run', '--', process.execPath, '-e', script], {
      cwd: work,
      encoding: 'utf8',
      env: { ...process.env, HOME: home },
    });

  it('blocks reading ~/.expo', () => {
    const run = sandboxed(`require('fs').readFileSync(require('path').join(require('os').homedir(), '.expo/state.json'))`);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('EPERM');
  });

  it('blocks writing guardrail config under ~/.claude', () => {
    const run = sandboxed(`const p=require('path').join(require('os').homedir(),'.claude');require('fs').mkdirSync(p,{recursive:true});require('fs').writeFileSync(p+'/settings.json','{}')`);
    expect(run.status).not.toBe(0);
  });

  it('blocks a direct connection to a non-allowlisted host', () => {
    const run = sandboxed(`require('net').connect(443,'1.1.1.1').on('connect',()=>process.exit(0)).on('error',(e)=>{console.error(e.code);process.exit(3)})`);
    expect(run.status).toBe(3);
    expect(run.stderr).toContain('EPERM');
  });

  it('refuses a non-allowlisted host through the proxy', () => {
    const run = sandboxed(
      `const u=new URL(process.env.HTTPS_PROXY);require('http').request({host:u.hostname,port:u.port,method:'CONNECT',path:'evil.example.com:443'}).on('connect',(r,s)=>{s.destroy();process.exit(r.statusCode===403?4:0)}).on('error',()=>process.exit(5)).end()`,
    );
    expect(run.status).toBe(4);
    expect(run.stderr).toContain('rnship sandbox: refused evil.example.com:443');
  });

  it("blocks reading another user's home", () => {
    // This checkout sits in your home, which is neither the sandbox's home nor its cwd.
    const run = sandboxed(`require('fs').readFileSync(${JSON.stringify(fileURLToPath(new URL('../../package.json', import.meta.url)))})`);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('EPERM');
  });

  it('blocks listing mounted volumes and system keychains, but reads the CA keychain', () => {
    for (const dir of ['/Volumes', '/Library/Keychains']) {
      const run = sandboxed(`require('fs').readdirSync(${JSON.stringify(dir)})`);
      expect(run.stderr, dir).toContain('EPERM');
    }
    expect(sandboxed(`require('fs').readFileSync('/Library/Keychains/System.keychain')`).status).toBe(0);
  });

  it('lets the command read and write its worktree', () => {
    const run = sandboxed(`const fs=require('fs');fs.readFileSync('source.js');fs.writeFileSync('out.txt','built')`);
    expect(run.status).toBe(0);
  });
});
