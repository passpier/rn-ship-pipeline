# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Public toolkit that takes Expo React Native apps from an approved change to a human-approved release, with Claude Code as the executor. Architecture and CLI: `README.md`.

## Status and scope

@STATUS.md

Answer status and scope questions from STATUS.md only. Don't infer scope from README wording or from which code exists yet. Update STATUS.md in the same commit as work that changes it.

## Workflow (solo, pre-production)

- Commit straight to `main`. No branches, GitHub issues or PRs in this repo until production.
- Commit message: one line, `<M#|S#>: <what>`, no body. Never add `Co-Authored-By` or any other trailer.
- `agent/*` branches and broker-opened PRs are product behavior for app repos, not a workflow for this repo.

## Commands

Node 24 required: `.ts` runs directly via type stripping, no build step. pnpm 10.

- Check like CI: `pnpm typecheck && pnpm lint && pnpm test`.
- Single test: `pnpm vitest run cli/test/check.test.ts` or `pnpm vitest run -t "<name>"`.
- CLI: `pnpm exec rnship …` or `node cli/src/main.ts …`.
- A new top-level package must be added to `tsconfig.json` `include` and the `vitest.config.ts` include globs, or it is silently not checked or tested.
- Imports use explicit `.ts` extensions. `erasableSyntaxOnly` is on: no enums, namespaces or parameter properties.
- Sandbox tests skip off macOS, so ubuntu CI doesn't run them. Run them locally.
- Don't run `scripts/spikes/*` or `scripts/acceptance/*`: they're human wizards (macOS users, GUI logins). `scripts/spikes/s2/run-all.sh` makes real `claude -p` calls.

## Rules that must hold

- Public repo (ADR 0001): never commit real bundle IDs, EAS project IDs, owners or Sentry DSNs. Fixtures use `com.example.*` and `rnship-*` slugs.
- Workflows: third-party actions pinned by commit SHA with a `# vX` comment; every job sets read-only `permissions`; `release-pr-checks.yml` never receives secrets; the actor gate stays before checkout. `release/test/workflows.test.ts` asserts these.
- Everything fails closed. The guard hook exits 2 on missing `RNSHIP_HOOK_RULES`, bad stdin or a crash.
- Executor runs use `claude -p --plugin-dir plugin --settings <file> --setting-sources user` (ADR 0002). `--settings` is always a file path, never inline JSON.
- Secrets never go on argv (other users can read it); env is fine. `rnship-agent` holds no GitHub or Expo credential.
- `plugin/` is the security-only guard plugin. Dev-knowledge skills go under `plugins/`.

## Domain docs

Single-context: `CONTEXT.md` (created lazily), ADRs in `docs/adr/`, spike findings in `docs/spikes/`. See `docs/agents/domain.md`.
