import { z } from 'zod';

export const CATEGORIES = [
  'store_release',
  'iap_pricing',
  'payment_sdk',
  'permissions',
  'dependency_upgrade',
  'keys_signing',
  'privacy_data',
  'change_scope',
] as const;

// Strictest first. `allow` exists only so a project layer that tries to relax a rule
// parses and gets a precise merge error instead of a schema error.
export const EFFECT_ORDER = ['deny', 'require_approval', 'allow'] as const;
export type Effect = (typeof EFFECT_ORDER)[number];

const Match = z
  .object({
    commands: z.array(z.string()).default([]),
    files: z.array(z.string()).default([]),
    deps: z.array(z.string()).default([]),
    config_paths: z.array(z.string()).default([]),
  })
  .strict();

const Approval = z
  .object({
    binds_to: z.literal('artifact_digest'),
    ttl: z.literal('single_use'),
    evidence: z.array(z.string()).default([]),
  })
  .strict();

export const RuleSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9_]+(\.[a-z0-9_]+)*$/),
    category: z.enum(CATEGORIES),
    effect: z.enum(EFFECT_ORDER),
    locked: z.boolean().default(false),
    match: Match.default({ commands: [], files: [], deps: [], config_paths: [] }),
    approval: Approval.optional(),
  })
  .strict();

export const PolicySchema = z
  .object({
    version: z.literal(1),
    rules: z.array(RuleSchema).default([]),
  })
  .strict()
  .superRefine((policy, ctx) => {
    const seen = new Set<string>();
    policy.rules.forEach((rule, i) => {
      if (seen.has(rule.id)) {
        ctx.addIssue({ code: 'custom', path: ['rules', i, 'id'], message: `duplicate rule id ${rule.id}` });
      }
      seen.add(rule.id);
    });
  });

export type Rule = z.infer<typeof RuleSchema>;
export type Match = Rule['match'];
export type Policy = z.infer<typeof PolicySchema>;
