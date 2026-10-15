# 2D games in Expo React Native: Skia + Reanimated + Gesture Handler + expo-audio

Checked on 2026-10-15.

Scope: facts for an `rn-2d-game` skill (aquarium/idle sim, many animated sprites, Expo managed).
Every claim has a citation; reference links are at the bottom. Docs sites track the *latest* library
release, which is often newer than what the Expo SDK bundles, so where versions differ this file
cites the source at the git tag the SDK bundles.

## Version table

Latest stable is **Expo SDK 57**, released 2026-06-30 ([expo-changelog], [sdk57]). npm `expo@latest` is
`57.0.30` and `expo@next` is `58.0.10` ([npm-expo]). SDK 58 is in beta, announced 2026-09-15 ([sdk58]).
`docs.expo.dev/versions/latest` lists 57.0.0 as latest, with React Native 0.86 and React 19.2.3 ([expo-versions]).

| package | bundled in SDK 57 | bundled in SDK 58 beta | Expo Go? | source |
|---|---|---|---|---|
| react-native | 0.86.3 | 0.88.0-rc.4 | n/a | [bnm57], [bnm58] |
| react | 19.2.3 | 19.3.0 | n/a | [bnm57], [bnm58] |
| @shopify/react-native-skia | 2.6.2 | 2.14.0 | Yes ("Included in Expo Go") | [bnm57], [expo-skia] |
| react-native-reanimated | 4.5.1 | 4.7.1 | Yes | [bnm57], [expo-rea] |
| react-native-worklets | 0.10.1 | 0.13.0 | Yes (installed with Reanimated) | [bnm57], [expo-rea] |
| react-native-gesture-handler | ~2.32.0 | ~3.3.0 | Yes | [bnm57], [expo-rngh] |
| expo-audio | ~57.0.5 | ~58.0.9 | Yes | [bnm57], [expo-audio] |
| expo-sqlite | ~57.0.4 | ~58.0.12 | Yes (SQLCipher is not) | [bnm57], [expo-sqlite] |
| @react-native-async-storage/async-storage | 2.2.0 | 2.2.0 | Yes | [bnm57], [expo-async] |

For comparison, npm `latest` today: Skia 2.14.0, Reanimated 4.7.1, Worklets 0.13.0, Gesture Handler 3.3.0 ([npm-skia], [npm-rea], [npm-wk], [npm-rngh]).

**Expo Go caveats.** The SDK 57 release notes say: "Expo Go for SDK 57 is available with `eas go` for iOS devices, and through Expo CLI for Android devices/emulators and iOS simulators". The store release was still "waiting on approval" ([sdk57]). Expo calls Expo Go "not recommended as a development environment for production apps" ([sdk57]). Since 2026-09-03, running projects in Expo Go requires login ([expo-changelog]).

**New Architecture.** SDK 55 "Dropped support for the Legacy Architecture … you will not be able to use the Legacy Architecture in SDK 55 projects and later" ([sdk55]). Reanimated 4.x "works only with the React Native New Architecture (Fabric)" ([rea-compat]). Gesture Handler 3 is "rebuilt for the New Architecture" ([rngh-v3-release]).

**Known SDK 57 issue.** The first SDK 57 release inherited a Hermes V1 memory regression that affects apps importing worklets/reanimated. Updating to `expo@57.0.9` or later "is crucial for affected apps" ([sdk57]).

## 1. Latest Expo SDK: install notes

- Install with `npx expo install react-native-reanimated react-native-worklets`. "No additional configuration is required. Reanimated Babel plugin is automatically configured in babel-preset-expo" ([expo-rea]).
- Install Skia with `npx expo install @shopify/react-native-skia`. Web needs a separate CanvasKit setup ([expo-skia]). Skia 2.x requires `react-native@>=0.79` and `react@>=19`, plus iOS 14 / Android API 21 ([skia-install-262]).
- The Skia repo and docs moved. `shopify.github.io/react-native-skia` now redirects to `wcandillon.github.io/react-native-skia` ([skia-moved]), and GitHub redirects `Shopify/react-native-skia` to `wcandillon/react-native-skia` ([skia-repo]). The npm name is still `@shopify/react-native-skia` ([npm-skia]).

