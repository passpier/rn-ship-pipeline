import { changedGates, suitabilityHits, type Policy, type Suitability } from '@rnship/policy';
import { baselineState, canonicalJson, type Baseline } from '@rnship/release';
import type { BaselineDelta, Impact, Proposal, RuleHit } from './schema.ts';

// A2 + A3, deterministic: the model only proposed what the change needs; this decides.
//   stop          a suitability rule matched (each stop cites its rule ID)
//   go-dev-build  the change installs a package or changes native config
//   go            JavaScript only
// The baseline delta is whatever the proposal needs beyond the approved baseline. A
// non-empty delta needs your baseline approval, which `rnship change approve` records.

export type GateInput = {
  proposal: Proposal;
  baseline: Baseline;
  /** dependencies and devDependencies of the app's package.json now. */
  packageDeps: Record<string, string>;
  policy: Policy;
  suitability: Suitability;
  /** The app's `expo/bundledNativeModules.json`: the SDK's own version of each package wins over the model's. */
  bundled?: Record<string, string>;
};

export type GateResult = { impact: Impact; delta: BaselineDelta };

const RISK = ['low', 'medium', 'high'] as const;

export function impactGate(input: GateInput): GateResult {
  const { proposal, baseline } = input;
  const specs = Object.fromEntries(
    Object.entries(proposal.dependencies).map(([name, spec]) => [name, input.bundled?.[name] ?? baseline.dependencies[name] ?? spec]),
  );
  const ruleHits: RuleHit[] = suitabilityHits(input.suitability, { capabilities: proposal.capabilities, dependencies: specs }).map((hit) => ({
    ruleId: hit.ruleId,
    effect: 'stop',
    matches: hit.matches,
  }));

  const delta: BaselineDelta = {
    version: 1,
    dependencies: Object.fromEntries(Object.entries(specs).filter(([name, spec]) => baseline.dependencies[name] !== spec)),
    config: (beyond(proposal.config, baseline.config) ?? {}) as Record<string, unknown>,
  };
  const after = applyDelta(baseline, delta);
  for (const gate of changedGates(input.policy, baselineState(baseline), baselineState(after), { depRemovals: false })) {
    if (gate.effect === 'allow') continue;
    ruleHits.push({ ruleId: gate.ruleId, effect: gate.effect, matches: gate.matches });
  }

  const install = Object.entries(specs)
    .filter(([name, spec]) => input.packageDeps[name] !== spec)
    .map(([name, spec]) => `${name}@${spec}`)
    .sort();
  const nativeBuild = proposal.native || install.length > 0 || Object.keys(delta.config).length > 0;
  const sensitive = ruleHits.some((hit) => hit.ruleId.startsWith('permissions.') || hit.ruleId.startsWith('privacy.') || hit.ruleId.startsWith('payment.'));
  const risk = RISK[Math.max(RISK.indexOf(proposal.store_review_risk), sensitive ? 1 : 0)]!;

  const verdict = ruleHits.some((hit) => hit.effect === 'stop') ? 'stop' : nativeBuild ? 'go-dev-build' : 'go';
  return {
    impact: {
      version: 1,
      verdict,
      native_build: nativeBuild,
      store_review_risk: risk,
      rule_hits: ruleHits,
      install,
      capabilities: [...proposal.capabilities].sort(),
    },
    delta,
  };
}

export function deltaIsEmpty(delta: BaselineDelta): boolean {
  return Object.keys(delta.dependencies).length === 0 && Object.keys(delta.config).length === 0;
}

/** The baseline with the delta merged in: objects merge by key, arrays gain the delta's new entries. */
export function applyDelta(baseline: Baseline, delta: BaselineDelta): Baseline {
  return {
    version: 1,
    dependencies: { ...baseline.dependencies, ...delta.dependencies },
    config: merge(baseline.config, delta.config) as Record<string, unknown>,
  };
}

/** Does the baseline already hold everything in the delta? */
export function baselineCovers(baseline: Baseline, delta: BaselineDelta): boolean {
  return canonicalJson(applyDelta(baseline, delta)) === canonicalJson(baseline);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function merge(base: unknown, extra: unknown): unknown {
  if (isObject(base) && isObject(extra)) {
    const out: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(extra)) out[key] = key in base ? merge(base[key], value) : value;
    return out;
  }
  if (Array.isArray(base) && Array.isArray(extra)) {
    const seen = new Set(base.map((v) => canonicalJson(v)));
    return [...base, ...extra.filter((v) => !seen.has(canonicalJson(v)))];
  }
  return extra;
}

/** The part of `wanted` that `have` doesn't already contain, or undefined when it's all there. */
function beyond(wanted: unknown, have: unknown): unknown {
  if (isObject(wanted)) {
    const base = isObject(have) ? have : {};
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(wanted)) {
      const rest = beyond(value, base[key]);
      if (rest !== undefined) out[key] = rest;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  if (Array.isArray(wanted)) {
    const seen = new Set((Array.isArray(have) ? have : []).map((v) => canonicalJson(v)));
    const rest = wanted.filter((v) => !seen.has(canonicalJson(v)));
    return rest.length > 0 ? rest : undefined;
  }
  return canonicalJson(wanted) === canonicalJson(have) ? undefined : wanted;
}
