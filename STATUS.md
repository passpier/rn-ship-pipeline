# Status

Last updated: 2026-10-17. This file is the source of truth for scope, progress and what's next. Full design (local, not in the repo): `~/.claude/plans/pasted-content-id-577e-https-github-com-indexed-matsumoto.md` (§2 stage contracts, §7 build order, §8 spikes).

## Scope

- **In scope:** the release side (OTA classifier, approval gates, guardrails, release workflows, Sentry signals, store submission) **and app development**. The A6 (Flow A) and B4 (Flow B) executors write the app's RN code via `claude -p` / ralphex. Development work isn't visible in the code yet only because the executors land in M3 and Flow A in M5.
- **Out of scope:** greenfield generation (picking a stack from scratch, generating a whole app). The app starts as a hand-built Expo skeleton (Stage 0) with a hand-approved baseline. Every feature after that enters as a change request (Flow A). Sentry bugs go through Flow B.
- `plugins/rn-game` holds reusable 2D game dev knowledge for the first app (a fish-tank game). Keep it generic: no app identifiers.

## Hard constraints

- $20 total including Claude Pro; $0 API.
- This workflow repo is public; app repos may be private.
- The dependency allowlist is approved once, at Stage 0. Later additions are baseline deltas, each approved.
- Hard release gate: the `rnship-agent` OS user holds no credentials; you run `rnship merge|release approve`.
- Not open for use until every feature runs end to end and is verified on the real app (decided 2026-10-16): no release tag before that, and no interim v0.x releases.
- This Mac has Xcode 26.3 and can't upgrade, so the app and fixtures target **Expo SDK 55** (SDK 56+ need Xcode 26.4). Every build and check has a local path; EAS Build and GitHub Actions are never the only one. OTA stays on EAS Update. ADR 0003.

## Done

