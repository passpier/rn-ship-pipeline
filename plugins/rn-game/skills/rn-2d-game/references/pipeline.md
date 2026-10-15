# Working inside rn-ship-pipeline

Read this when the app is built through rn-ship-pipeline (it has an `.rnship/` directory). If it doesn't, skip this file.

## Dependencies are fixed by the approved baseline
- Executors can't install packages. `npx expo install`, `npm i`, `pnpm add` and the like are denied by rule `deps.install`.
- Any change to `package.json` beyond `.rnship/approved-baseline.yaml` fires `deps.upgrade`, which needs approval.
- So the game stack in [stack.md](stack.md) belongs in the **Stage 0 baseline**, approved once. That means Skia, Reanimated, Worklets, Gesture Handler, expo-audio, and the storage package.
- If a task seems to need a package that isn't in the baseline, stop and say so. The orchestrator turns this into `awaiting_approval`. Don't work around it by vendoring the package's code.

## What ships as an OTA update and what needs a store build
The classifier (`rnship ota classify`) decides. Don't predict its verdict in code comments or PR text. As a rough guide:

| Change | Usual verdict | Why |
|---|---|---|
| New sprite or sound under `assets/`, tuning constants, sim logic, HUD layout | OTA | JS and assets only |
| A new native package or an Expo config plugin | BUILD | Fingerprint changes. It's also a baseline delta. |
| A new route file under `app/` | HUMAN | `store.new_screen` |
| A new `request…PermissionsAsync` call | HUMAN | `store.permission_prompt` |
| IAP products (`store/products.yaml`) or a payment SDK | needs approval | `iap.pricing`, `payment.sdk` |
| Ads or analytics SDKs | needs approval | `privacy.data` |

Known blind spot: a new game mode drawn inside the existing canvas adds no route, so `store.new_screen` doesn't fire. If a change alters what the game *is* (a new mode, a new economy, rewards tied to purchases), say so in the PR description so the human can choose a store review.

## Tests the agent can run
- **Sim logic:** pure functions over plain data, tested with jest (see [simulation.md](simulation.md)). This is where game correctness gets checked. Seed the RNG in tests.
- **HUD:** RN views with `testID`s. Maestro smoke flows (`smoke/*.yaml`, a protected path) drive them. Maestro can't see inside a Skia canvas, so anything a flow must tap or assert needs to be an RN view, or have a transparent `Pressable` with a `testID` over the canvas region.
- **Reassure** measures React renders, and a canvas animated through shared values does almost none. Don't add Reassure tests for the canvas. Cover the frame budget with [perf.md](perf.md) instead.
- **Bundle size budgets** count the JS bundle. Image and audio assets are separate files, but they still count against OTA download size, so compress them.
