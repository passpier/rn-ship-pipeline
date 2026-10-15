import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import type { Fingerprint } from '@expo/fingerprint';
import type { Platform } from './artifacts.ts';
import { nativeModuleRefsIn } from './nativeModules.ts';

export type NativeManifest = {
  platform: Platform;
  /** Autolinked packages compiled into the binary. */
  packages: Array<{ name: string; version: string }>;
  /** Native module names the binary's JS packages look up, i.e. the names JS may rely on. */
  nativeModuleNames: string[];
};

// Built from the fingerprint's autolinking sources, so the manifest describes exactly
// the native code the fingerprint covers.
export function buildNativeManifest(projectRoot: string, platform: Platform, fingerprint: Fingerprint): NativeManifest {
  const root = realpathSync(projectRoot);
  const packages = new Map<string, string>();
  const packageDirs = new Set<string>();

  for (const source of fingerprint.sources) {
    if (source.type === 'contents' && source.id === `expoAutolinkingConfig:${platform}`) {
      const config = JSON.parse(String(source.contents)) as { modules: Array<{ packageName: string; packageVersion: string }> };
      for (const mod of config.modules) packages.set(mod.packageName, mod.packageVersion);
    } else if (source.type === 'contents' && source.id === `rncoreAutolinkingConfig:${platform}`) {
      const config = JSON.parse(String(source.contents)) as Record<string, { name: string; platforms: Record<string, { version?: string } | null> }>;
      for (const dep of Object.values(config)) packages.set(dep.name, dep.platforms[platform]?.version ?? 'unknown');
    } else if (source.type === 'dir' && source.reasons.some((r) => /Autolinking/.test(r))) {
      const dir = packageRoot(resolve(root, source.filePath));
      if (dir) packageDirs.add(dir);
    }
  }
  const reactNative = createRequire(join(root, 'package.json')).resolve('react-native/package.json');
  packageDirs.add(dirname(reactNative));

  const names = new Set<string>();
  for (const dir of packageDirs) for (const name of nativeModuleRefsIn(dir).keys()) names.add(name);

  return {
    platform,
    packages: [...packages].map(([name, version]) => ({ name, version })).sort((a, b) => a.name.localeCompare(b.name)),
    nativeModuleNames: [...names].sort(),
  };
}

function packageRoot(dir: string): string | undefined {
  for (let current = dir; current !== dirname(current); current = dirname(current)) {
    if (existsSync(join(current, 'package.json'))) return current;
  }
  return undefined;
}
