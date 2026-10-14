import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

// One source for what agent-run code may not touch. Both the Claude Code sandbox
// (executor settings) and the validation sandbox (`sandbox-exec` around tsc, jest,
// expo export, …) are built from these lists.

/** Credentials and signing material: no reads, no writes. `~` is the running user's home. */
export const SECRET_PATHS = [
  '~/.expo',
  '~/.config/eas',
  '~/.config/gh',
  '~/.ssh',
  '~/.aws',
  '~/.gnupg',
  '~/.netrc',
  '~/Library/Keychains',
];

/** Places that would let agent code outlive the task or switch guardrails off (S2): no writes. */
export const PERSISTENCE_PATHS = [
  '~/.claude',
  '~/Library/LaunchAgents',
  '~/.zshrc',
  '~/.zprofile',
  '~/.bashrc',
  '~/.bash_profile',
  '~/.profile',
  '~/.gitconfig',
];

/** Hosts validation and Bash commands may reach: the npm registry, GitHub, and Expo. */
export const NETWORK_ALLOWLIST = [
  'registry.npmjs.org',
  'github.com',
  'api.github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'raw.githubusercontent.com',
  'api.expo.dev',
  'exp.host',
];

export function hostAllowed(host: string, allowlist: string[] = NETWORK_ALLOWLIST): boolean {
  const name = host.toLowerCase().replace(/\.$/, '');
  return allowlist.some((entry) => (entry.startsWith('*.') ? name.endsWith(entry.slice(1)) : name === entry));
}

/**
 * Settings for Claude Code's built-in Bash sandbox. Keys per the settings reference:
 * `sandbox.enabled`, `allowUnsandboxedCommands: false` (no unsandboxed retry), and
 * `failIfUnavailable` so a missing sandbox stops the run instead of running unsandboxed.
 */
export function claudeSandboxSettings() {
  return {
    enabled: true,
    allowUnsandboxedCommands: false,
    failIfUnavailable: true,
    filesystem: { denyRead: [...SECRET_PATHS], denyWrite: [...SECRET_PATHS, ...PERSISTENCE_PATHS] },
    network: { allowedDomains: [...NETWORK_ALLOWLIST] },
  };
}

/**
 * A `sandbox-exec` (Seatbelt) profile for validation commands. Everything is allowed
 * except reading or writing secrets, writing persistence paths, and outbound network
 * other than localhost. SBPL can't match hostnames, so allowlisted hosts are reached
 * through the localhost proxy that `rnship sandbox run` starts.
 */
export function seatbeltProfile(opts: { home: string }): string {
  const paths = (list: string[]) => list.map((p) => `  (subpath ${sbplString(realHomePath(p, opts.home))})`).join('\n');
  return `(version 1)
(allow default)
; Secrets: no reads, no writes.
(deny file-read* file-write*
${paths(SECRET_PATHS)})
; Persistence and guardrail config: no writes.
(deny file-write*
${paths(PERSISTENCE_PATHS)})
; Network: localhost (the allowlisting proxy) and unix sockets only.
(deny network-outbound)
(allow network-outbound (remote ip "localhost:*"))
(allow network-outbound (remote unix-socket))
`;
}

// Seatbelt matches resolved paths, so expand `~` and resolve symlinks such as /var → /private/var.
function realHomePath(path: string, home: string): string {
  const full = path.startsWith('~/') ? join(home, path.slice(2)) : path;
  if (existsSync(full)) return realpathSync(full);
  const parent = realHomePath(full.slice(0, full.lastIndexOf('/')) || '/', home);
  return join(parent, full.slice(full.lastIndexOf('/') + 1));
}

function sbplString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
