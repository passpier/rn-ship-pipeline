# 2D games in Expo React Native: Skia + Reanimated + Gesture Handler + expo-audio

Checked on 2026-10-17, against **Expo SDK 55**, the SDK the app and fixtures target (ADR 0003). This replaces the 2026-10-15 pass against SDK 57.

Scope: facts for an `rn-2d-game` skill (aquarium/idle sim, many animated sprites, Expo managed).
Every claim has a citation; reference links are at the bottom. Docs sites track the *latest* library
release, which is much newer than what SDK 55 bundles, so this file cites sources at the git tag SDK 55 bundles.

## Version table

SDK 55's latest patch is `expo@55.0.31` (npm dist-tag `sdk-55`). npm `latest` is `58.0.14` ([npm-expo]). SDK 55 pairs with React Native 0.83 and React 19.2.0 ([bnm55]).

| package | bundled in SDK 55 | npm `latest` today | Expo Go? | source |
|---|---|---|---|---|
| react-native | 0.83.10 | n/a | n/a | [bnm55] |
| react | 19.2.0 | n/a | n/a | [bnm55] |
| @shopify/react-native-skia | 2.4.18 | 2.14.0 | Yes | [bnm55], [expo-skia], [npm-skia] |
| react-native-reanimated | 4.2.1 | 4.7.1 | Yes | [bnm55], [expo-rea], [npm-rea] |
| react-native-worklets | 0.7.4 | 0.13.0 | Yes (installed with Reanimated) | [bnm55], [expo-rea], [npm-wk] |
| react-native-gesture-handler | ~2.30.0 | 3.4.0 | Yes | [bnm55], [expo-rngh], [npm-rngh] |
| expo-audio | ~55.0.18 | n/a | Yes | [bnm55], [expo-audio] |
| expo-sqlite | ~55.0.20 | n/a | Yes (SQLCipher is not) | [bnm55], [expo-sqlite] |
| @react-native-async-storage/async-storage | 2.2.0 | n/a | Yes | [bnm55], [expo-async] |

**Expo Go caveats.** "Each build of Expo Go includes one Expo SDK version", and "Expo Go on the Apple App Store stops at SDK 54, and SDK 55 and later are not available there". For a physical iPhone, `eas go` builds Expo Go and distributes it through your TestFlight team. Android devices, emulators and the iOS Simulator install a matching build from expo.dev/go or the `expo-go` CLI. For a production project the doc says to "create a development build" ([expo-go-mismatch]). Running projects in Expo Go has required login since 2026-09-03 ([expo-changelog]).

**New Architecture.** SDK 55 "Dropped support for the Legacy Architecture … you will not be able to use the Legacy Architecture in SDK 55 projects and later" ([sdk55]). Reanimated 4.x "supports only the New Architecture" ([rea-migr-421]).

**Hermes v1 on SDK 55.** It's opt-in (`useHermesV1`), and it "requires building React Native from source". An update dated August 27 says apps that opt in "may be affected by known memory and development startup regressions", and recommends SDK 57 for Hermes v1 ([sdk55]). The default Hermes isn't affected.

**Xcode.** SDK 55 bumped the minimum Xcode to 26, and EAS Build uses 26.2 by default for it ([sdk55]). ADR 0003 records the 26.2+ minimum.

## 1. SDK 55: install notes

- Install with `npx expo install react-native-reanimated react-native-worklets`. "No additional configuration is required. Reanimated Babel plugin is automatically configured in `babel-preset-expo` when you install the library" ([expo-rea]). At `sdk-55`, `babel-preset-expo` adds `react-native-worklets/plugin` when `react-native-worklets` is installed, and otherwise `react-native-reanimated/plugin` ([bpe-src]).
- Install Skia with `npx expo install @shopify/react-native-skia`. Web needs a separate CanvasKit setup ([expo-skia]). The Skia 2.4.18 install doc requires `react-native@>=0.79` and `react@>=19`, plus iOS 14 / Android API 21 ([skia-install]).
- The Skia repo and docs moved. `shopify.github.io/react-native-skia` now redirects to `wcandillon.github.io/react-native-skia` ([skia-moved]), and GitHub redirects `Shopify/react-native-skia` to `wcandillon/react-native-skia` ([skia-repo]). The npm name is still `@shopify/react-native-skia` ([npm-skia]).

## 2. react-native-skia (SDK 55 → 2.4.18)

