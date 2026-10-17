# rn-ship-pipeline

Takes Expo-managed React Native apps from an approved change to a human-approved release with Claude Code. Agent executors write the app code; what sets it apart is the release side: deciding between an OTA update and a store build, approval gates that fail closed, quota-aware orchestration, and Sentry signals that start work.

**Status: pre-release.** Nothing is tagged until the whole pipeline runs end to end on a real app. M0 (policy engine, OTA classifier) and M1 are done. M1 covers the guard plugin, executor settings, `rnship policy check`, the approve commands, the validation sandbox, and the release workflow templates. Its acceptance ran on a private fixture app repo ([M1e](docs/spikes/M1e.md)). Scope, plan and milestones: [STATUS.md](STATUS.md).

## Requirements
Node 24 (`.nvmrc`) and pnpm 10 for the toolkit itself; its tests run anywhere, and the sandbox tests only on macOS.

Running the pipeline needs an Apple Silicon Mac (Intel isn't supported). On it:
- Xcode that fits the app's Expo SDK (SDK 55 builds with Xcode 26.3; ADR 0003), opened once, so Xcode downloads its SDK-to-simulator index.
- Node 24 for you and for `rnship-agent`.
- CocoaPods outside your home (Homebrew is fine), so the agent can run it too.
- `gh`, and eas-cli 24.13.x (release approvals refuse any other version).
- Watchman is optional. Both sandboxes turn it off, and Metro and jest use their node crawler instead.

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
- **`executor-settings.json`**: it allows edits and Bash inside the worktree only, since sessions run `--permission-mode dontAsk` and deny anything no rule allows. Pass it to every run as `claude -p --plugin-dir plugin --settings <file> --setting-sources user` (ADR 0002). Add `--plugin-dir plugins/rn-game` for game apps. The guard is always required, and rn-game is optional. Otherwise the agent can switch hooks off through project settings (S2).
- **`rnship sandbox run -- <cmd>`**: runs validation commands (tsc, jest, expo export) under `sandbox-exec`. Secrets are unreadable, writes to `~/.claude` and LaunchAgents are refused, and network goes only through an allowlisting localhost proxy.

## Approvals (run as you, never as `rnship-agent`)
```sh
rnship merge approve <sha> --pr <n>                    # PR head must equal <sha>; merges with --match-head-commit
                     [--accept-main <sha>]             # refuses if main moved since the last merge approve, until you vouch
rnship release approve build <sha> --platform all      # clean checkout at <sha> → eas build --profile production
rnship release approve submit <build-id>               # finished production build → eas submit
rnship release approve update <group-id> --rollout 10  # staging group built from HEAD → production at 10%
rnship release approve rollout <group-id> --percent 25 # next step (ota/rollout.yaml); judge the window first
rnship release approve rollback <group-id>             # revert the group's rollout
                       [--to-embedded --channel staging] # or point the channel back at the build's embedded update
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

## Orchestrator (`rnship tick`)
The orchestrator owns all state in one SQLite file (`$RNSHIP_DB`, default `~/.rnship/orchestrator.db`, owned by `rnship-agent`). Executors are stateless adapters behind one interface: `fake` for simulations, `claude-p` (one fresh `claude -p` session per task), and `ralphex` (pinned v1.7.0; see `docs/spikes/S8.md`). Both live adapters are tested against a stub claude. Live runs on Pro are M3's acceptance: `scripts/acceptance/m3.sh` runs both as `rnship-agent` on the fixture app.

**ralphex is one adapter, not a dependency.** The Ralph loop (a fresh Claude session per task, repeated until validation passes) is the pattern. ralphex is the first runner wired to it, because S8 verified its internals. The orchestrator core (tick, states, ledger, retries, validation, diff check) never calls it. Everything specific to ralphex lives in `orchestrator/src/executors/` (`ralphex.ts`, `ralphexPlan.ts`). `claude-p` (`claudeP.ts`) runs the loop with no runner in between. Another runner, such as ralph-orchestrator, can sit behind the same `Executor` interface if it:
- runs headless and exits per batch, instead of sleeping on quota itself;
- starts every Claude session through `orchestrator/bin/claude-shim.ts` (or an equivalent guard-plugin init check) with the ADR 0002 flags;
- leaves stream-json transcripts, so the adapter can read usage, denials, and reset times.

The orchestrator re-runs validation and `rnship policy check` itself, so it never trusts a runner's own checks. Adding another runner needs a new adapter and a spike like S8.

How `claude-p` runs a batch:
- **One session per task.** The prompt goes on stdin. Task bodies and failure digests sit inside fences.
- **Done means signalled and committed.** A task passes only when the session's final result ends with `<<<RNSHIP:TASK_DONE>>>` and HEAD has moved on the same branch, still descending from where the task started.
- **Leftovers.** Changes the session left uncommitted are committed by the adapter, with git hooks off, so the diff check sees them.
- **First failure stops the batch.** The first task that doesn't pass ends the batch, and the tasks before it count as done. That task's partial work, commits included, is saved as a patch and rolled back.

```sh
rnship tasks import tasks.yaml --app <name> --flow A --repo <app-repo>   # idempotent
rnship tick --executor claude-p --settings <executor-settings.json>       # one pass; the LaunchAgent runs it every 15 min
rnship tick --executor ralphex --settings <executor-settings.json>        # the same, through ralphex; add --plugin-dir plugins/rn-game for game apps
rnship tasks list
rnship ledger                                                             # usage per executor call: task, model that ran, tokens
rnship task approve <task-id> <head-sha>                                  # run as you: approves gated changes at exactly that commit
rnship signals poll --app <name> --repo <app-repo> --sentry-org <slug> --sentry-project <slug> --validation '<cmd>'
                                                                          # Flow B: Sentry issues → structured triage → tasks; its own job, never in tick
```

Each tick runs these steps:
1. Reclaims tasks left behind by a killed tick.
2. Reopens the Claude quota at its reset time, or after a probe when the reset time is unknown.
3. Leases a batch of same-tier tasks into a per-run worktree on `agent/run-<id>`, and runs the executor.
4. Re-runs each task's validation commands under the validation sandbox.
5. Diff-checks the result with `rnship policy check`.

Every live executor starts Claude through `orchestrator/bin/claude-shim.ts` (with ralphex, as `claude_command`). The shim stops any session whose `system/init` doesn't list the guard plugin, or reports another model than the pinned `--model`. It keeps the stream-json transcripts, which carry usage, denials, and reset times. The ledger records usage and the model that ran once per task with `claude-p`, and once per batch with ralphex, which can't split usage by task.

Retries follow the failure class: a validation failure retries at the same tier, then one tier up (`policy/routing.yaml`), then goes to you. A failed task whose session had tool calls denied goes to you at once, with the denials in its digest, since no retry or bigger model lifts a denial. A gated change waits for `rnship task approve`, and a new commit invalidates that approval.

## Layout
- `policy/`: schema, merge, compile, hook evaluator, sandbox lists, and model routing tiers
- `ota/`: the classifier
- `release/`: baseline, approvals, and approve commands
- `plugin/`: the guard plugin
- `plugins/rn-game/`: an optional knowledge plugin for building 2D games in Expo apps (skill `rn-2d-game`). It's listed in `.claude-plugin/marketplace.json`, so other projects can install it with `/plugin install rn-game --marketplace passpier/rn-ship-pipeline`.
- `orchestrator/`: state machine, tick, ledger, signal and stage dedup, and executor adapters
- `cli/`: the `rnship` bin, policy check, and the sandbox runner
- `fixtures/`: the made-up Expo app used by tests
- `.github/workflows/release-*.yml`: the reusable workflows
- `docs/adr/`: decision records
