import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const load = (name: string) =>
  parse(readFileSync(fileURLToPath(new URL(`../../.github/workflows/${name}`, import.meta.url)), 'utf8'));

const pinned = (steps: { uses?: string }[]) => steps.filter((s) => s.uses).every((s) => /@[0-9a-f]{40}$/.test(s.uses!));

describe('reusable release workflows', () => {
  it('PR checks take no secrets and fail if EXPO_TOKEN is visible', () => {
    const wf = load('release-pr-checks.yml');
    expect(Object.keys(wf.on)).toEqual(['workflow_call']);
    expect(wf.on.workflow_call.secrets).toBeUndefined();
    const [first, ...rest] = wf.jobs.checks.steps;
    expect(first.run).toContain('exit 1');
    expect(JSON.stringify(rest)).not.toContain('secrets.');
    expect(pinned(wf.jobs.checks.steps)).toBe(true);
  });

  it('staging OTA runs only on push to main, publishes to staging, and uploads source maps', () => {
    const wf = load('release-staging-ota.yml');
    expect(Object.keys(wf.on)).toEqual(['workflow_call']);
    const job = wf.jobs['staging-ota'];
    expect(job.if).toBe(
      "github.event_name == 'push' && github.ref == 'refs/heads/main' && " +
        'github.actor == inputs.release-actor && github.triggering_actor == inputs.release-actor',
    );
    expect(wf.on.workflow_call.inputs['release-actor']).toMatchObject({ type: 'string', required: true });
    const script = job.steps.map((s: { run?: string }) => s.run ?? '').join('\n');
    expect(script).toContain('update --branch staging');
    expect(script).not.toContain('production');
    expect(script).toContain('sentry-expo-upload-sourcemaps dist');
    expect(pinned(job.steps)).toBe(true);
  });

  it('every job sets read-only permissions explicitly', () => {
    for (const name of ['release-pr-checks.yml', 'release-staging-ota.yml']) {
      for (const job of Object.values(load(name).jobs) as { permissions?: Record<string, string> }[]) {
        expect(job.permissions).toEqual({ contents: 'read' });
      }
    }
  });
});
