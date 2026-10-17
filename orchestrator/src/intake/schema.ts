import { z } from 'zod';

// Flow A's change folder (`.rnship/changes/<id>/` in the app repo, design §2 A1–A5).
// You write change-request.yaml; `rnship change intake` writes impact.json,
// baseline-delta.yaml and screens.yaml next to it. Those four are the scope you approve
// (`rnship change approve`). A5's output goes under tasks/, outside the digest.

const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits and dashes');
/** A repo-relative path: no spaces, quotes or markup, so it can't carry instructions into a prompt. */
const RepoPath = z.string().regex(/^(?!\/)(?!.*\.\.)[A-Za-z0-9._/-]+$/, 'a repo-relative path of letters, digits, . _ / -');
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'a hex sha256');
export const PLATFORMS = ['ios', 'android'] as const;

// A1. Acceptance criteria are testable by shape: each says what the user does and what
// they then see. Research is attached by reference only (design §2 A1).
export const AcceptanceCriterion = z
  .object({
    id: Slug,
    given: z.string().min(1).optional(),
    when: z.string().min(1),
    then: z.string().min(1),
    /** A user-facing criterion needs at least one Maestro smoke flow (A5). */
    user_facing: z.boolean(),
  })
  .strict();
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterion>;

export const ChangeRequestSchema = z
  .object({
    version: z.literal(1),
    id: Slug,
    goal: z.string().min(1),
    areas: z.array(z.string().min(1)).min(1),
    platforms: z.array(z.enum(PLATFORMS)).min(1),
    acceptance_criteria: z.array(AcceptanceCriterion).min(1),
    data_impact: z.enum(['none', 'local', 'remote']),
    monetization_impact: z.enum(['none', 'iap', 'ads']),
    research: z.array(z.object({ path: RepoPath, sha256: Sha256 }).strict()).default([]),
  })
  .strict();
export type ChangeRequest = z.infer<typeof ChangeRequestSchema>;

// A2's single LLM call proposes; the gate decides deterministically (impact.ts).
export const ProposalSchema = z
  .object({
    /** Capabilities from the vocabulary the prompt lists; suitability rules match these. */
    capabilities: z.array(Slug),
    /** Packages the change needs, with package.json specs. */
    dependencies: z.record(z.string(), z.string()),
    /** The Expo config slice the change needs, in `expo config --json` shape (like the baseline's `config`). */
    config: z.record(z.string(), z.unknown()),
    /** The model's own claim that native code changes; the gate only ever adds to it. */
    native: z.boolean(),
    store_review_risk: z.enum(['low', 'medium', 'high']),
  })
  .strict();
export type Proposal = z.infer<typeof ProposalSchema>;

export const VERDICTS = ['go', 'go-dev-build', 'stop'] as const;
export type Verdict = (typeof VERDICTS)[number];

export const RuleHit = z.object({ ruleId: z.string(), effect: z.enum(['stop', 'deny', 'require_approval']), matches: z.array(z.string()) }).strict();
export type RuleHit = z.infer<typeof RuleHit>;

export const BaselineDeltaSchema = z
  .object({
    version: z.literal(1),
    /** Packages to add to (or change in) the approved baseline. */
    dependencies: z.record(z.string(), z.string()).default({}),
    /** Config paths to add to (or change in) the baseline's `config`, merged key by key. */
    config: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export type BaselineDelta = z.infer<typeof BaselineDeltaSchema>;

export const ImpactSchema = z
  .object({
    version: z.literal(1),
    verdict: z.enum(VERDICTS),
    native_build: z.boolean(),
    store_review_risk: z.enum(['low', 'medium', 'high']),
    /** Suitability stops, and the policy gates the baseline delta fires. */
    rule_hits: z.array(RuleHit),
    /** `name@spec` for each package the change needs that package.json doesn't have yet (A3b delta). */
    install: z.array(z.string()),
    capabilities: z.array(Slug),
  })
  .strict();
export type Impact = z.infer<typeof ImpactSchema>;

// A4. Every route lists its three states and its a11y labels; every AC maps to a route.
export const ScreensSchema = z
  .object({
    version: z.literal(1),
    routes: z
      .array(
        z
          .object({
            path: z.string().regex(/^\/[A-Za-z0-9/_[\]().-]*$/, 'an expo-router path'),
            title: z.string().min(1),
            acceptance_criteria: z.array(Slug).min(1),
            states: z.object({ loading: z.string().min(1), empty: z.string().min(1), error: z.string().min(1) }).strict(),
            a11y_labels: z.array(z.string().min(1)).min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type Screens = z.infer<typeof ScreensSchema>;

// A5. The LLM returns tasks and smoke flows as structured data; rnship writes tasks.yaml
// and renders each flow's YAML itself, so every flow parses by construction. Validation
// commands come from you (`--validation`), never from the model.
export const SMOKE_COMMANDS = ['launchApp', 'tapOn', 'inputText', 'assertVisible', 'assertNotVisible', 'scrollUntilVisible', 'back'] as const;

export const SmokeStep = z
  .object({
    command: z.enum(SMOKE_COMMANDS),
    /** Text on screen, or a testID with `id`. inputText takes `text` as what to type. */
    text: z.string().min(1).optional(),
    id: z.string().regex(/^[A-Za-z0-9_.-]+$/).optional(),
  })
  .strict();
export type SmokeStep = z.infer<typeof SmokeStep>;

export const PlanSchema = z
  .object({
    tasks: z
      .array(
        z
          .object({
            id: Slug,
            title: z.string().min(1),
            tier: z.enum(['T0', 'T1', 'T2']),
            deps: z.array(Slug),
            files: z.array(RepoPath),
            native: z.boolean(),
            body: z.string(),
            acceptance_criteria: z.array(Slug).min(1),
            smoke_flows: z.array(Slug),
            risk: z.array(Slug),
          })
          .strict(),
      )
      .min(1),
    flows: z.array(z.object({ name: Slug, acceptance_criteria: z.array(Slug).min(1), steps: z.array(SmokeStep).min(1) }).strict()),
  })
  .strict();
export type Plan = z.infer<typeof PlanSchema>;
