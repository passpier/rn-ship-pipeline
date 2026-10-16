# M1 acceptance (a) and (e)

## (a): no release credentials as `rnship-agent`

S0 already ran this check as `rnship-agent` (see `docs/spikes/S0.md`):
- N4: `gh pr merge` fails because there is no credential.
- E1: `eas submit --profile production` fails because there is no login.
- E2: `eas update --channel production` fails with "An Expo user account is required".

N1–N3 show the agent has no gh login, token, hosts file, keychain item or token env var. Nothing new had to run.

## (e): release workflows on the fixture repo

Run 2026-10-16 with `scripts/acceptance/m1e.sh`, as you, on `passpier/rnship-s6-probe` (private). The caller was pinned to rn-ship-pipeline `9e38463`. The workflow files haven't changed since. **Every check passed.**

The first two runs failed on setup (see below). The passing E2/E3 run is a push to the fixture's `main` made by hand after the Sentry fix. Its pin and workflows are the same as the third wizard run, which produced E1 and E4–E6. Raw results are in `docs/spikes/M1e.results.env` (gitignored).

| # | Check | Expected | Actual |
|---|---|---|---|
| E1 | Caller pins both reusable workflows to a 40-char SHA | yes | **yes** |
| — | Fixture's default `GITHUB_TOKEN` | read, can't approve | **read, false** |
| E2 | Your push to `main` publishes a staging EAS Update | success, group id | **success**, one update group for iOS and Android |
| E3 | …and uploads its source maps to Sentry | success | **success**: `npx sentry-expo-upload-sourcemaps dist` uploaded the iOS and Android `.hbc` bundle and map |
| E4 | PR opened by the broker's App runs PR checks | success, `EXPO_TOKEN` absent, staging skipped | **success, absent, skipped** |
| E5 | The App pushes straight to `main` | staging skipped, actor the bot | **skipped, `rnship-agent[bot]`** |
| E6 | You re-run that App push | staging skipped (`triggering_actor` is you, `actor` is still the bot) | **skipped** |

The upload command named in the plan as "[test the command name]" works. Whether Sentry symbolicates a frame from an OTA update is still S9.

## Setup failures, all fixed

**E2: the Expo robot token couldn't read the project.**
- `eas init` ran under your personal Expo login, so the project belonged to your personal account.
- The robot token came from your team account. Expo answered `Entity not authorized … action = READ`.
- The role wasn't the problem: Developer can read and publish. A robot sees only its own account's projects.
- Fix: transfer the project to the team account and set `expo.owner` in `app.json` to match.
- Keep the robot at Developer. Any role that can publish staging can publish production too (D1), so a higher role only adds risk.
- Stage 3 of the wizard now refuses a token that `eas project:info` can't use.

**E3: Sentry rejected the project.**
- The project ID was entered where the slug belonged.
- Unquoted in the caller YAML, it parsed as a number and reached the workflow in float notation (`4.5…E+15`). Sentry answered 400 "One or more projects are invalid".
- The wizard now quotes the caller's inputs and rejects an all-digit slug. The `release/README.md` example quotes them too.

**Wizard result bugs (the workflows behaved correctly):**
- E4 recorded `EXPO_TOKEN_ABSENT=no` although the log said absent. `grep -q` straight off `gh`'s pipe exits early and SIGPIPEs `gh`, and `pipefail` turns the match into a failure.
- E5/E6 came out empty. The run reported completed before its skipped reusable-workflow job was listed.
- The update group read as `${u[0].group}`. The log echoes the step's script, and the parser matched that echo.
- Fixes: logs are read into a variable first, jobs are polled until listed, and only output lines or UUIDs count.
- The wizard library's closing "Setup complete" prints whatever the results are. Read the result lines above it.

## Consequences

- An app repo's Expo project has to belong to the same account as its CI token. Check it with `eas project:info` before the first push.
- Quote string inputs in the caller.
- The fixture's `main` now holds a commit by the App. The next `rnship merge approve` there will refuse until you vouch with `--accept-main`.
