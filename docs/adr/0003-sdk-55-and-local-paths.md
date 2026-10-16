# 0003: Expo SDK 55, and a local path for every build and check

Date: 2026-10-16. Status: accepted.

## Context
- **Xcode is stuck at 26.3.** This Mac has Xcode 26.3 and can't upgrade.
- **SDK 56 and later need Xcode 26.4.** Expo's support table ([docs.expo.dev/versions](https://docs.expo.dev/versions/latest/)) sets Xcode 26.4+ as the minimum for SDK 56, 57 and 58. SDK 55's minimum is 26.2+, with iOS 15.1+. So no iOS build of SDK 56 or later can happen on this Mac.
- **App Store floor.** Since 2026-04-28, App Store Connect requires Xcode 26 or later, which 26.3 meets.
- **SDK 57 maturity.** SDK 57 shipped with two Hermes V1 regressions ([changelog](https://expo.dev/changelog/sdk-57)). Both are fixed in later patches (57.0.9 and 57.0.17), but issues are still open, such as an Android SIGABRT whose fix wasn't backported ([expo#51305](https://github.com/expo/expo/issues/51305)).
- **No single hosted path.** You won't depend only on EAS Build or GitHub Actions.
- **Fingerprint versions differ by SDK.** Each SDK ships its own `@expo/fingerprint`: SDK 55 uses 0.16.8 and SDK 57 uses 0.20.x. The classifier used its own copy (0.20), so for an SDK 55 app it could predict a runtime version that the app's `expo-updates` never computes.

## Decision
- **SDK 55.** The real app, the private fixture repo and `fixtures/` target Expo SDK 55 (React Native 0.83, React 19.2.0).
  - Moving to a later SDK needs both Xcode 26.4+ on this Mac and that SDK having had patch releases for a while.
  - Each move is a baseline delta, approved like any other.
- **The app's own fingerprint.** The classifier fingerprints with the `@expo/fingerprint` that the app's `expo` package depends on, never with a copy of its own.
  - `rnship ota record` stores that version in `build.json`.
  - A candidate whose version differs gets `fingerprint.version_changed`, which forces BUILD.
  - An app without `expo` fails closed.
- **A local path for every build and check.** Each one can run on this Mac. EAS Build and GitHub Actions are one path, never the only one.
  - **Store builds:** a local mode for `rnship release approve build`, run as you, because signing credentials are yours.
  - **Development verification builds:** simulator and emulator builds of a task's result, for smoke tests beyond `tsc`.
  - **PR checks and staging:** the checks the reusable workflows run can also run locally through `rnship`.
  - **OTA publishing stays on EAS Update.** There's no self-hosted updates server.

## Consequences
- **SDK 55 ages out sooner.** npm `latest` is already 58, and Expo patches only the newest SDKs.
- **rn-game redo.** `plugins/rn-game` and `docs/research/rn-2d-game.md` were researched against SDK 57's packages (Skia 2.6.2, Reanimated 4.5.1, Gesture Handler 2.32). They need redoing for SDK 55's (Skia 2.4.18, Reanimated 4.2.1, Gesture Handler ~2.30.0, expo-audio ~55.0.18) before the first real app work.
- **Local builds are bounded by this Mac's Xcode.** That bound is why this ADR picks SDK 55.
- **A spike comes first (S12).** It needs to check, with Xcode 26.3:
  - whether `rnship-agent` can run simulator builds (no signing) under the validation sandbox;
  - whether a local release build is better done with `eas build --local` or with `expo prebuild` plus `xcodebuild`/Gradle.
- **Workspace dependency fixes.** In the pnpm workspace, expo 55's `'*'` optional peer `@expo/dom-webview` resolved to SDK 57's 57.x, which `@expo/log-box` 55 rejects. `pnpm-workspace.yaml` overrides it to `~55.0.6`.
  - One peer warning remains: SDK 55's `@expo/require-utils` wants TypeScript 5, and the workspace uses 6. It's harmless for `fixtures/app`, which has no TypeScript config.