### Canvas + Reanimated values as props (no re-render)
"React Native Skia supports the direct usage of Reanimated's shared and derived values as properties. There is no need for functions like `createAnimatedComponent` or `useAnimatedProps`" ([skia-anim]).

```tsx
// from [skia-anim]
const r = useSharedValue(0);
const c = useDerivedValue(() => size - r.value);
useEffect(() => { r.value = withRepeat(withTiming(size * 0.33, { duration: 1000 }), -1); }, [r, size]);
return (<Canvas style={{ flex: 1 }}><Circle cx={r} cy={r} r={r} color="cyan" /></Canvas>);
```

- Use Skia's `interpolateColors`, not Reanimated's `interpolateColor`. The two store colors differently ([skia-anim]).
- `Canvas` props in 2.4.18: `debug`, `opaque`, `onSize?: SharedValue<SkSize>`, `colorSpace?: "p3" | "srgb"` (default `"p3"`), `androidWarmup` (default `false`). On Fabric, passing `onLayout` logs that it "is not supported on the new architecture" ([skia-canvas-src]). `onSize` gets the canvas size as a shared value on the UI thread. `useCanvasSize()` gives it on the JS thread ([skia-canvas]).
- **Reanimated support:** the docs say "Reanimated v3 and above" ([skia-anim]). The peer dependency is `react-native-reanimated: ">=3.19.1"` (optional) ([skia-pkg]). SDK 55's Reanimated 4.2.1 is in range.
- `useClock()` returns a shared value with ms since activation. Internally it is a `useFrameCallback` that writes `info.timeSinceFirstFrame` ([skia-hooks], [skia-interp-src]).
- `select(sharedObj, "key")` is **not** in 2.4.18. No such export is in `src/external/reanimated/` ([skia-rea-index-src]).

### useImage / sprite sheets from `require()`
`useImage(source, onError?)` returns `SkImage | null` and "will return null until the image is fully loaded" ([skia-image-src], [skia-images]):

```tsx
// from [skia-images]
const image1 = useImage(require("./assets/oslo"));       // JS bundle
const image2 = useImage("https://picsum.photos/200/300"); // network
const image3 = useImage("Logo");                         // native bundle named image
```

- `useImageAsTexture(require("./assets/image.png"))` loads the image and uploads it to the GPU. It returns a shared value usable as `image` ([skia-textures], [skia-textures-src]).
- Pixel-art sampling: `sampling={{ filter: FilterMode.Nearest, mipmap: MipmapMode.Nearest }}`. For quality, use `sampling={CubicSampling}` ([skia-images]). `Atlas` also takes `sampling` ([skia-atlas]).

### Atlas (many sprites, one draw call)
"Atlas transforms can be animated with near-zero cost using worklets. This makes it ideal for tile-based maps, sprite animations, and any scenario where you have many instances of similar textures" ([skia-atlas]).

`AtlasProps` in 2.4.18 source ([skia-atlas-src]) and the docs table ([skia-atlas]):

| prop | type |
|---|---|
| `image` | `SkImage \| null` (sprite sheet) |
| `sprites` | `SkRect[]` (source rect of each sprite in the sheet) |
| `transforms` | `SkRSXform[]` (one per sprite) |
| `colors?` | `SkColor[]` ("Color to blend the sprites with") |
| `blendMode?` | `BlendMode` ("Blend mode used to combine sprites and colors together"; inherited from `DrawingNodeProps`) |
| `sampling?` | `SamplingOptions` |

There is **no `colorBlendMode` prop in 2.4.18**. Skia 2.6.2 adds it ([skia-atlas-src-262]).

Helpers and signatures, all from source at v2.4.18:
- `rect(x, y, width, height)` ([skia-rect-src])
- `Skia.RSXform(scos, ssin, tx, ty)` and `Skia.RSXformFromRadians(...)` ([skia-skia-src])
- `SkRSXform.set(scos, ssin, tx, ty)` ([skia-rsx-src]) and `SkRect.setXYWH(x, y, w, h)` ([skia-rect-type-src])

RSXform is the matrix `[scos -ssin tx, ssin scos ty, 0 0 1]`. So `Skia.RSXform(2, 0, 50, 100)` means scale 2, translate (50,100) ([skia-atlas]).

UI-thread animation uses `useRSXformBuffer(count, (val, i) => { "worklet"; val.set(...) })` and `useRectBuffer(count, (rect, i) => { "worklet"; rect.setXYWH(...) })`. The rect buffer animates sprite-sheet frames. The docs warn: "Important to not forget the worklet directive" ([skia-hooks]). Doc example ([skia-atlas]):

