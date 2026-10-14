# 0001: The project layer stays in the app repo

Date: 2026-10-14. Status: accepted.

## Context
This workflow repo is public, and app repos may be private. Each app keeps project-specific state: the `.rnship/` layer (change requests, ADRs, `approved-baseline.yaml`, approval records, and the project `policy.yaml`).

## Decision
- `.rnship/` lives only in the app repo. Nothing from it is committed here.
- `fixtures/` here uses made-up identifiers only (`com.example.*`, slugs `rnship-*`, a zero-UUID update URL). No real bundle IDs, EAS project IDs, owners, or Sentry DSNs appear anywhere in this repo.
- App repos call this repo's reusable workflows pinned to a commit SHA, never to a branch or tag. The agent's GitHub machine account has no access to this repo.
- The project policy layer can only add rules or tighten them (`rnship policy merge` enforces this). Base rules live in `policy/base.yaml`.

## Consequences
- Public CI logs here can never contain app details, because no app data reaches this repo.
- A compromised agent can't change release logic: it can't write here, and app repos run a pinned SHA.
- Updating release logic for an app means bumping the pinned SHA in that app repo, which is a reviewed change.
