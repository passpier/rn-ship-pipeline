# Stack

| Package | SDK 55 | Role |
|---|---|---|
| `@shopify/react-native-skia` | 2.4.18 | canvas, sprites (Atlas), pictures |
| `react-native-reanimated` | 4.2.1 | shared values, `useFrameCallback` |
| `react-native-worklets` | 0.7.4 | UI-thread functions, `scheduleOnRN` |
| `react-native-gesture-handler` | ~2.30.0 | touch input |
| `expo-audio` | ~55.0.18 | sound effects, music |
| `expo-sqlite` (its `kv-store`) or `@react-native-async-storage/async-storage` | ~55.0.20 / 2.2.0 | saves |

These versions were checked on 2026-10-17. Apps under rn-ship-pipeline target Expo SDK 55 (React Native 0.83, React 19.2.0). The source of truth is the app's own SDK: install with `npx expo install <pkg>`, and check with `npx expo install --check`. That is the environment's job, so don't hand-pin versions.

## Facts that shape the code
- **New Architecture only.** SDK 55+ has no Legacy Architecture, and Reanimated 4 requires Fabric.
- **Leave Hermes v1 off on SDK 55.** It's opt-in there, builds React Native from source, and has known memory and startup regressions. The default Hermes is fine.
- **Babel needs no setup.** `babel-preset-expo` adds `react-native-worklets/plugin`. Leave `babel.config.js` alone for this.
- **Threading names (Reanimated 4).** Import from `react-native-worklets`:
  - `scheduleOnRN(fn, ...args)` replaces `runOnJS(fn)(...args)`.
  - `scheduleOnUI(fn, ...args)` replaces `runOnUI`.
  - The old names are deprecated.
- **Docs run ahead of SDK 55.** The library docs sites track the latest releases (Skia 2.14, Reanimated 4.7, Gesture Handler 3.4), so check that an API exists in the installed version. These are newer than SDK 55 and must not be used:
  - `useSharedValue(() => …)` lazy init (Reanimated 4.4). On 4.2 it stores the function itself.
  - Atlas `colorBlendMode` (Skia 2.6). Use `blendMode`.
  - `select()` and the Android `surfaceType` canvas option (Skia 2.14).
  - The Gesture Handler 3 hook API (`usePanGesture({...})`, `onActivate`/`onDeactivate`). SDK 55 bundles 2.x, which uses the builder API (`Gesture.Pan()` with `<GestureDetector>`).
- **Skia's docs moved** to `wcandillon.github.io/react-native-skia` (the repo is `wcandillon/react-native-skia`, tag `v2.4.18` for SDK 55). The npm name is still `@shopify/react-native-skia`.
- **Expo Go doesn't cover SDK 55 on iOS devices.** The App Store's Expo Go stops at SDK 54. An SDK 55 Expo Go installs on Android and the iOS Simulator from expo.dev/go, and on an iPhone only through `eas go` and TestFlight. Every package above is included in Expo Go, but use a development build for real work, as Expo recommends for production apps.

## Sources
- Bundled versions: https://github.com/expo/expo/blob/sdk-55/packages/expo/bundledNativeModules.json
- SDK 55 notes: https://expo.dev/changelog/sdk-55
- Expo Go and SDK versions: https://docs.expo.dev/troubleshooting/expo-go-version-mismatch/
- Reanimated 3 to 4 migration (4.2.1): https://github.com/software-mansion/react-native-reanimated/blob/4.2.1/docs/docs-reanimated/docs/guides/migration-from-3.x.md
- Research notes with citations: `docs/research/rn-2d-game.md` in the rn-ship-pipeline repo