```tsx
const pos = useSharedValue({ x: 0, y: 0 });
const transforms = useRSXformBuffer(numberOfBoxes, (val, i) => {
  "worklet";
  const tx = 5 + ((i * size.width) % width);
  const ty = 25 + Math.floor(i / (width / size.width)) * size.width;
  const r = Math.atan2(pos.value.y - ty, pos.value.x - tx);
  val.set(Math.cos(r), Math.sin(r), tx, ty);
});
<Atlas image={texture} sprites={sprites} transforms={transforms} />
```

How the buffers work, from source ([skia-buffers-src]):
- `useBuffer` does `makeMutable(new Array(size)…)` once per `size` (a `useMemo` on `[size]`).
- It runs the modifier inside a Reanimated mapper whose dependencies are `[size, ...Object.values(modifier.__closure ?? {})]`, then calls `notifyChange`.
- So the buffer recomputes whenever a shared value captured in the worklet closure changes, for example a clock or game-state shared value written by `useFrameCallback`.
- The same file exports `usePointBuffer` and `useColorBuffer`, which feed `colors`. They are not in the hooks doc.

The Skia repo's own performance example is `apps/example/src/Examples/Performance/Atlas.tsx`. It starts at 300 sprites and uses `useTexture` + `useRSXformBuffer` + `Gesture.Pan` ([skia-perf-example]).

Immediate-mode equivalent: `SkCanvas.drawAtlas(atlas, srcs: SkRect[], dsts: SkRSXform[], paint, blendMode?, colors?, sampling?)` ([skia-canvas-type-src]).

### Picture / recording (immediate mode)
- Retained mode is the default. "Fixed number of sprites/tiles → Retained … With the Atlas API, single draw call". "Game with dynamic entities → Immediate … Entities created/destroyed" ([skia-modes]).
- "The Retained Mode allows for extremely fast animation time with a virtually zero FFI-cost if the drawing list is updated at low frequency. The immediate mode allows for dynamic drawing list but has a higher FFI-cost to pay" ([skia-modes]).
- You can mix both modes in one `<Canvas>` ([skia-modes]).

The Picture API records draw commands in a worklet ([skia-pictures]):

```tsx
// from [skia-pictures]; recorder & paint created at module scope
const recorder = Skia.PictureRecorder();
const picture = useDerivedValue(() => {
  "worklet";
  const canvas = recorder.beginRecording(Skia.XYWHRect(0, 0, size, size));
  /* canvas.drawCircle(...), canvas.drawAtlas(...) */
  return recorder.finishRecordingAsPicture();
});
<Picture picture={picture} />
```

`usePictureAsTexture(picture, { width, height })` and `useTexture(<element/>, size)` bake drawings into a GPU texture on the UI thread ([skia-textures], [skia-textures-src]).

### Performance guidance (documented)
- Skia: use Atlas for many same-texture sprites. Use Picture/immediate mode when the number of draw commands changes per frame ([skia-atlas], [skia-modes]).
- Reanimated: "animate no more than 100 components for low-end Android devices and no more than 500 components for iOS. For more complex animations, consider using Reanimated with `react-native-skia`" ([rea-perf]).
- Reanimated: avoid reading shared values on the JS thread, because "the JS thread will get blocked until the value is fetched from the UI thread". Memoize `useFrameCallback` callbacks with `useCallback`. Memoize gesture objects with `useMemo` ([rea-perf]).
- Reanimated: to allow 120 fps on iOS, set `CADisableMinimumFrameDurationOnPhone` in Info.plist. It is on by default in the template from RN 0.82 ([rea-perf]). Expo's SDK 55 prebuild template sets it to `true` ([expo-template-plist]).
- Android Canvas backing view: 2.4.18 has `opaque` but no `android` prop ([skia-canvas-src]).

### Gestures + hit testing
Skia recommends react-native-gesture-handler: wrap the `Canvas` in `GestureDetector` ([skia-gestures]):

```tsx
// from [skia-gestures]
const gesture = Gesture.Pan()
  .onChange((e) => { translateX.value += e.changeX; })
  .onEnd((e) => { translateX.value = withDecay({ velocity: e.velocityX, clamp: [0, width] }); });
<GestureDetector gesture={gesture}><Canvas style={{ flex: 1 }}>…</Canvas></GestureDetector>
```

