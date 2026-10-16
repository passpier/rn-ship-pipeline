import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type * as ExpoFingerprint from '@expo/fingerprint';

// The classifier must predict the runtime version the app's own expo-updates computes, so
// it fingerprints with the @expo/fingerprint the app's expo package depends on, never
// with a copy of its own: SDK 55 ships 0.16, SDK 57 0.20, and they hash differently.
// An app without expo, or an expo without @expo/fingerprint, fails closed.

export type FingerprintModule = Pick<typeof ExpoFingerprint, 'createFingerprintAsync' | 'diffFingerprints'> & { version: string };

export function appFingerprint(projectRoot: string): FingerprintModule {
  const root = realpathSync(projectRoot);
  let fromExpo: NodeJS.Require;
  try {
    fromExpo = createRequire(createRequire(join(root, 'package.json')).resolve('expo/package.json'));
  } catch {
    throw new Error(`${root} has no installed expo package: can't fingerprint it the way its expo-updates will`);
  }
  let entry: string;
  try {
    entry = fromExpo.resolve('@expo/fingerprint');
  } catch {
    throw new Error(`the expo package of ${root} doesn't provide @expo/fingerprint`);
  }
  const mod = fromExpo(entry) as typeof ExpoFingerprint;
  return { createFingerprintAsync: mod.createFingerprintAsync, diffFingerprints: mod.diffFingerprints, version: packageVersion(entry) };
}

/** The version in the nearest package.json above `entry` (its exports map may hide package.json). */
function packageVersion(entry: string): string {
  for (let dir = dirname(entry); dir !== dirname(dir); dir = dirname(dir)) {
    const pkg = join(dir, 'package.json');
    if (!existsSync(pkg)) continue;
    const json = JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string; version?: string };
    if (json.name === '@expo/fingerprint') return json.version ?? 'unknown';
  }
  return 'unknown';
}
