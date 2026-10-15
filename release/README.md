# Release: approvals and reusable workflows

`release/src` holds the approved baseline, approval records, and `rnship merge|release approve`. The reusable workflows live in `.github/workflows/release-*.yml`, because GitHub only calls reusable workflows from that directory. They are called from a private app repo, **pinned by commit SHA**, never by branch or tag (ADR 0001). The agent's machine account has no access to this repo, so it can't change release logic.

| Workflow | Trigger in the caller | Secrets |
|---|---|---|
| `release-pr-checks.yml` | `pull_request` | **none**. The first step fails if `EXPO_TOKEN` is visible. |
| `release-staging-ota.yml` | `push` to `main` (after `rnship merge approve`) | `EXPO_TOKEN`, optional `SENTRY_AUTH_TOKEN` |

Production steps never run in CI. You run them on the release Mac:
- `rnship release approve build <sha> --platform all`
- `rnship release approve submit <build-id>`
- `rnship release approve update <staging-group-id> --rollout 10`

## Caller example (`.github/workflows/rnship.yml` in the app repo)

```yaml
name: rnship
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  pr-checks:
    if: github.event_name == 'pull_request'
    uses: passpier/rn-ship-pipeline/.github/workflows/release-pr-checks.yml@<40-char SHA>
    with:
      rnship-sha: <same 40-char SHA>
    # No `secrets:` here, and never `secrets: inherit`.
  staging-ota:
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    uses: passpier/rn-ship-pipeline/.github/workflows/release-staging-ota.yml@<40-char SHA>
    with:
      sentry-org: <org>
      sentry-project: <project>
    secrets:
      EXPO_TOKEN: ${{ secrets.EXPO_TOKEN }}
      SENTRY_AUTH_TOKEN: ${{ secrets.SENTRY_AUTH_TOKEN }}
```

## Status
These workflows are written but not yet exercised. M1 acceptance (e) still has to be checked on a private fixture repo: the caller pinned by SHA, a staging OTA published, source maps uploaded, the job triggered only on push to `main`, and a PR run that shows `EXPO_TOKEN` absent.