## 2. react-native-skia (SDK 57 → 2.6.2)

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
- `Canvas` props in 2.6.2: `debug`, `opaque`, `onSize?: SharedValue<SkSize>`, `colorSpace?: "p3" | "srgb"`, `ref`, `androidWarmup`. `onLayout` is deprecated ("Not supported on Fabric. Use `onSize` or `useCanvasSize()`") ([skia-canvas-src]). `onSize` gets the canvas size as a shared value on the UI thread. `useCanvasSize()` gives it on the JS thread ([skia-canvas]).
- **Reanimated support:** the 2.6.2 docs say "Reanimated v3 and above" ([skia-anim-262]). The 2.6.2 peer dependency is `react-native-reanimated: ">=3.19.1"` (optional) ([skia-pkg-262]). Newer docs add: "Starting version `2.10` and above, this integration requires **Reanimated v4 or above**". At v2.14.0 the requirement is `react-native-reanimated@>=4.0.0` with `react-native-worklets@>=0.7.0` ([skia-anim-2140], [skia-install-2140]).
- `useClock()` returns a shared value with ms since activation. Internally it is a `useFrameCallback` that writes `info.timeSinceFirstFrame` ([skia-hooks], [skia-interp-src]).
- `select(sharedObj, "key")` binds one object shared value to several props. It exists in 2.14.0 docs/source but **not** in 2.6.2 ([skia-anim-2140]; `git grep` at v2.6.2 found no export).

### useImage / sprite sheets from `require()`
`useImage(source: DataSourceParam, onError?: (err: Error) => void)` returns `SkImage | null` and is null until loaded ([skia-image-src], [skia-images]):

```tsx
// from [skia-images]
const image1 = useImage(require("./assets/oslo"));       // JS bundle
const image2 = useImage("https://picsum.photos/200/300"); // network
const image3 = useImage("Logo");                         // native bundle named image
```

- `useImageAsTexture(require("./assets/image.png"))` loads the image and uploads it to the GPU. It returns a shared value usable as `image` ([skia-textures]).
- Pixel-art sampling: `sampling={{ filter: FilterMode.Nearest, mipmap: MipmapMode.Nearest }}`. For quality, use `sampling={CubicSampling}` ([skia-images]). `Atlas` also takes `sampling` ([skia-atlas]).

### Atlas (many sprites, one draw call)
"The Atlas component is used for efficient rendering of multiple instances of the same texture or image … Atlas transforms can be animated with near-zero cost using worklets" ([skia-atlas]).

Props from the docs ([skia-atlas]) and `AtlasProps` in source ([skia-atlas-src]):

| prop | type |
|---|---|
| `image` | `SkImage \| null` (sprite sheet) |
| `sprites` | `SkRect[]` (source rect of each sprite in the sheet) |
| `transforms` | `SkRSXform[]` (one per sprite) |
| `colors?` | `SkColor[]` |
| `colorBlendMode?` | `BlendMode` (docs: default `dstOver`) |
| `blendMode?` | layer blend mode (docs table; inherited from `DrawingNodeProps`) |
| `sampling?` | `SamplingOptions` |

Helpers and signatures, all from source at v2.6.2:
- `rect(x, y, width, height)` ([skia-rect-src])
- `Skia.RSXform(scos, ssin, tx, ty)` and `Skia.RSXformFromRadians(scale, radians, tx, ty, px, py)` ([skia-skia-src])
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
- `useBuffer` does `makeMutable(new Array(size)…)` once per `size`.
- It runs the modifier inside a Reanimated mapper whose dependencies are `[size, ...Object.values(modifier.__closure)]`, then calls `notifyChange`.
- So the buffer recomputes whenever a shared value captured in the worklet closure changes, for example a clock or game-state shared value written by `useFrameCallback`.
- The same file exports `usePointBuffer` and `useColorBuffer`, which feed `colors`. They are not in the hooks doc.

The Skia repo's own performance example is `apps/example/src/Examples/Performance/Atlas.tsx`. It draws 300+ sprites with `useTexture` + `useRSXformBuffer` + `Gesture.Pan` ([skia-perf-example]).

Immediate-mode equivalent: `SkCanvas.drawAtlas(atlas, srcs: SkRect[], dsts: SkRSXform[], paint, blendMode?, colors?, sampling?)` ([skia-canvas-type-src]).

