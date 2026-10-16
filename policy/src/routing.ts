import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';

export const TIERS = ['T0', 'T1', 'T2'] as const;
export type Tier = (typeof TIERS)[number];

const Model = z.object({ id: z.string().regex(/^claude-[a-z]+-[0-9-]+$/, 'a full pinned model ID'), effort: z.string().optional() }).strict();

export const RoutingSchema = z
  .object({ version: z.literal(1), tiers: z.object({ T0: Model, T1: Model, T2: Model }).strict() })
  .strict();
export type Routing = z.infer<typeof RoutingSchema>;
export type ModelSpec = z.infer<typeof Model>;

export function parseRouting(yamlText: string): Routing {
  return RoutingSchema.parse(parse(yamlText));
}

export function loadRouting(path: string | URL = new URL('../routing.yaml', import.meta.url)): Routing {
  return parseRouting(readFileSync(path, 'utf8'));
}

/** The next tier up, or the same tier at the top. */
export function escalate(tier: Tier): Tier {
  return TIERS[Math.min(TIERS.indexOf(tier) + 1, TIERS.length - 1)]!;
}
