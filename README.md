# rn-ship-pipeline

Takes Expo-managed React Native apps from an approved change to a human-approved release with Claude Code. It focuses on the release side: deciding between an OTA update and a store build, approval gates that fail closed, quota-aware orchestration, and Sentry signals that start work.

**Status: v0.1 in progress (M0).** Today this repo ships the policy engine and the OTA classifier. The orchestrator, guardrail hooks, and release workflows come next. Plan and milestones: issue #1.

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
rnship policy compile .rnship/policy.yaml --out build/   # settings.json (Claude deny/ask), hook-rules.json, optional CODEOWNERS
```

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
`policy/` (schema, merge, compile), `ota/` (classifier), `cli/` (`rnship` bin), `fixtures/` (made-up Expo app used by tests), `docs/adr/`.
