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
    // Other users' homes and mounted volumes: no reads. The narrower `~/` (the agent's own
    // home) re-opens its part of /Users, and the secret denies inside it are narrower still.
    filesystem: {
      denyRead: ['/Users', '/Volumes', ...SECRET_PATHS],
      allowRead: ['~/'],
      denyWrite: [...SECRET_PATHS, ...PERSISTENCE_PATHS],
    },
    network: { allowedDomains: [...NETWORK_ALLOWLIST] },
  };
}

// Mach services that mount disks or network shares, or script Finder into doing it.
const MOUNT_SERVICES = [
  'com.apple.DiskArbitration.diskarbitrationd',
  'com.apple.NetAuthAgent',
  'com.apple.NetAuthSysAgent',
  'com.apple.appleeventsd',
];

/**
 * A `sandbox-exec` (Seatbelt) profile for validation commands. Everything is allowed
 * except reading other users' homes (only `home` and the `readable` paths stay open
 * under /Users), mounted volumes, raw disks and system keychains; mounting; reading or
 * writing secrets; writing persistence paths; and outbound network other than
 * localhost. SBPL can't match hostnames, so allowlisted hosts are reached through the
 * localhost proxy that `rnship sandbox run` starts. The /Users rules follow sandvault's
 * profile (github.com/webcoyote/sandvault).
 */
export function seatbeltProfile(opts: { home: string; readable?: string[] }): string {
  const paths = (list: string[]) => list.map((p) => `  (subpath ${sbplString(realHomePath(p, opts.home))})`).join('\n');
  const open = [opts.home, ...(opts.readable ?? [])].map((p) => realHomePath(p, opts.home));
  // Path lookup stats each parent, so the parents of an open path keep their metadata.
  const parents = [...new Set(open.flatMap(ancestors))].filter((p) => p.startsWith('/Users/'));
  const literals = (list: string[]) => list.map((p) => `  (literal ${sbplString(p)})`).join('\n');
  return `(version 1)
(allow default)
; Other users' homes: no reads. First, so the secret denies below still win inside the
; open paths (the last matching rule applies).
(deny file-read* (subpath "/Users"))
(allow file-read-metadata
  (literal "/Users")
${literals(parents)})
(allow file-read*
${open.map((p) => `  (subpath ${sbplString(p)})`).join('\n')})
; Mounted volumes except the boot volume's link, raw disks, packet capture: no access.
(deny file-read* (subpath "/Volumes"))
(allow file-read* (literal "/Volumes/Macintosh HD"))
(deny file-read* file-write*
  (regex #"^(/private)?/dev/r?disk")
  (regex #"^(/private)?/dev/bpf"))
; No mounting, directly or through the services that do it.
(deny file-mount file-unmount)
(deny mach-lookup
${MOUNT_SERVICES.map((name) => `  (global-name ${sbplString(name)})`).join('\n')})
; System keychains: no reads, except System.keychain's public CA anchors.
(deny file-read* (subpath "/Library/Keychains"))
(allow file-read* (literal "/Library/Keychains/System.keychain"))
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

// '/Users/a/b' → ['/Users/a', '/Users'], nearest first; '/' is never included.
function ancestors(path: string): string[] {
  const out: string[] = [];
  for (let p = path.slice(0, path.lastIndexOf('/')); p; p = p.slice(0, p.lastIndexOf('/'))) out.push(p);
  return out;
}

function sbplString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