- **M0:** policy merge/compile, OTA classifier, `rnship` CLI, fixtures.
- **M1:** guard plugin, executor settings, `rnship policy check`, approve commands, validation sandbox, release workflow templates, actor gate, job permissions. Acceptance (a) is met by S0 N4/E1/E2. Acceptance (e) passed on the fixture repo: staging OTA, Sentry source-map upload, actor gate (`docs/spikes/M1e.md`).
- **Spikes:** S0 identity + GitHub broker, S1 Pro billing, S2 hooks under `-p`, S6 GitHub/EAS budgets, S8 ralphex internals (pinned v1.7.0; it doesn't run validation commands or parse reset times). Findings in `docs/spikes/`.
- **M2:** orchestrator state machine (SQLite), tick, ledger, signal + stage dedup, task approvals, `rnship tick|tasks|task approve`; fake executor and ralphex adapter (shim with init check, run against a stub claude on the pinned v1.7.0 binary). Acceptance simulations pass.
- **M3 (code):** `claude-p` adapter (one session per task) against stub claude; the shim also fails closed when a session runs another model than the pinned one; `--plugin-dir` for knowledge plugins. The ralphex refactor was re-checked on the v1.7.0 binary. Both sandboxes (Claude's Bash sandbox and the validation Seatbelt profile) now deny reads of other users' homes and mounted volumes; the Seatbelt profile also denies system keychains, raw disks and mounting (taken from sandvault, reviewed 2026-10-17; sandvault itself doesn't fit: its outer `sandbox-exec` breaks every nested one). `rnship-agent` gets a group of its own instead of staff; the shared M3 dir is yours, group `rnship-agent`, 1770 instead of 1777. The ledger logs usage and model per task (per batch for multi-task ralphex batches); `rnship ledger`. Acceptance wizard `scripts/acceptance/m3.sh`.
- **rn-game plugin:** `rn-2d-game` skill, researched against SDK 55's packages (Skia 2.4.18, Reanimated 4.2.1, Worklets 0.7.4, Gesture Handler 2.30, expo-audio 55) at their source tags; `docs/research/rn-2d-game.md`.
- **SDK 55 (ADR 0003):** `fixtures/` on SDK 55; the classifier fingerprints with the app's own `@expo/fingerprint` and forces BUILD when its version changed since the build.
- **Private fixture on SDK 55:** `passpier/rnship-s6-probe` runs expo 55, RN 0.83 and TypeScript ~5.9 with a hand-approved baseline. `tsc` and `expo-doctor` (20/20) pass. The staging OTA and the Sentry source-map upload ran green on SDK 55 (2026-10-16).

## Next

1. **M3** live runs of the `claude-p` and ralphex adapters on Pro, as `rnship-agent`: run `scripts/acceptance/m3.sh` (yours; findings go to `docs/spikes/M3.md`). First live attempt (2026-10-16): `init.model` reports the pinned IDs (`claude-sonnet-5-5`, `claude-opus-5-5`), and the ledger logs each task. It failed because the guard matched `.rnship/**` against the worktree's absolute path (`~/.rnship/…/worktrees/`) and blocked every write; fixed. Second attempt (same day): `--permission-mode dontAsk` with no `allow` rules denied every write and Bash call (and ralphex's plan file, outside the worktree); fixed by compiled allow rules scoped to the worktree and an `--allowedTools` for the plan file alone (ADR 0002). A failed task with denied tool calls now goes to you at once instead of escalating to T2. The wizard now runs a one-session Haiku preflight with the real flags and settings before any Sonnet run; it also checks that the session runs without staff and that sandboxed Bash can't read other paths under `/Users`. Before the run, the wizard offers to move `rnship-agent` out of staff, which takes one log-out and log-in of the agent. Both executor prompts used to tell the agent to run `rnship sandbox run -- …`. Inside Claude's Bash sandbox that nests `sandbox-exec`, which macOS refuses (`sandbox_apply: Operation not permitted`, exit 71, checked 2026-10-17). The prompts now list the validation commands bare, since the Bash sandbox already applies the same denies and allowlist. The gate still re-runs them under `rnship sandbox run`, outside Claude. Known gap the run will show: an allowlisted dependency lands in package.json without a lockfile update, because the executor may not install (fix by M5).
2. **S4** quota error shape (five-hour window). Until then, unrecognized limits park until a probe; its captures become the ralphex adapter's `extraLimitPatterns`.
3. **S12 + local paths** (ADR 0003): spike simulator/emulator builds as `rnship-agent` and local release builds with Xcode 26.3 (`eas build --local` vs prebuild + xcodebuild/Gradle). The wizard `scripts/spikes/s12.sh` is written (iOS only; unsigned Release builds; signed archives wait for M6) and is yours to run; findings go to `docs/spikes/S12.md`. It runs prebuild, pods, the build and a simulator smoke under `rnship sandbox run`, headless (a LaunchDaemon with `UserName`) and in the GUI session. The sandbox proxy now prints each refused host and no longer crashes when a refused client resets. After the spike: a local mode for `rnship release approve build`, development verification builds, and local PR checks/staging. The spike also decides whether `rnship-agent` still needs a GUI session. If simulator checks don't need it: run headless (`claude setup-token` read into env from a 0600 file, a LaunchDaemon with `UserName`, a hidden user with a random password, and a tick that survives reboots). If they do: consider sandvault's `sv-ios-bridge` pattern, where the simulator runs on your side and the agent calls a whitelisted HTTP bridge.
4. **S5** fingerprint runtime policy + **S9** Sentry source maps for EAS Update + **S10** EAS `require-approval` (optional).
5. **M4** Flow B on Sentry (poll, triage, fix, OTA, rollout, rollback). **S7** Crashlytics later (M4b).
6. **M5** Flow A change-intake (change request, impact gate, baseline delta, design, `rnship change approve`, tasks).
7. **M6** upgrade, perf budgets, store submission.

Also pending: **S3** skills under `-p`. An **agent evaluation** suite (repeatable fixture cases scored per prompt, model and adapter), after the M3 acceptance.

## Open decisions

- Living spec / OpenSpec: decide at S11, before M5.
- Marketing-research source and format (treat as untrusted until known).
