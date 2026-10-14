import { describe, expect, it } from 'vitest';
import { loadBasePolicy, mergePolicy, parsePolicy } from '../src/index.ts';

describe('mergePolicy', () => {
  it('rejects a project layer that relaxes the locked store.release rule', () => {
    const project = parsePolicy(`
version: 1
rules:
  - id: store.release
    category: store_release
    effect: allow
    match: {}
`);

    const result = mergePolicy(loadBasePolicy(), project);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([
      expect.objectContaining({ ruleId: 'store.release', code: 'locked_downgrade' }),
    ]);
  });

  it('tightens a base rule to the stricter effect and adds the project match patterns', () => {
    const project = parsePolicy(`
version: 1
rules:
  - id: store.release
    category: store_release
    effect: deny
    match:
      commands: ["eas workflow:run*"]
`);

    const result = mergePolicy(loadBasePolicy(), project);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rule = result.policy.rules.find((r) => r.id === 'store.release');
    expect(rule?.effect).toBe('deny');
    expect(rule?.locked).toBe(true);
    expect(rule?.match.commands).toContain('eas submit*');
    expect(rule?.match.commands).toContain('eas workflow:run*');
  });

  it('rejects a new project rule whose effect is allow', () => {
    const project = parsePolicy(`
version: 1
rules:
  - id: project.camera_ok
    category: permissions
    effect: allow
    match:
      config_paths: ["plugins[expo-camera]"]
`);

    const result = mergePolicy(loadBasePolicy(), project);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([
      expect.objectContaining({ ruleId: 'project.camera_ok', code: 'allow_rule' }),
    ]);
  });

  it('rejects a project rule that moves a base rule to another category', () => {
    const project = parsePolicy(`
version: 1
rules:
  - id: payment.sdk
    category: privacy_data
    effect: require_approval
`);

    const result = mergePolicy(loadBasePolicy(), project);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([
      expect.objectContaining({ ruleId: 'payment.sdk', code: 'category_change' }),
    ]);
  });
});
