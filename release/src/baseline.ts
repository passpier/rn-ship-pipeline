import { readFileSync } from 'node:fs';
import type { ProjectState } from '@rnship/policy';
import { parse } from 'yaml';
import { z } from 'zod';
import { canonicalJson, sha256 } from './digest.ts';

// `.rnship/approved-baseline.yaml`: what you approved once, as a batch (Stage 0).
// `rnship policy check` fires deps and config_paths rules only on a change beyond it.
export const BaselineSchema = z
  .object({
    version: z.literal(1),
    /** Allowlisted packages at their exact package.json specs, devDependencies included. */
    dependencies: z.record(z.string(), z.string()).default({}),
    /**
     * The approved slice of the resolved Expo config, in `expo config --json` shape:
     * ios.infoPlist usage strings, android.permissions / blockedPermissions, plugins,
     * ios.privacyManifests. Paths a policy rule watches and this omits count as absent.
     */
    config: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export type Baseline = z.infer<typeof BaselineSchema>;

export function parseBaseline(yamlText: string): Baseline {
  return BaselineSchema.parse(parse(yamlText));
}

export function loadBaseline(path: string): Baseline {
  return parseBaseline(readFileSync(path, 'utf8'));
}

/** Digest of the parsed baseline, so formatting and key order don't matter. */
export function baselineDigest(baseline: Baseline): string {
  return sha256(canonicalJson(baseline));
}

export function baselineState(baseline: Baseline): ProjectState {
  return { config: baseline.config, dependencies: baseline.dependencies };
}
