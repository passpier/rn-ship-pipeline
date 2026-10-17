import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';
import { globToRegExp } from './changes.ts';

// `policy/suitability.yaml`: what Flow A's change-impact gate stops on (design §2 A2).

const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);

export const SuitabilitySchema = z
  .object({
    version: z.literal(1),
    known: z.array(Slug).default([]),
    rules: z.array(
      z
        .object({
          id: z.string().regex(/^suitability\.[a-z0-9-]+$/),
          reason: z.string().min(1),
          capabilities: z.array(Slug).default([]),
          deps: z.array(z.string()).default([]),
        })
        .strict(),
    ),
  })
  .strict();
export type Suitability = z.infer<typeof SuitabilitySchema>;

export function loadSuitability(path: string | URL = new URL('../suitability.yaml', import.meta.url)): Suitability {
  return SuitabilitySchema.parse(parse(readFileSync(path, 'utf8')));
}

/** Every capability the A2 prompt may offer: the known ones and those the rules stop on. */
export function capabilityVocabulary(rules: Suitability): string[] {
  return [...new Set([...rules.known, ...rules.rules.flatMap((r) => r.capabilities)])].sort();
}

export type SuitabilityHit = { ruleId: string; reason: string; matches: string[] };

export function suitabilityHits(rules: Suitability, proposal: { capabilities: string[]; dependencies: Record<string, string> }): SuitabilityHit[] {
  return rules.rules.flatMap((rule) => {
    const matches = [
      ...proposal.capabilities.filter((c) => rule.capabilities.includes(c)).map((c) => `capability:${c}`),
      ...Object.keys(proposal.dependencies)
        .filter((name) => rule.deps.some((glob) => globToRegExp(glob).test(name)))
        .map((name) => `deps:${name}`),
    ];
    return matches.length > 0 ? [{ ruleId: rule.id, reason: rule.reason, matches }] : [];
  });
}
