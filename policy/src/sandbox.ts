import { existsSync, readdirSync, realpathSync } from 'node:fs';
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

/**
 * Env for both sandboxes. The expo CLI writes a telemetry ID to ~/.expo/state.json on
 * every command, and ~/.expo is a secret path, so without this every `expo` command
 * fails with EPERM (S12).
 */
export const SANDBOX_ENV = { EXPO_NO_TELEMETRY: '1' };

/**
 * Hosts validation and Bash commands may reach: the npm registry, GitHub, Expo, the
 * CocoaPods spec CDN, and Maven Central's read-only mirror, where React Native's iOS pods
 * (hermes-engine, React-Core-prebuilt, ReactNativeDependencies) get their prebuilt
 * tarballs (S12). Not central.sonatype.com: it only serves nightlies, and it's where
 * artifacts are published.
 */
export const NETWORK_ALLOWLIST = [
  'registry.npmjs.org',
  'github.com',
  'api.github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'raw.githubusercontent.com',
  'api.expo.dev',
  'exp.host',
  'cdn.cocoapods.org',
  'repo1.maven.org',
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
 * except reading other users' homes and mounted volumes (only `home` and the `readable`
 * paths stay open, wherever they are), raw disks and system keychains; mounting; reading
 * or writing secrets; writing persistence paths; Watchman; and outbound network other
 * than localhost. SBPL can't match hostnames, so allowlisted hosts are reached through
 * the localhost proxy that `rnship sandbox run` starts. The /Users rules follow
 * sandvault's profile (github.com/webcoyote/sandvault).
 */
export function seatbeltProfile(opts: { home: string; readable?: string[]; bootVolume?: string }): string {
  const paths = (list: string[]) => list.map((p) => `  (subpath ${sbplString(realHomePath(p, opts.home))})`).join('\n');
  const open = [opts.home, ...(opts.readable ?? [])].map((p) => realHomePath(p, opts.home));
  // Path lookup stats each parent, so the parents of an open path keep their metadata.
  const parents = [...new Set(['/Users', ...open.flatMap(ancestors)])].filter((p) => CLOSED_ROOTS.some((root) => p === root || p.startsWith(`${root}/`)));
  const literals = (list: string[]) => list.map((p) => `  (literal ${sbplString(p)})`).join('\n');
  const boot = opts.bootVolume ?? bootVolume();
  return `(version 1)
(allow default)
; Other users' homes and mounted volumes (except the boot volume's link): no reads. First,
; so the open paths below reopen their part, and the secret denies after them still win
; inside (the last matching rule applies).
(deny file-read* (subpath "/Users") (subpath "/Volumes"))
${boot ? `(allow file-read* (literal ${sbplString(`/Volumes/${boot}`)}))\n` : ''}(allow file-read-metadata
${literals(parents)})
(allow file-read*
${open.map((p) => `  (subpath ${sbplString(p)})`).join('\n')})
; Raw disks, packet capture: no access.
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
; Watchman: its daemon can't start in here (it installs a LaunchAgent), and Metro then
; waits for it forever (S12). Without the binary, Metro and jest use their node crawler.
; A daemon already running outside runs \`trigger\` commands unsandboxed: no connecting.
(deny process-exec (regex #"/watchman$"))
(deny network-outbound (remote unix-socket (path-regex #"/watchman/[^/]+-state/")))
`;
}

const CLOSED_ROOTS = ['/Users', '/Volumes'];

// The /Volumes entry that links to /, whatever the boot volume is called.
function bootVolume(): string | undefined {
  try {
    return readdirSync('/Volumes').find((name) => realpathSync(join('/Volumes', name)) === '/');
  } catch {
    return undefined;
  }
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
