# Stack

| Package | SDK 57 (stable) | SDK 58 (beta) | Role |
|---|---|---|---|
| `@shopify/react-native-skia` | 2.6.2 | 2.14.0 | canvas, sprites (Atlas), pictures |
| `react-native-reanimated` | 4.5.1 | 4.7.1 | shared values, `useFrameCallback` |
| `react-native-worklets` | 0.10.1 | 0.13.0 | UI-thread functions, `scheduleOnRN` |
| `react-native-gesture-handler` | ~2.32.0 | ~3.3.0 | touch input |
| `expo-audio` | ~57.0.5 | ~58.0.9 | sound effects, music |
| `expo-sqlite` (its `kv-store`) or `@react-native-async-storage/async-storage` | ~57.0.4 / 2.2.0 | ~58.0.12 / 2.2.0 | saves |

These versions were checked on 2026-10-15. The source of truth is the app's own SDK: install with `npx expo install <pkg>`, and check with `npx expo install --check`. That is the environment's job, so don't hand-pin versions.

## Facts that shape the code
- **New Architecture only.** SDK 55+ has no Legacy Architecture, and Reanimated 4 requires Fabric.
- **On SDK 57, use `expo@57.0.9` or later.** Earlier 57.x releases carry a Hermes memory regression that hits apps using worklets.
- **Babel needs no setup.** `babel-preset-expo` adds `react-native-worklets/plugin`. Leave `babel.config.js` alone for this.
- **Threading names (Reanimated 4).** Import from `react-native-worklets`:
  - `scheduleOnRN(fn, ...args)` replaces `runOnJS(fn)(...args)`.
  - `scheduleOnUI(fn, ...args)` replaces `runOnUI`.
  - The old names are deprecated.
- **Gesture Handler depends on the SDK.** SDK 57 bundles 2.x, which uses the builder API (`Gesture.Pan()` with `<GestureDetector>`). SDK 58 moves to 3.x, which uses hooks (`usePanGesture({...})`) and renames callbacks (`onStart` → `onActivate`, `onEnd` → `onDeactivate`). Write the API the installed major provides.
- **Skia's docs moved** to `wcandillon.github.io/react-native-skia` (the repo is `wcandillon/react-native-skia`). The npm name is still `@shopify/react-native-skia`. Docs track the latest Skia, so check that an API exists in the installed version. For example, `select()` and the Android `surfaceType` canvas option exist in 2.14 but not in 2.6.2.
- **Expo Go vs a development build.** Every package above is included in Expo Go, so Expo Go is fine for prototypes. Expo recommends a development build for a production app, and you need one as soon as the app adds a native package Expo Go lacks.

## Sources
- Bundled versions: https://github.com/expo/expo/blob/sdk-57/packages/expo/bundledNativeModules.json
- SDK 57 notes: https://expo.dev/changelog/sdk-57
- SDK 58 beta notes: https://expo.dev/changelog/sdk-58-beta
- Reanimated 3 to 4 migration: https://docs.swmansion.com/react-native-reanimated/docs/guides/migration-from-3.x
- Gesture Handler 3 upgrade guide: https://docs.swmansion.com/react-native-gesture-handler/docs/guides/upgrading-to-3
