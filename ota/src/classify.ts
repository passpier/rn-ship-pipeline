import { changedGates, loadBasePolicy, type Gate, type Policy } from '@rnship/policy';
import { fingerprintFor, PLATFORMS, readBuild, type Platform } from './artifacts.ts';
import { appFingerprint, type FingerprintModule } from './fingerprint.ts';
import { GAP_RULES } from './gaps.ts';
import { loadProjectState } from './project.ts';
import { STORE_RULES } from './storePolicy.ts';

export type Verdict = 'OTA' | 'BUILD' | 'HUMAN';

export type Reason = { ruleId: string; platforms: Platform[]; verdict: Verdict; detail: string };

export type Classification = Record<Platform, Verdict> & {
  reasons: Reason[];
  /** Policy rules whose deps or config_paths changed; each needs its approval before release. */
  gates: Gate[];
  base_build_id: string;
  fingerprints: Record<Platform, { base: string; candidate: string }>;
};

export type ClassifyInput = {
  /** Checkout of the source the production build was made from. */
  base: string;
  /** Directory written by `recordBuild` for that production build. */
  artifacts: string;
  candidate: string;
  /** Merged policy; defaults to the base policy. */
  policy?: Policy;
};

export async function classify(input: ClassifyInput): Promise<Classification> {
  const build = readBuild(input.artifacts);
  const reasons: Reason[] = [];
  const fingerprints = {} as Classification['fingerprints'];
  const fingerprint = appFingerprint(input.candidate);
  if (build.fingerprintVersion && build.fingerprintVersion !== fingerprint.version) {
    // Different @expo/fingerprint versions hash differently: nothing to compare, so BUILD.
    reasons.push({
      ruleId: 'fingerprint.version_changed',
      platforms: [...PLATFORMS],
      verdict: 'BUILD',
      detail: `@expo/fingerprint ${build.fingerprintVersion} made the build's fingerprint; the candidate has ${fingerprint.version}`,
    });
  }

  for (const platform of PLATFORMS) {
    const candidate = await fingerprintFor(input.candidate, platform);
    const base = build.fingerprints[platform];
    fingerprints[platform] = { base: base.hash, candidate: candidate.hash };
    if (base.hash !== candidate.hash) {
      const changed = fingerprint.diffFingerprints(base, candidate).map(describeDiff);
      reasons.push({ ruleId: 'fingerprint.changed', platforms: [platform], verdict: 'BUILD', detail: changed.join(', ') });
    }
  }

  const base = { root: input.base, state: loadProjectState(input.base) };
  const candidate = { root: input.candidate, state: loadProjectState(input.candidate) };
  for (const rule of [...GAP_RULES, ...STORE_RULES]) {
    reasons.push(...rule({ build, base, candidate }));
  }

  const gates = changedGates(input.policy ?? loadBasePolicy(), base.state, candidate.state);

  return { ...verdicts(reasons), reasons, gates, base_build_id: build.buildId, fingerprints };
}

const RANK: Record<Verdict, number> = { OTA: 0, HUMAN: 1, BUILD: 2 };

// Most conservative verdict wins, per platform.
function verdicts(reasons: Reason[]): Record<Platform, Verdict> {
  const out = { ios: 'OTA', android: 'OTA' } as Record<Platform, Verdict>;
  for (const reason of reasons) {
    for (const platform of reason.platforms) {
      if (RANK[reason.verdict] > RANK[out[platform]]) out[platform] = reason.verdict;
    }
  }
  return out;
}

function describeDiff(item: ReturnType<FingerprintModule['diffFingerprints']>[number]): string {
  const source = item.op === 'added' ? item.addedSource : item.op === 'removed' ? item.removedSource : item.afterSource;
  return `${item.op} ${source.type === 'contents' ? source.id : source.filePath}`;
}
