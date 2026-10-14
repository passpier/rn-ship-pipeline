import { EFFECT_ORDER, type Effect, type Match, type Policy, type Rule } from './schema.ts';

export type MergeErrorCode = 'locked_downgrade' | 'allow_rule' | 'category_change';

export type MergeError = { ruleId: string; code: MergeErrorCode; message: string };

export type MergeResult = { ok: true; policy: Policy } | { ok: false; errors: MergeError[] };

const strictness = (effect: Effect) => EFFECT_ORDER.length - EFFECT_ORDER.indexOf(effect);

const union = (a: string[], b: string[]) => [...new Set([...a, ...b])];

function unionMatch(a: Match, b: Match): Match {
  return {
    commands: union(a.commands, b.commands),
    files: union(a.files, b.files),
    deps: union(a.deps, b.deps),
    config_paths: union(a.config_paths, b.config_paths),
  };
}

// The project layer may only add rules or tighten them.
export function mergePolicy(base: Policy, project: Policy): MergeResult {
  const errors: MergeError[] = [];
  const merged = new Map<string, Rule>(base.rules.map((rule) => [rule.id, rule]));

  for (const rule of project.rules) {
    const baseRule = merged.get(rule.id);
    if (!baseRule) {
      if (rule.effect === 'allow') {
        errors.push({ ruleId: rule.id, code: 'allow_rule', message: `rule ${rule.id}: the project layer can't add an allow rule` });
        continue;
      }
      merged.set(rule.id, rule);
      continue;
    }
    if (rule.category !== baseRule.category) {
      errors.push({
        ruleId: rule.id,
        code: 'category_change',
        message: `rule ${rule.id}: project category "${rule.category}" differs from base "${baseRule.category}"`,
      });
      continue;
    }
    if (baseRule.locked && strictness(rule.effect) < strictness(baseRule.effect)) {
      errors.push({
        ruleId: rule.id,
        code: 'locked_downgrade',
        message: `locked rule ${rule.id}: project effect "${rule.effect}" is weaker than base "${baseRule.effect}"`,
      });
      continue;
    }
    merged.set(rule.id, {
      ...baseRule,
      effect: strictness(rule.effect) > strictness(baseRule.effect) ? rule.effect : baseRule.effect,
      locked: baseRule.locked || rule.locked,
      match: unionMatch(baseRule.match, rule.match),
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, policy: { version: 1, rules: [...merged.values()] } };
}
