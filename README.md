# rn-ship-pipeline

Takes Expo-managed React Native apps from an approved change to a human-approved release with Claude Code. It focuses on the release side: deciding between an OTA update and a store build, approval gates that fail closed, quota-aware orchestration, and Sentry signals that start work.

**Status: v0.1 in progress.** M0 (policy engine, OTA classifier) is done. Most of M1 is in: the guard plugin, executor settings, `rnship policy check`, the approve commands, the validation sandbox, and the release workflow templates. M1 acceptance (a), which needs the `rnship-agent` user (S0), and (e), which needs a fixture app repo, are still open. Plan and milestones: issue #1.

## Requirements
Node 24 (`.nvmrc`) and pnpm 10.

```sh
pnpm install
pnpm test        # policy + classifier fixture suite (no LLM, no network after install)
```

## `rnship policy`
Policy is one YAML source (`policy/base.yaml`) compiled into every enforcement layer. An app's `.rnship/policy.yaml` can only add rules or tighten them. A project layer that relaxes a locked rule fails the merge.

```sh
rnship policy merge .rnship/policy.yaml                  # merged policy as JSON; exit 1 names the offending rule
rnship policy compile .rnship/policy.yaml --out build/   # settings.json, hook-rules.json, executor-settings.json, optional CODEOWNERS
rnship policy check . --base-ref <sha>                    # the diff check after every executor run; exit 1 names each gate
rnship baseline approve .rnship/approved-baseline.yaml   # run as you: approve the Stage 0 baseline once
```

`policy check` handles each kind of match differently:
- **`files` matches and protected paths** (`.claude/`, `.rnship/`, `.github/`, `smoke/`) fire on contact.
- **`deps` and `config_paths` matches** fire only on a change beyond the approved baseline.
- **Without an approved baseline**, the `deps` and `config_paths` rules fire on any contact with `package.json` or the app config instead (fail closed).

## Guardrails for the executor
- **`plugin/`**: a Claude Code plugin whose `PreToolUse` hook (`onFailure: block`) blocks commands and edits that the compiled policy gates. It sees through `sh -c`, `npx eas-cli`, env prefixes, and `$(…)`. It's early feedback, not the gate.
- **`executor-settings.json`**: pass it to every run as `claude -p --plugin-dir plugin --settings <file> --setting-sources user` (ADR 0002). Otherwise the agent can switch hooks off through project settings (S2).
- **`rnship sandbox run -- <cmd>`**: runs validation commands (tsc, jest, expo export) under `sandbox-exec`. Secrets are unreadable, writes to `~/.claude` and LaunchAgents are refused, and network goes only through an allowlisting localhost proxy.

## Approvals (run as you, never as `rnship-agent`)
```sh
rnship merge approve <sha> --pr <n>                    # PR head must equal <sha>; merges with --match-head-commit
                     [--accept-main <sha>]             # refuses if main moved since the last merge approve, until you vouch
rnship release approve build <sha> --platform all      # clean checkout at <sha> → eas build --profile production
rnship release approve submit <build-id>               # finished production build → eas submit
rnship release approve update <group-id> --rollout 10  # staging group built from HEAD → production at 10%
```
Each approval is digest-bound and single-use. Records go to `.rnship/state/approvals/`. Reusable PR-check and staging-OTA workflows: `release/README.md`.

## `rnship ota`
The classifier decides, per platform, whether a change can ship as an EAS Update. Its checks are deterministic, and no LLM makes the call.

```sh
rnship ota record <project-root> --out artifacts/ --build-id <eas-build-id>   # at build time: fingerprint + native manifest
rnship ota classify --base <checkout-of-build-sha> --artifacts artifacts/ --candidate .
```

The output is `{ ios, android, reasons[], gates[], base_build_id, fingerprints }`, where each verdict is `OTA`, `BUILD`, or `HUMAN` and the most conservative result wins. The checks run in three layers:
1. **`fingerprint.changed`:** the `@expo/fingerprint` diff against the production build's recorded fingerprint.
2. **Known fingerprint gaps (force BUILD):**
   - `gap.inline_config_plugin`
   - `gap.fingerprint_config`
   - `gap.updates_config`
   - `gap.native_patch`
   - `gap.unknown_native_module`: app JS looks up a native module that isn't in the build's `native-manifest`.
3. **Store review risk (HUMAN):** `store.permission_prompt`, `store.new_screen`.

`gates` lists the policy rules whose `deps` or `config_paths` changed (for example `permissions.native` when `expo-camera` is added). Each needs approval before release.

Recommended runtime policy: `runtimeVersion: { policy: "fingerprint" }`.

## Layout
- `policy/`: schema, merge, compile, hook evaluator, and sandbox lists
- `ota/`: the classifier
- `release/`: baseline, approvals, and approve commands
- `plugin/`: the guard plugin
- `cli/`: the `rnship` bin, policy check, and the sandbox runner
- `fixtures/`: the made-up Expo app used by tests
- `.github/workflows/release-*.yml`: the reusable workflows
- `docs/adr/`: decision records
