import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Fingerprint } from '@expo/fingerprint';
import { appFingerprint } from './fingerprint.ts';
import { buildNativeManifest, type NativeManifest } from './manifest.ts';

export const PLATFORMS = ['ios', 'android'] as const;
export type Platform = (typeof PLATFORMS)[number];

// What A8 records for a production build, and what the classifier diffs against.
export type BuildArtifacts = {
  buildId: string;
  /** The app's @expo/fingerprint version that made the fingerprints. */
  fingerprintVersion?: string;
  fingerprints: Record<Platform, Fingerprint>;
  nativeManifests: Record<Platform, NativeManifest>;
};

// Fingerprint source paths are relative, so a symlinked root (macOS /var -> /private/var)
// would make the same tree fingerprint differently depending on how it was reached.
export function fingerprintFor(projectRoot: string, platform: Platform): Promise<Fingerprint> {
  return appFingerprint(projectRoot).createFingerprintAsync(realpathSync(projectRoot), { platforms: [platform] });
}

export async function recordBuild(projectRoot: string, outDir: string, opts: { buildId: string }): Promise<BuildArtifacts> {
  mkdirSync(outDir, { recursive: true });
  const fingerprints = {} as Record<Platform, Fingerprint>;
  const nativeManifests = {} as Record<Platform, NativeManifest>;
  for (const platform of PLATFORMS) {
    fingerprints[platform] = await fingerprintFor(projectRoot, platform);
    nativeManifests[platform] = buildNativeManifest(projectRoot, platform, fingerprints[platform]);
    writeFileSync(join(outDir, `fingerprint.${platform}.json`), JSON.stringify(fingerprints[platform], null, 2));
    writeFileSync(join(outDir, `native-manifest.${platform}.json`), JSON.stringify(nativeManifests[platform], null, 2));
  }
  const fingerprintVersion = appFingerprint(projectRoot).version;
  writeFileSync(join(outDir, 'build.json'), JSON.stringify({ buildId: opts.buildId, fingerprintVersion }, null, 2));
  return { buildId: opts.buildId, fingerprintVersion, fingerprints, nativeManifests };
}

export function readBuild(dir: string): BuildArtifacts {
  const read = (file: string) => JSON.parse(readFileSync(join(dir, file), 'utf8'));
  const fingerprints = {} as Record<Platform, Fingerprint>;
  const nativeManifests = {} as Record<Platform, NativeManifest>;
  for (const platform of PLATFORMS) {
    fingerprints[platform] = read(`fingerprint.${platform}.json`);
    nativeManifests[platform] = read(`native-manifest.${platform}.json`);
  }
  const build = read('build.json') as { buildId: string; fingerprintVersion?: string };
  return { buildId: build.buildId, fingerprintVersion: build.fingerprintVersion, fingerprints, nativeManifests };
}
