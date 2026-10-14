import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import type { ProjectState } from '@rnship/policy';
import { PLATFORMS, type BuildArtifacts } from './artifacts.ts';
import type { Reason } from './classify.ts';
import { nativeModuleRefsIn } from './nativeModules.ts';

export type GapContext = {
  build: BuildArtifacts;
  base: { root: string; state: ProjectState };
  candidate: { root: string; state: ProjectState };
};

// Layer 2: known blind spots of @expo/fingerprint. Each rule forces BUILD.
export const GAP_RULES: Array<(ctx: GapContext) => Reason[]> = [
  inlineConfigPlugin,
  fingerprintConfig,
  updatesConfig,
  nativePatch,
  unknownNativeModule,
];

const bothPlatforms = (ruleId: string, detail: string): Reason[] => [
  { ruleId, platforms: [...PLATFORMS], verdict: 'BUILD', detail },
];

const APP_CONFIG_FILES = ['app.config.ts', 'app.config.js', 'app.config.mjs', 'app.config.cjs', 'app.json'];

// The fingerprint records an inline plugin function only by its name, so edits to
// its body are invisible to it.
function inlineConfigPlugin({ base, candidate }: GapContext): Reason[] {
  const changed = APP_CONFIG_FILES.filter((file) => read(base.root, file) !== read(candidate.root, file));
  if (changed.length === 0) return [];
  const inline = [base, candidate].flatMap((side) => inlinePluginNames(side.root, side.state.config));
  if (inline.length === 0) return [];
  return [{
    ruleId: 'gap.inline_config_plugin',
    platforms: [...PLATFORMS],
    verdict: 'BUILD',
    detail: `${changed.join(', ')} changed and defines inline config plugins: ${[...new Set(inline)].join(', ')}`,
  }];
}

// Ignore rules and sourceSkips decide what the fingerprint sees, so changing them can
// hide a native change from layer 1.
function fingerprintConfig({ base, candidate }: GapContext): Reason[] {
  const changed = ['.fingerprintignore', 'fingerprint.config.js'].filter(
    (file) => read(base.root, file) !== read(candidate.root, file),
  );
  return changed.length === 0 ? [] : bothPlatforms('gap.fingerprint_config', `${changed.join(', ')} changed`);
}

const UPDATES_PATHS = ['updates', 'runtimeVersion', 'ios.updates', 'ios.runtimeVersion', 'android.updates', 'android.runtimeVersion'];

// The update URL, code signing, and runtime policy are baked into the binary.
function updatesConfig({ base, candidate }: GapContext): Reason[] {
  const changed = UPDATES_PATHS.flatMap((path) => changedLeaves(path, get(base.state.config, path), get(candidate.state.config, path)));
  return changed.length === 0 ? [] : bothPlatforms('gap.updates_config', `changed: ${changed.join(', ')}`);
}

// patch-package (`name+1.2.3.patch`, `@scope+name+1.2.3.patch`) and pnpm (`name@1.2.3.patch`) patches.
function nativePatch({ base, candidate }: GapContext): Reason[] {
  const files = new Set([...patchFiles(base.root), ...patchFiles(candidate.root)]);
  const changed = [...files].filter((file) => read(base.root, file) !== read(candidate.root, file));
  const native = [...new Set(changed.map(patchedPackage))].filter((name) => shipsNativeCode(candidate.root, name) || shipsNativeCode(base.root, name));
  return native.length === 0 ? [] : bothPlatforms('gap.native_patch', `patches changed for native packages: ${native.sort().join(', ')}`);
}

function patchFiles(root: string): string[] {
  const dir = join(root, 'patches');
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.patch')).map((f) => join('patches', f)) : [];
}

function patchedPackage(file: string): string {
  const name = file.slice('patches/'.length, -'.patch'.length);
  if (name.includes('+')) {
    const parts = name.split('+');
    return name.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]!;
  }
  return name.replace(/@[^@/]*$/, '').replace(/__/g, '/');
}

// Unresolvable packages count as native: a miss here would ship an OTA that needs a build.
function shipsNativeCode(root: string, name: string): boolean {
  let dir: string;
  try {
    dir = dirname(createRequire(join(root, 'package.json')).resolve(`${name}/package.json`));
  } catch {
    return true;
  }
  return ['ios', 'android', 'apple', 'expo-module.config.json', 'react-native.config.js'].some((entry) => existsSync(join(dir, entry)))
    || readdirSync(dir).some((entry) => entry.endsWith('.podspec'));
}

// App JS that looks up a native module the production binary doesn't contain.
function unknownNativeModule({ build, candidate }: GapContext): Reason[] {
  const refs = nativeModuleRefsIn(candidate.root);
  return PLATFORMS.flatMap((platform) => {
    const known = new Set(build.nativeManifests[platform].nativeModuleNames);
    const missing = [...refs.keys()].filter((name) => !known.has(name)).sort();
    if (missing.length === 0) return [];
    return [{
      ruleId: 'gap.unknown_native_module',
      platforms: [platform],
      verdict: 'BUILD' as const,
      detail: `not in the ${platform} native manifest: ${missing.map((name) => `${name} (${refs.get(name)!.map((f) => relative(candidate.root, f)).join(', ')})`).join('; ')}`,
    }];
  });
}

// The resolved config replaces a plugin function with its name, so an inline plugin
// is any entry that doesn't resolve to a package or a file.
function inlinePluginNames(root: string, config: Record<string, unknown>): string[] {
  const plugins: unknown[] = Array.isArray(config.plugins) ? config.plugins : [];
  const require = createRequire(join(root, 'package.json'));
  const resolves = (name: string) => {
    for (const request of [`${name}/app.plugin.js`, name]) {
      try {
        require.resolve(request.startsWith('.') ? join(root, request) : request);
        return true;
      } catch {
        // try the next form
      }
    }
    return false;
  };
  return plugins
    .map((entry) => (Array.isArray(entry) ? entry[0] : entry))
    .flatMap((entry) => {
      if (typeof entry === 'function') return [entry.name || '<anonymous>'];
      if (typeof entry === 'string' && !resolves(entry)) return [entry];
      return [];
    });
}

function get(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((v, key) => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>)[key] : undefined), value);
}

function changedLeaves(path: string, a: unknown, b: unknown): string[] {
  const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (isRecord(a) && isRecord(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].sort().flatMap((key) => changedLeaves(`${path}.${key}`, a[key], b[key]));
  }
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [path];
}

function read(root: string, file: string): string | undefined {
  const path = join(root, file);
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}