- Element tracking: "overlay an animated view on it, ensuring that the same transformations applied to the canvas element are mirrored on the animated view" ([skia-gestures]).
- Skia has **no documented scene-graph hit-test API**. Hit testing many sprites has to be done by hand in the gesture worklet with event `x`/`y` (relative to the GestureDetector's view, [rngh-tap]) against your own sprite bounds.
- `SkPath.contains(x, y): boolean` exists for path shapes ([skia-path-src]).

## 3. react-native-reanimated (SDK 55 → 4.2.1)

### useFrameCallback
From the docs and source at 4.2.1 ([rea-ufc], [rea-ufc-src]):

```ts
type FrameInfo = { timestamp: number; timeSincePreviousFrame: number | null; timeSinceFirstFrame: number };
type FrameCallback = { setActive: (isActive: boolean) => void; isActive: boolean; callbackId: number };
function useFrameCallback(callback: (frameInfo: FrameInfo) => void, autostart = true): FrameCallback;
```

- `timestamp`: system time in ms of the last rendered frame.
- `timeSincePreviousFrame`: "null on the first frame after activation", then about 16 ms at 60 Hz or 8 ms at 120 Hz.
- `timeSinceFirstFrame`: ms since activation.
- Start or stop with `frameCallback.setActive(bool)`. `autostart` defaults to `true`.
- The callback is "automatically workletized and ran on the UI thread" ([rea-ufc]).
- `FrameInfo` is exported as a type from `react-native-reanimated` ([rea-index]).
- Memoize the callback with `useCallback` ([rea-perf]).

### Worklets split (react-native-worklets 0.7.4)
- Babel plugin renamed `'react-native-reanimated/plugin'` → `'react-native-worklets/plugin'` ([rea-migr-421]). Expo's `babel-preset-expo` configures it automatically ([expo-rea], [bpe-src]).
- Threading renames. "While they are re-exported from `react-native-reanimated` for backwards compatibility, they are marked as deprecated and planned to be removed in a future release of Reanimated" ([rea-migr-421]). Worklets' own `runOnJS` page says it "is deprecated and will be removed in the next major release" ([wk-runonjs]).
  - `runOnJS(fn)(args)` → `scheduleOnRN(fn, ...args)`
  - `runOnUI(fn)(args)` → `scheduleOnUI(fn, ...args)`
  - `executeOnUIRuntimeSync` → `runOnUISync(fn, ...args)`
  - `runOnRuntime` → `scheduleOnRuntime(runtime, fn, ...args)`
- All four new names, and the deprecated old ones, are exported from `react-native-worklets` 0.7.4 ([wk-index]).
- Functions passed to `scheduleOnRN` "must be defined in the RN Runtime scope, i.e. in the component body or the global scope", not inside a UI worklet ([wk-scheduleonrn]).
- Version pairing: Reanimated 4.2.x needs worklets `0.7.x` and supports RN 0.80–0.83 ([rea-compat-json]). Its peer dependency is `react-native-worklets: ">=0.7.0"` ([rea-pkg]).

### Shared values
- `.value` and `get()`/`set()` are equivalent. With React Compiler, "refrain from accessing and modifying the `value` property directly. Instead, use the `get` and `set` methods". `set` also takes an updater `(v) => v'` ([rea-usv], [rea-types-src]).
- Don't read or write shared values during render ([rea-usv]).
- Large arrays or objects: `sv.value.push(x)` makes "Reanimated lose reactivity". Use `sv.modify((value) => { 'worklet'; value.push(1000); return value; })`. The signature is `modify(modifier?, forceUpdate?: boolean)` ([rea-usv], [rea-types-src]).
- **No lazy initializer in 4.2.1.** `useSharedValue(initialValue)` is `useState(() => makeMutable(initialValue))`, so `useSharedValue(() => x)` stores the function itself ([rea-usv-src]). Reanimated 4.4.0 adds lazy initializers ([rea-usv-latest]).

### New Architecture
Reanimated 4.x is New-Architecture-only. Legacy-arch apps must stay on 3.x ([rea-migr-421]).

## 4. react-native-gesture-handler (SDK 55 → ~2.30.0)

- **2.x API:** builder objects `Gesture.Pan()`, `Gesture.Tap()`, and others, passed to `<GestureDetector gesture={...}>`. Compose with `Race`, `Simultaneous` or `Exclusive` ([rngh-detector], [rngh-tap]).
- Tap event data: `x`, `y` ("relative to the view attached to the GestureDetector"), `absoluteX`, `absoluteY` (relative to the window; recommended when the detector's view is transformed by the gesture) ([rngh-tap]).
- **UI thread:** "When `react-native-reanimated` is installed, the callbacks passed to the gestures are automatically workletized and run on the UI thread when called". `.runOnJS(true)` forces the JS thread ([rngh-config]).
- To touch React state from a UI-thread callback, use `scheduleOnRN` ([wk-scheduleonrn]).
- "Using the same instance of a gesture across multiple Gesture Detectors is not possible" ([rngh-detector]). Memoize gestures with `useMemo` ([rea-perf]).
- **Setup:** wrap the app in `<GestureHandlerRootView>`, which defaults to `flex: 1`. "Keep `GestureHandlerRootView` as close to the actual root of the app as possible". Gestures in Modals need the Modal's content wrapped in its own root view ([rngh-install]).

## 5. expo-audio (SDK 55 → ~55.0.18)

SDK 55's expo-audio added "lock-screen controls, background audio recording, playlist support on all platforms … native preloading … reworked Android foreground service handling" ([sdk55]).

- `useAudioPlayer(source?, options?)` returns an `AudioPlayer` that hooks release in their cleanup ([audio-src], [shared-object-src]).
- `createAudioPlayer(source)` creates a player that outlives a component: "it is your responsibility to call the `release()` method when the player is no longer needed. If not handled properly, this approach may lead to memory leaks" ([expo-audio]). `release()` comes from `SharedObject` ([shared-object-src]). `AudioPlayer` also declares `remove()` ([audio-types-src]).
- Player API ([audio-types-src]):
  - Methods: `play()`, `pause()`, `replace(source)`, `seekTo(seconds, …)`.
  - Properties: `volume: number`, `loop: boolean`, `isLoaded`.
- SFX replay pattern from the docs: `player.seekTo(0); player.play();` ([expo-audio]).
- Looping music: set `player.loop = true`. **Inferred from the `loop: boolean` property.** Playlists have their own loop mode ([audio-types-src]).
- `setAudioModeAsync(mode: Partial<AudioMode>)`. "Only specified properties will be updated" ([audio-src]). Keys ([audio-types]):
  - `interruptionMode`: `'mixWithOthers'` (**default**; "Best suited for sound effects, UI feedback, or short audio clips"), `'duckOthers'`, or `'doNotMix'`. It "now works on both platforms". `interruptionModeAndroid` is deprecated.
  - `playsInSilentMode` (iOS). **The SDK 55 type has no `@default`**, and the iOS native record defaults the field to `false` ([audio-ios-records]). SDK 57's type documents `@default true`.
  - `shouldPlayInBackground` (default `false`), `allowsRecording` (iOS), `allowsBackgroundRecording` (Android), `shouldRouteThroughEarpiece` (default `false`).
  - On Android only `shouldPlayInBackground`, `shouldRouteThroughEarpiece`, `interruptionMode` and `allowsBackgroundRecording` reach native ([audio-src]).
- Lock-screen controls use `interruptionMode: 'doNotMix'` ([expo-audio]).
- `setIsAudioActiveAsync(false|true)` "will pause all audio playback and prevent new audio from playing". The JSDoc example drives it from an `AppState` handler ([audio-src]).
- **Preloading:** `preload(source, { preferredForwardBufferDuration? })`. The JSDoc example calls it "at module scope — starts buffering immediately", so later playback "starts near-instantly". Related: `clearPreloadedSource`, `clearAllPreloadedSources`, `getPreloadedSources` ([audio-src]).
- `downloadFirst: true` downloads the source before loading ([audio-types]).
- iOS `keepAudioSessionActive: true` keeps the session active when the player pauses or finishes, "Useful for sound effects that should not interfere with ongoing video playback or other audio" ([audio-types]).
- Config plugin: `enableBackgroundPlayback` defaults to **true** ([audio-plugin-src]). "On Android, this adds a media playback foreground service … On iOS, this adds the `audio` background mode" ([expo-audio]). Set it to `false` if a game doesn't want this.
- Concurrent players: **no documented limit** (see Unconfirmed).

## 6. Other notes

- **AppState:** states are `active`, `background`, and iOS-only `inactive`. `AppState.addEventListener('change', fn)` returns an `EventSubscription`, and the doc example removes it with `subscription.remove()` in the effect cleanup ([rn-appstate]).
- Pausing the game loop with `frameCallback.setActive(false)` on `background` combines two documented APIs. **No official doc prescribes this pattern.**
- **Game loops:** no official RN or Skia "game loop" guide was found.
  - Closest primary material: Skia's rendering-modes page names "games, generative art, and particle systems" for immediate mode, and Atlas for fixed sprites ([skia-modes]).
  - Reanimated's `useFrameCallback` is the per-frame UI-thread hook ([rea-ufc]).
- **Save data:**
  - AsyncStorage: Expo's store-data guide calls it "an asynchronous, unencrypted, persistent key-value storage" for small data. It is bundled at 2.2.0 and included in Expo Go ([expo-store-data], [expo-async]).
  - expo-sqlite: `expo-sqlite/kv-store` is "a drop-in replacement for the `@react-native-async-storage/async-storage` library", with sync APIs `getItemSync`/`setItemSync`. `import 'expo-sqlite/localStorage/install'` is a `localStorage` polyfill ([expo-sqlite], [sqlite-storage-src]).
  - Expo does not single out one as "the" way. Both are listed.

## What changes on a later SDK move

Moving past SDK 55 is a baseline delta (ADR 0003). From the SDK 57 pass (2026-10-15) and npm `latest`, these change code the skill shows:
- Reanimated 4.4+ adds `useSharedValue(() => …)` lazy init ([rea-usv-latest]).
- Skia 2.6 adds Atlas `colorBlendMode` ([skia-atlas-src-262]). Skia 2.10+ requires Reanimated 4 and Worklets ≥ 0.7. Skia 2.14 adds `select()` and the Android `surfaceType` canvas option.
- Gesture Handler 3 (SDK 58 bundles 3.x) has a hook API: `usePanGesture({...})`, `onStart` → `onActivate`, `onEnd` → `onDeactivate`, and `onChange` removed ([rngh3-upgrade]).

## Unconfirmed / contradictions

1. **Skia RN minimum.** The 2.4.18 install doc says `react-native@>=0.79`, but the package peer dep says `>=0.78` ([skia-install], [skia-pkg]). RN 0.83 satisfies both.
2. **Skia repo/docs location.** The repo moved from Shopify to `wcandillon`. The npm `repository` field still says Shopify, and 2.4.18's own `onLayout` warning links to `shopify.github.io` ([skia-moved], [npm-skia], [skia-canvas-src]).
3. **Expo Go for SDK 55 on iOS.** Not in the App Store. A physical iPhone needs `eas go` through TestFlight (Apple Developer Program), and SDK 55's changelog still says the store build is "waiting for approval" ([expo-go-mismatch], [sdk55]). A development build avoids the question.
4. **expo-audio cleanup.** The docs say call `release()` for `createAudioPlayer`. The type file also declares `remove()`. Which one to prefer is not stated ([expo-audio], [audio-types-src]).
5. **expo-audio looping.** That setting `player.loop = true` loops a single player is inferred from the typed `loop: boolean` property.
6. **expo-audio `playsInSilentMode` default.** "Only specified properties will be updated", but on iOS the native record defaults an omitted `playsInSilentMode` to `false` ([audio-src], [audio-ios-records]). Pass every key you care about explicitly.
7. **expo-audio concurrency.** No documented max number of simultaneous `AudioPlayer`s, and no documented SFX latency figures.
8. **Frame callback in background.** Not confirmed whether `useFrameCallback` stops on its own when the app is backgrounded. Call `setActive(false)` explicitly.
9. **Skia hit testing.** There is no built-in sprite hit-test. The only documented approaches are gesture-handler overlays or manual math, plus `SkPath.contains`.

[expo-changelog]: https://expo.dev/changelog
[sdk55]: https://expo.dev/changelog/sdk-55
[npm-expo]: https://registry.npmjs.org/expo
[npm-skia]: https://registry.npmjs.org/@shopify/react-native-skia
[npm-rea]: https://registry.npmjs.org/react-native-reanimated
[npm-wk]: https://registry.npmjs.org/react-native-worklets
[npm-rngh]: https://registry.npmjs.org/react-native-gesture-handler
[bnm55]: https://github.com/expo/expo/blob/sdk-55/packages/expo/bundledNativeModules.json
[expo-go-mismatch]: https://docs.expo.dev/troubleshooting/expo-go-version-mismatch/
[expo-skia]: https://docs.expo.dev/versions/v55.0.0/sdk/skia/
[expo-rea]: https://docs.expo.dev/versions/v55.0.0/sdk/reanimated/
[expo-rngh]: https://docs.expo.dev/versions/v55.0.0/sdk/gesture-handler/
[expo-audio]: https://docs.expo.dev/versions/v55.0.0/sdk/audio/
[expo-sqlite]: https://docs.expo.dev/versions/v55.0.0/sdk/sqlite/
[expo-async]: https://docs.expo.dev/versions/v55.0.0/sdk/async-storage/
[expo-store-data]: https://docs.expo.dev/develop/user-interface/store-data/
[expo-template-plist]: https://github.com/expo/expo/blob/sdk-55/templates/expo-template-bare-minimum/ios/HelloWorld/Info.plist
[bpe-src]: https://github.com/expo/expo/blob/sdk-55/packages/babel-preset-expo/src/index.ts
[audio-src]: https://github.com/expo/expo/blob/sdk-55/packages/expo-audio/src/ExpoAudio.ts
[audio-types]: https://github.com/expo/expo/blob/sdk-55/packages/expo-audio/src/Audio.types.ts
[audio-types-src]: https://github.com/expo/expo/blob/sdk-55/packages/expo-audio/src/AudioModule.types.ts
[audio-plugin-src]: https://github.com/expo/expo/blob/sdk-55/packages/expo-audio/plugin/src/withAudio.ts
[audio-ios-records]: https://github.com/expo/expo/blob/sdk-55/packages/expo-audio/ios/AudioRecords.swift
[shared-object-src]: https://github.com/expo/expo/blob/sdk-55/packages/expo-modules-core/src/ts-declarations/SharedObject.ts
[sqlite-storage-src]: https://github.com/expo/expo/blob/sdk-55/packages/expo-sqlite/src/Storage.ts
[skia-moved]: https://shopify.github.io/react-native-skia/
[skia-repo]: https://github.com/wcandillon/react-native-skia
[skia-anim]: https://github.com/wcandillon/react-native-skia/blob/v2.4.18/apps/docs/docs/animations/reanimated3.md
[skia-install]: https://github.com/wcandillon/react-native-skia/blob/v2.4.18/apps/docs/docs/getting-started/installation.md
[skia-pkg]: https://github.com/wcandillon/react-native-skia/blob/v2.4.18/packages/skia/package.json
[skia-hooks]: https://github.com/wcandillon/react-native-skia/blob/v2.4.18/apps/docs/docs/animations/hooks.md
[skia-textures]: https://github.com/wcandillon/react-native-skia/blob/v2.4.18/apps/docs/docs/animations/textures.md
[skia-gestures]: https://github.com/wcandillon/react-native-skia/blob/v2.4.18/apps/docs/docs/animations/gestures.md
[skia-images]: https://github.com/wcandillon/react-native-skia/blob/v2.4.18/apps/docs/docs/image.md
[skia-atlas]: https://github.com/wcandillon/react-native-skia/blob/v2.4.18/apps/docs/docs/shapes/atlas.md
[skia-pictures]: https://github.com/wcandillon/react-native-skia/blob/v2.4.18/apps/docs/docs/pictures.md
[skia-modes]: https://github.com/wcandillon/react-native-skia/blob/v2.4.18/apps/docs/docs/canvas/rendering-modes.md
[skia-canvas]: https://github.com/wcandillon/react-native-skia/blob/v2.4.18/apps/docs/docs/canvas/canvas.md
[skia-canvas-src]: https://github.com/wcandillon/react-native-skia/blob/v2.4.18/packages/skia/src/renderer/Canvas.tsx
[skia-atlas-src]: https://github.com/wcandillon/react-native-skia/blob/v2.4.18/packages/skia/src/dom/types/Drawings.ts
[skia-atlas-src-262]: https://github.com/wcandillon/react-native-skia/blob/v2.6.2/packages/skia/src/dom/types/Drawings.ts
[skia-rea-index-src]: https://github.com/wcandillon/react-native-skia/blob/v2.4.18/packages/skia/src/external/reanimated/index.ts
[skia-buffers-src]: https://github.com/wcandillon/react-native-skia/blob/v2.4.18/packages/skia/src/external/reanimated/buffers.ts
[skia-interp-src]: https://github.com/wcandillon/react-native-skia/blob/v2.4.18/packages/skia/src/external/reanimated/interpolators.ts
[skia-textures-src]: https://github.com/wcandillon/react-native-skia/blob/v2.4.18/packages/skia/src/external/reanimated/textures.tsx
[skia-image-src]: https://github.com/wcandillon/react-native-skia/blob/v2.4.18/packages/skia/src/skia/core/Image.ts
[skia-rect-src]: https://github.com/wcandillon/react-native-skia/blob/v2.4.18/packages/skia/src/skia/core/Rect.ts
[skia-rect-type-src]: https://github.com/wcandillon/react-native-skia/blob/v2.4.18/packages/skia/src/skia/types/Rect.ts
[skia-skia-src]: https://github.com/wcandillon/react-native-skia/blob/v2.4.18/packages/skia/src/skia/types/Skia.ts
[skia-rsx-src]: https://github.com/wcandillon/react-native-skia/blob/v2.4.18/packages/skia/src/skia/types/RSXform.ts
[skia-canvas-type-src]: https://github.com/wcandillon/react-native-skia/blob/v2.4.18/packages/skia/src/skia/types/Canvas.ts
[skia-path-src]: https://github.com/wcandillon/react-native-skia/blob/v2.4.18/packages/skia/src/skia/types/Path/Path.ts
[skia-perf-example]: https://github.com/wcandillon/react-native-skia/blob/v2.4.18/apps/example/src/Examples/Performance/Atlas.tsx
[rea-ufc]: https://github.com/software-mansion/react-native-reanimated/blob/4.2.1/docs/docs-reanimated/docs/advanced/useFrameCallback.mdx
[rea-ufc-src]: https://github.com/software-mansion/react-native-reanimated/blob/4.2.1/packages/react-native-reanimated/src/hook/useFrameCallback.ts
[rea-index]: https://github.com/software-mansion/react-native-reanimated/blob/4.2.1/packages/react-native-reanimated/src/index.ts
[rea-pkg]: https://github.com/software-mansion/react-native-reanimated/blob/4.2.1/packages/react-native-reanimated/package.json
[rea-types-src]: https://github.com/software-mansion/react-native-reanimated/blob/4.2.1/packages/react-native-reanimated/src/commonTypes.ts
[rea-usv]: https://github.com/software-mansion/react-native-reanimated/blob/4.2.1/docs/docs-reanimated/docs/core/useSharedValue.mdx
[rea-usv-src]: https://github.com/software-mansion/react-native-reanimated/blob/4.2.1/packages/react-native-reanimated/src/hook/useSharedValue.ts
[rea-usv-latest]: https://docs.swmansion.com/react-native-reanimated/docs/core/useSharedValue
[rea-migr-421]: https://github.com/software-mansion/react-native-reanimated/blob/4.2.1/docs/docs-reanimated/docs/guides/migration-from-3.x.md
[rea-compat-json]: https://github.com/software-mansion/react-native-reanimated/blob/4.2.1/packages/react-native-reanimated/compatibility.json
[rea-perf]: https://github.com/software-mansion/react-native-reanimated/blob/4.2.1/docs/docs-reanimated/docs/guides/performance.md
[wk-index]: https://github.com/software-mansion/react-native-reanimated/blob/worklets-0.7.4/packages/react-native-worklets/src/index.ts
[wk-scheduleonrn]: https://github.com/software-mansion/react-native-reanimated/blob/worklets-0.7.4/docs/docs-worklets/docs/threading/scheduleOnRN.mdx
[wk-runonjs]: https://github.com/software-mansion/react-native-reanimated/blob/worklets-0.7.4/docs/docs-worklets/docs/threading/runOnJS.mdx
[rngh-detector]: https://github.com/software-mansion/react-native-gesture-handler/blob/v2.30.0/packages/docs-gesture-handler/docs/gestures/gesture-detector.md
[rngh-tap]: https://github.com/software-mansion/react-native-gesture-handler/blob/v2.30.0/packages/docs-gesture-handler/docs/gestures/tap-gesture.md
[rngh-config]: https://github.com/software-mansion/react-native-gesture-handler/blob/v2.30.0/packages/docs-gesture-handler/docs/gestures/_shared/base-gesture-config.md
[rngh-install]: https://github.com/software-mansion/react-native-gesture-handler/blob/v2.30.0/packages/docs-gesture-handler/docs/fundamentals/installation.md
[rngh3-upgrade]: https://docs.swmansion.com/react-native-gesture-handler/docs/guides/upgrading-to-3
[rn-appstate]: https://reactnative.dev/docs/appstate
