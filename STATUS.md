# Status

Last updated: 2026-10-16. This file is the source of truth for scope, progress and what's next. Full design (local, not in the repo): `~/.claude/plans/pasted-content-id-577e-https-github-com-indexed-matsumoto.md` (§2 stage contracts, §7 build order, §8 spikes).

## Scope

- **In scope:** the release side (OTA classifier, approval gates, guardrails, release workflows, Sentry signals, store submission) **and app development**. The A6 (Flow A) and B4 (Flow B) executors write the app's RN code via `claude -p` / ralphex. Development work isn't visible in the code yet only because the executors land in M3 and Flow A in M5.
- **Out of scope:** greenfield generation (picking a stack from scratch, generating a whole app). The app starts as a hand-built Expo skeleton (Stage 0) with a hand-approved baseline. Every feature after that enters as a change request (Flow A). Sentry bugs go through Flow B.
- `plugins/rn-game` holds reusable 2D game dev knowledge for the first app (a fish-tank game). Keep it generic: no app identifiers.

## Hard constraints

- $20 total including Claude Pro; $0 API.
- This workflow repo is public; app repos may be private.
- The dependency allowlist is approved once, at Stage 0. Later additions are baseline deltas, each approved.
- Hard release gate: the `rnship-agent` OS user holds no credentials; you run `rnship merge|release approve`.

## Done

- **M0:** policy merge/compile, OTA classifier, `rnship` CLI, fixtures.
- **M1 (mostly):** guard plugin, executor settings, `rnship policy check`, approve commands, validation sandbox, release workflow templates, actor gate, job permissions.
- **Spikes:** S0 identity + GitHub broker, S1 Pro billing, S2 hooks under `-p`, S6 GitHub/EAS budgets, S8 ralphex internals (pinned v1.7.0; it doesn't run validation commands or parse reset times). Findings in `docs/spikes/`.
- **M2:** orchestrator state machine (SQLite), tick, ledger, signal + stage dedup, task approvals, `rnship tick|tasks|task approve`; fake executor and ralphex adapter (shim with init check, run against a stub claude on the pinned v1.7.0 binary). Acceptance simulations pass. Ships as v0.2 together with M3.
- **rn-game plugin:** `rn-2d-game` skill.

## Next

1. **Finish M1 → ship v0.1:** acceptance (a) as `rnship-agent` (`eas submit`, `eas update --channel production` and `gh pr merge` all fail) and (e) fixture app repo calling the workflows pinned by SHA (`scripts/acceptance/m1e.sh`).
2. **S4** quota error shape (five-hour window). Until then, unrecognized limits park until a probe; its captures become the ralphex adapter's `extraLimitPatterns`.
3. **M3** live `claude-p` and ralphex adapters on Pro, as `rnship-agent` → ships **v0.2** with M2. First real app dev happens here.
4. **S5** fingerprint runtime policy + **S9** Sentry source maps for EAS Update + **S10** EAS `require-approval` (optional).
5. **M4** Flow B on Sentry (poll, triage, fix, OTA, rollout, rollback). **S7** Crashlytics later (M4b).
6. **M5** Flow A change-intake (change request, impact gate, baseline delta, design, `rnship change approve`, tasks).
7. **M6** upgrade, perf budgets, store submission.

Also pending: **S3** skills under `-p`.

## Open decisions

- Living spec / OpenSpec: decide at S11, before M5.
- Marketing-research source and format (treat as untrusted until known).
