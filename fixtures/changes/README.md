# Flow A change fixtures (M5)

One change folder per M5 acceptance case (design §7). Each has the `change-request.yaml` you'd
write and `stub-answers.json`, the canned model answers the tests feed the stub claude. The live
wizard (`scripts/acceptance/m5.sh`) copies the requests into the fixture app repo and asks the
real models instead.

| Folder | Case | Expected |
|---|---|---|
| `settings-screen` | (1) adds a screen | `go`, lint-clean tasks, a smoke flow per user-facing AC |
| `tank-photo` | (2) adds the camera permission | `go-dev-build` with a baseline delta; no task leases before you approve it |
| `carplay-dashboard` | (3) a CarPlay need | `stop`, citing `suitability.carplay` |
| `daily-streak` | (4) research with an injected instruction | no line of the research file reaches any prompt |

Case (5), an edit after `rnship change approve`, reuses `settings-screen`.