### Picture / recording (immediate mode)
- Retained mode is the default. "Fixed number of sprites/tiles → Retained … With the Atlas API, single draw call". "Game with dynamic entities → Immediate … Entities created/destroyed" ([skia-modes]).
- "The Retained Mode allows for extremely fast animation time with a virtually zero FFI-cost if the drawing list is updated at low frequency. The immediate mode allows for dynamic drawing list but has a higher FFI-cost" ([skia-modes]).
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

`usePictureAsTexture(picture, { width, height })` and `useTexture(<element/>, size)` bake drawings into a GPU texture on the UI thread ([skia-textures]).

### Performance guidance (documented)
- Skia: use Atlas for many same-texture sprites. Use Picture/immediate mode when the number of draw commands changes per frame ([skia-atlas], [skia-modes]).
- Reanimated: "animate no more than 100 components for low-end Android devices and no more than 500 components for iOS. For more complex animations, consider using Reanimated with `react-native-skia`" ([rea-perf]).
- Reanimated: avoid reading shared values on the JS thread, because it blocks until synced. Memoize `useFrameCallback` callbacks with `useCallback`. Memoize gesture objects with `useMemo` ([rea-perf]).
- Reanimated: to allow 120 fps on iOS, set `CADisableMinimumFrameDurationOnPhone` in Info.plist. It is on by default in the template from RN 0.82 ([rea-perf]).
- Android Canvas backing view (`opaque`/`android={{ surfaceType }}`): SurfaceView vs TextureView tradeoffs are documented only in **2.14.0** docs ([skia-canvas-2140]). 2.6.2 has `opaque` but no `android` prop ([skia-canvas-src]).

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
- Skia has **no documented scene-graph hit-test API**. Hit testing many sprites has to be done by hand in the gesture worklet with event `x`/`y` (relative to the GestureDetector's view, [rngh2-tap]) against your own sprite bounds.
- `SkPath.contains(x, y): boolean` exists for path shapes ([skia-path-src]).

## 3. react-native-reanimated 4.x (SDK 57 → 4.5.1)

### useFrameCallback
From the docs ([rea-ufc], [rea-ufc-451]):

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
- `FrameInfo` is exported as a type from `react-native-reanimated` ([rea-index-451]).
- Memoize the callback with `useCallback` ([rea-perf]).

### Worklets split (react-native-worklets)
- Babel plugin renamed `'react-native-reanimated/plugin'` → `'react-native-worklets/plugin'`. It must be listed last for bare RN CLI; Expo's `babel-preset-expo` configures it automatically ([rea-migr], [rea-start], [expo-rea]).
- Threading renames. The old functions are still exported but "deprecated and will be removed in the next major release" ([rea-migr], [wk-runonjs], [wk-runonui]):
  - `runOnJS(fn)(args)` → `scheduleOnRN(fn, ...args)`
  - `runOnUI(fn)(args)` → `scheduleOnUI(fn, ...args)`
  - `executeOnUIRuntimeSync` → `runOnUISync(fn, ...args)`
  - `runOnRuntime` → `scheduleOnRuntime(runtime, fn, ...args)`
- Import these from `react-native-worklets` ([rea-migr]). Signature: `scheduleOnRN<Args, R>(fun, ...args: Args): void` ([wk-scheduleonrn]).
- Functions passed to `scheduleOnRN` must be defined in RN-runtime scope (component body or module), not inside a UI worklet ([wk-scheduleonrn]).
- Version pairing: Reanimated 4.5.x needs worklets `0.10.x` and supports RN 0.83–0.86 ([rea-compat-json]).

### Shared values
- `.value` and `get()`/`set()` are equivalent. With React Compiler, "refrain from accessing and modifying the `value` property directly. Instead, use the `get` and `set` methods". `set` also takes an updater `(v) => v'` ([rea-usv]).
- Don't read or write shared values during render. Don't store functions in shared values ([rea-usv]).
- Large arrays or objects: `sv.value.push(x)` "loses reactivity", while `sv.value = [...]` "creates a new copy". Use `sv.modify((value) => { 'worklet'; value.push(1000); return value; })`. The signature is `modify(modifier?, forceUpdate?: boolean)` ([rea-usv]).
- Since 4.4.0, `useSharedValue` accepts a lazy initializer function ([rea-usv]).

### New Architecture
Reanimated 4.x is New-Architecture-only. Legacy-arch apps must stay on 3.x ([rea-migr], [rea-compat]).

## 4. react-native-gesture-handler (SDK 57 → 2.32.x; SDK 58 → 3.3.x)

- **2.x API (SDK 57):** builder objects `Gesture.Pan()`, `Gesture.Tap()`, and others, passed to `<GestureDetector gesture={...}>`. Combine with `Gesture.Exclusive(doubleTap, singleTap)`, `Simultaneous`, or `Race` ([rngh2-detector], [rngh2-tap]).
- Tap event data: `x`, `y` (relative to the detector's view), `absoluteX`, `absoluteY`. Config methods include `numberOfTaps`, `maxDuration`, `maxDistance` ([rngh2-tap]).
- **UI thread:** "When `react-native-reanimated` is installed, the callbacks passed to the gestures are automatically workletized and run on the UI thread". `.runOnJS(true)` forces the JS thread ([rngh2-config]).
- To touch React state from a UI-thread callback, use `scheduleOnRN` ([wk-scheduleonrn]).
- Don't reuse one gesture instance in two detectors ([rngh2-detector]). Memoize gestures with `useMemo` ([rea-perf]).
- **Setup:** wrap the app root in `<GestureHandlerRootView>`, which defaults to `flex: 1`. Keep it as close to the root as possible. Modal content needs its own root view ([rngh2-install]).
- **3.x (bundled in SDK 58 beta, npm latest):** a hook API.
  - `Gesture.Pan()` → `usePanGesture({...})`, `Gesture.Tap()` → `useTapGesture({...})`, and so on, with config passed as an object.
  - Renamed callbacks: `onStart` → `onActivate`, `onEnd` → `onDeactivate`. `onChange` was removed (use `change*` fields in `onUpdate`).
  - The `success` arg became `event.canceled` ([rngh3-upgrade]).
  - The v3 docs keep the builder API under "legacy-gestures" ([rngh3-legacy]).

## 5. expo-audio (SDK 57 → ~57.0.5)

- `useAudioPlayer(source?: AudioSource, options?: AudioPlayerOptions): AudioPlayer`. It "automatically releases when the component unmounts" and "will start loading the audio source immediately upon creation" ([expo-audio]).
- `createAudioPlayer(source)` creates a player that outlives a component. "It is your responsibility to call the `release()` method", or it may leak ([expo-audio]). `release()` comes from `SharedObject` ([shared-object-src]). `AudioPlayer` also declares `remove()` ("Remove the player from memory") ([audio-types-src]).
- Player API ([audio-types-src]):
  - Methods: `play()`, `pause()`, `replace(source)`, `seekTo(seconds, toleranceBefore?, toleranceAfter?): Promise<void>`.
  - Properties: `volume: number` (0–1), `loop: boolean`, `isLoaded`.
- SFX replay pattern from the docs: `player.seekTo(0); player.play();` ([expo-audio]).
- Looping music: set `player.loop = true`. **Inferred from the `loop: boolean` property; the docs show no example.** Playlists use `loop: 'none' | 'single' | 'all'` ([expo-audio], [audio-types-src]).
- `setAudioModeAsync(mode: Partial<AudioMode>)` takes these keys ([expo-audio]):
  - `interruptionMode`: `'mixWithOthers'` (**default**; "Best suited for sound effects"), `'duckOthers'`, or `'doNotMix'`
  - `playsInSilentMode` (default `true`)
  - `shouldPlayInBackground` (default `false`)
  - `allowsRecording`, `allowsBackgroundRecording`, `shouldRouteThroughEarpiece`
  - `interruptionModeAndroid` is deprecated in favor of `interruptionMode`.
- Lock-screen controls need `interruptionMode: 'doNotMix'` ([expo-audio]).
- `setIsAudioActiveAsync(false|true)` pauses or blocks all audio globally. The docs' example drives it from an `AppState` handler ([expo-audio]).
- **Preloading:** `preload(source, options?)` "should be called in module scope". Later `useAudioPlayer`/`createAudioPlayer`/`replace` with the same source starts "with minimal delay". Related: `clearPreloadedSource`, `clearAllPreloadedSources`, `getPreloadedSources` ([expo-audio]).
- `downloadFirst: true` downloads before loading, which helps "users managing multiple audio players simultaneously" ([expo-audio]).
- iOS `keepAudioSessionActive: true` keeps SFX from deactivating the session ([expo-audio]).
- Config plugin: `enableBackgroundPlayback` defaults to **true**. It adds the iOS `audio` background mode and an Android foreground service. Set it to `false` if a game doesn't want this ([expo-audio]).
- Concurrent players: **no documented limit** (see Unconfirmed). For advanced needs the docs point to "React Native Audio API" (Web Audio API, sample-accurate scheduling) ([expo-audio]).

## 6. Other notes

- **AppState:** states are `active`, `background`, and iOS-only `inactive`. `AppState.addEventListener('change', fn)` returns an `EventSubscription`, and the doc example removes it with `subscription.remove()` in the effect cleanup. `AppState.currentState` stays up to date ([rn-appstate], [rn-appstate-src]).
- Pausing the game loop with `frameCallback.setActive(false)` on `background` combines two documented APIs. **No official doc prescribes this pattern.**
- **Game loops:** no official RN or Skia "game loop" guide was found.
  - Closest primary material: Skia's rendering-modes page names games, particle systems and Atlas ([skia-modes]).
  - The 2.14.0 Skia docs show `useFrameCallback(({ timeSinceFirstFrame }) => { "worklet"; circle.value = {...}; }, true)` driving canvas props ([skia-anim-2140]).
  - Reanimated's `useFrameCallback` is the per-frame UI-thread hook ([rea-ufc]).
- **Save data:**
  - AsyncStorage: Expo's store-data guide calls it "an asynchronous, unencrypted, persistent key-value storage" for small data. It is bundled at 2.2.0 and included in Expo Go ([expo-store-data], [expo-async]).
  - expo-sqlite: "a database … persisted across restarts" ([expo-store-data]). It also ships `expo-sqlite/kv-store`, "a drop-in replacement for … async-storage" with sync APIs `setItemSync`/`getItemSync`, and a `localStorage` polyfill via `import 'expo-sqlite/localStorage/install'` ([expo-sqlite]).
  - Expo does not single out one as "the" way. Both are listed.

## Unconfirmed / contradictions

1. **Skia ↔ Reanimated range.**
   - 2.6.2 docs say "Reanimated v3 and above", with peer `>=3.19.1` ([skia-anim-262], [skia-pkg-262]).
   - 2.10+ requires Reanimated 4 ([skia-anim-2140]).
   - SDK 57's pair (Skia 2.6.2 + Reanimated 4.5.1) fits both ranges. No Skia doc lists the exact tested Reanimated 4.x minors.
2. **Skia RN minimum.** The installation doc says `react-native@>=0.79`, but the package peer dep says `>=0.78` ([skia-install-262], [skia-pkg-262]).
3. **Skia repo/docs location.** The repo moved from Shopify to `wcandillon`. The npm `repository` field still says Shopify, and the 2.14.0 docusaurus config still has `url: https://shopify.github.io/` ([skia-moved], [npm-skia]).
4. **Expo Go for SDK 57.** Expo's library pages say "Included in Expo Go", but the store builds of Expo Go for SDK 57 were awaiting approval per the SDK 57 notes. Use `eas go` (iOS device) or the CLI install ([sdk57]). Current store status is not confirmed.
5. **expo-audio cleanup.** The docs say call `release()` for `createAudioPlayer`. The type file also declares `remove()`. Which one to prefer is not stated ([expo-audio], [audio-types-src]).
6. **expo-audio looping.** That setting `player.loop = true` loops a single player is inferred from the typed `loop: boolean` property. The docs only describe it as "indicating whether the player is currently looping".
7. **expo-audio concurrency.** No documented max number of simultaneous `AudioPlayer`s, and no documented SFX latency figures.
8. **Frame callback in background.** Not confirmed whether `useFrameCallback` stops on its own when the app is backgrounded. Call `setActive(false)` explicitly.
9. **Skia hit testing.** There is no built-in sprite hit-test. The only documented approaches are gesture-handler overlays or manual math, plus `SkPath.contains`.
10. **SDK 58 timing.** It goes stable "when React Native 0.88 ships" ([sdk58]). It will move Gesture Handler to 3.x (hook API) and Skia to 2.14 (Reanimated-4-only, `select`, Android `surfaceType`). Skill code written for SDK 57 must use the 2.x builder API.

[expo-changelog]: https://expo.dev/changelog
[sdk55]: https://expo.dev/changelog/sdk-55
[sdk57]: https://expo.dev/changelog/sdk-57
[sdk58]: https://expo.dev/changelog/sdk-58-beta
[npm-expo]: https://registry.npmjs.org/expo
[npm-skia]: https://registry.npmjs.org/@shopify/react-native-skia
[npm-rea]: https://registry.npmjs.org/react-native-reanimated
[npm-wk]: https://registry.npmjs.org/react-native-worklets
[npm-rngh]: https://registry.npmjs.org/react-native-gesture-handler
[skia-repo]: https://github.com/wcandillon/react-native-skia
[expo-versions]: https://docs.expo.dev/versions/latest/
[bnm57]: https://github.com/expo/expo/blob/sdk-57/packages/expo/bundledNativeModules.json
[bnm58]: https://github.com/expo/expo/blob/sdk-58/packages/expo/bundledNativeModules.json
[expo-skia]: https://docs.expo.dev/versions/v57.0.0/sdk/skia/
[expo-rea]: https://docs.expo.dev/versions/v57.0.0/sdk/reanimated/
[expo-rngh]: https://docs.expo.dev/versions/v57.0.0/sdk/gesture-handler/
[expo-audio]: https://docs.expo.dev/versions/v57.0.0/sdk/audio/
[expo-sqlite]: https://docs.expo.dev/versions/v57.0.0/sdk/sqlite/
[expo-async]: https://docs.expo.dev/versions/v57.0.0/sdk/async-storage/
[expo-store-data]: https://docs.expo.dev/develop/user-interface/store-data/
[audio-types-src]: https://github.com/expo/expo/blob/sdk-57/packages/expo-audio/src/AudioModule.types.ts
[shared-object-src]: https://github.com/expo/expo/blob/sdk-57/packages/expo-modules-core/src/ts-declarations/SharedObject.ts
[skia-moved]: https://shopify.github.io/react-native-skia/
[skia-anim]: https://wcandillon.github.io/react-native-skia/docs/animations/animations
[skia-anim-262]: https://github.com/wcandillon/react-native-skia/blob/v2.6.2/apps/docs/docs/animations/reanimated3.md
[skia-anim-2140]: https://github.com/wcandillon/react-native-skia/blob/v2.14.0/apps/docs/docs/animations/reanimated3.md
[skia-install-262]: https://github.com/wcandillon/react-native-skia/blob/v2.6.2/apps/docs/docs/getting-started/installation.md
[skia-install-2140]: https://github.com/wcandillon/react-native-skia/blob/v2.14.0/apps/docs/docs/getting-started/installation.md
[skia-pkg-262]: https://github.com/wcandillon/react-native-skia/blob/v2.6.2/packages/skia/package.json
[skia-hooks]: https://wcandillon.github.io/react-native-skia/docs/animations/hooks
[skia-textures]: https://wcandillon.github.io/react-native-skia/docs/animations/textures
[skia-gestures]: https://wcandillon.github.io/react-native-skia/docs/animations/gestures
[skia-images]: https://wcandillon.github.io/react-native-skia/docs/images
[skia-atlas]: https://wcandillon.github.io/react-native-skia/docs/shapes/atlas
[skia-pictures]: https://wcandillon.github.io/react-native-skia/docs/shapes/pictures
[skia-modes]: https://wcandillon.github.io/react-native-skia/docs/canvas/rendering-modes
[skia-canvas]: https://wcandillon.github.io/react-native-skia/docs/canvas/overview
[skia-canvas-2140]: https://github.com/wcandillon/react-native-skia/blob/v2.14.0/apps/docs/docs/canvas/canvas.md
[skia-canvas-src]: https://github.com/wcandillon/react-native-skia/blob/v2.6.2/packages/skia/src/renderer/Canvas.tsx
[skia-atlas-src]: https://github.com/wcandillon/react-native-skia/blob/v2.6.2/packages/skia/src/dom/types/Drawings.ts
[skia-buffers-src]: https://github.com/wcandillon/react-native-skia/blob/v2.6.2/packages/skia/src/external/reanimated/buffers.ts
[skia-interp-src]: https://github.com/wcandillon/react-native-skia/blob/v2.6.2/packages/skia/src/external/reanimated/interpolators.ts
[skia-image-src]: https://github.com/wcandillon/react-native-skia/blob/v2.6.2/packages/skia/src/skia/core/Image.ts
[skia-rect-src]: https://github.com/wcandillon/react-native-skia/blob/v2.6.2/packages/skia/src/skia/core/Rect.ts
[skia-rect-type-src]: https://github.com/wcandillon/react-native-skia/blob/v2.6.2/packages/skia/src/skia/types/Rect.ts
[skia-skia-src]: https://github.com/wcandillon/react-native-skia/blob/v2.6.2/packages/skia/src/skia/types/Skia.ts
[skia-rsx-src]: https://github.com/wcandillon/react-native-skia/blob/v2.6.2/packages/skia/src/skia/types/RSXform.ts
[skia-canvas-type-src]: https://github.com/wcandillon/react-native-skia/blob/v2.6.2/packages/skia/src/skia/types/Canvas.ts
[skia-path-src]: https://github.com/wcandillon/react-native-skia/blob/v2.6.2/packages/skia/src/skia/types/Path/Path.ts
[skia-perf-example]: https://github.com/wcandillon/react-native-skia/blob/v2.6.2/apps/example/src/Examples/Performance/Atlas.tsx
[rea-ufc]: https://docs.swmansion.com/react-native-reanimated/docs/advanced/useFrameCallback
[rea-ufc-451]: https://github.com/software-mansion/react-native-reanimated/blob/4.5.1/docs/docs-reanimated/docs/advanced/useFrameCallback.mdx
[rea-index-451]: https://github.com/software-mansion/react-native-reanimated/blob/4.5.1/packages/react-native-reanimated/src/index.ts
[rea-usv]: https://docs.swmansion.com/react-native-reanimated/docs/core/useSharedValue
[rea-migr]: https://docs.swmansion.com/react-native-reanimated/docs/guides/migration-from-3.x
[rea-compat]: https://docs.swmansion.com/react-native-reanimated/docs/guides/compatibility
[rea-compat-json]: https://github.com/software-mansion/react-native-reanimated/blob/4.5.1/packages/react-native-reanimated/compatibility.json
[rea-perf]: https://docs.swmansion.com/react-native-reanimated/docs/guides/performance
[rea-start]: https://docs.swmansion.com/react-native-reanimated/docs/fundamentals/getting-started
[wk-scheduleonrn]: https://docs.swmansion.com/react-native-worklets/docs/threading/scheduleOnRN
[wk-runonjs]: https://docs.swmansion.com/react-native-worklets/docs/threading/runOnJS
[wk-runonui]: https://docs.swmansion.com/react-native-worklets/docs/threading/runOnUI
[rngh2-detector]: https://docs.swmansion.com/react-native-gesture-handler/docs/2.x/gestures/gesture-detector
[rngh2-tap]: https://docs.swmansion.com/react-native-gesture-handler/docs/2.x/gestures/tap-gesture
[rngh2-config]: https://github.com/software-mansion/react-native-gesture-handler/blob/v2.32.0/packages/docs-gesture-handler/docs/gestures/_shared/base-gesture-config.md
[rngh2-install]: https://docs.swmansion.com/react-native-gesture-handler/docs/2.x/fundamentals/installation
[rngh3-upgrade]: https://docs.swmansion.com/react-native-gesture-handler/docs/guides/upgrading-to-3
[rngh3-legacy]: https://github.com/software-mansion/react-native-gesture-handler/blob/v3.3.0/packages/docs-gesture-handler/docs/legacy-gestures/gesture-detector.md
[rngh-v3-release]: https://github.com/software-mansion/react-native-gesture-handler/releases/tag/v3.0.0
[rn-appstate]: https://reactnative.dev/docs/appstate
[rn-appstate-src]: https://github.com/facebook/react-native-website/blob/main/docs/appstate.md
