# Release: approvals and reusable workflows

`release/src` holds the approved baseline, approval records, and `rnship merge|release approve`. The reusable workflows live in `.github/workflows/release-*.yml`, because GitHub only calls reusable workflows from that directory. They are called from a private app repo, **pinned by commit SHA**, never by branch or tag (ADR 0001). The broker's GitHub App isn't installed on this repo (S0 G6), so nothing on the agent's side can change release logic.

| Workflow | Trigger in the caller | Secrets |
|---|---|---|
| `release-pr-checks.yml` | `pull_request` | **none**. The first step fails if `EXPO_TOKEN` is visible. |
| `release-staging-ota.yml` | `push` to `main` (after `rnship merge approve`) | `EXPO_TOKEN`, optional `SENTRY_AUTH_TOKEN` |

`release-staging-ota.yml` takes a required `release-actor` (your GitHub login). The job runs only when `github.actor` and `github.triggering_actor` are both that login. The broker's App token can push to `main` on a Free private repo, and that push triggers `on: push` as `rnship-agent[bot]` (S0 G8), so the gate skips it before checkout (S0 G9). Every job sets read-only `permissions`. Also set the app repo's default `GITHUB_TOKEN` to read-only.

## Merge approve and the `main` ledger
`rnship merge approve` records the merge commit it creates as the base head (`.rnship/state/main-heads/`). The next merge approve refuses if the base has moved since then: the move means something reached `main` without you. It prints the compare URL. After inspecting the change, vouch for the current head with `--accept-main <sha>`. The first merge in a repo needs `--accept-main` too.

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
      release-actor: <your GitHub login>
      sentry-org: <org>
      sentry-project: <project>
    secrets:
      EXPO_TOKEN: ${{ secrets.EXPO_TOKEN }}
      SENTRY_AUTH_TOKEN: ${{ secrets.SENTRY_AUTH_TOKEN }}
```

## Status
These workflows are written but not yet exercised. M1 acceptance (e) still has to be checked on the fixture repo, `passpier/rnship-s6-probe`. Run `scripts/acceptance/m1e.sh` as yourself, with main pushed to origin. It checks that:
- the caller is pinned by SHA;
- a staging OTA is published and its source maps are uploaded;
- the job runs only on your push to `main`, and a push by the broker's App skips it;
- a PR run shows `EXPO_TOKEN` is absent.
