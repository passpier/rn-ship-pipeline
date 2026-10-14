import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { ProjectState } from '@rnship/policy';

type ExpoConfigModule = {
  getConfig(projectRoot: string, options: { skipSDKVersionRequirement: boolean }): { exp: Record<string, unknown> };
};

// Resolves the Expo config with the project's own `expo` install, so the result
// matches what `expo config` and EAS see for that SDK.
export function loadProjectState(projectRoot: string): ProjectState {
  const root = realpathSync(projectRoot);
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const require = createRequire(join(root, 'package.json'));
  const { getConfig } = require('expo/config') as ExpoConfigModule;
  return {
    config: getConfig(root, { skipSDKVersionRequirement: true }).exp,
    dependencies: { ...pkg.devDependencies, ...pkg.dependencies },
  };
}
