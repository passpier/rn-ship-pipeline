# Frame budget

A frame is 16.7 ms at 60 Hz and 8.3 ms at 120 Hz. The UI thread does all of these within that time:
- runs the sim steps that are owed;
- fills the Skia buffers;
- draws.

## Measure what you can, in this order
1. **Sim cost, measured anywhere.** Time `stepWorld` over the target agent count in jest or Node, as a microbenchmark of 1,000 steps. It's a proxy, because devices are slower than a dev machine. Aim to keep one step well under 1 ms at the target count. The agent can run this without a device.
2. **Real frame times, on a device in a release build.** Collect `timeSincePreviousFrame` in the frame callback (count, worst value, number of frames over budget), and show the numbers in a dev-only HUD overlay. Test on the lowest-end Android device available, and never judge performance in a debug build.
3. **When frames drop,** profile before you change anything.

## Known causes, from the docs
- Animating many RN views. Reanimated's guide says to stay under about 100 animated components on low-end Android and about 500 on iOS, and to use Skia beyond that. A game canvas is Skia from the start, so keep RN views in the HUD only.
- Reading shared values on the JS thread, which blocks until the threads sync.
- Unmemoized frame callbacks or gestures. Use `useCallback` and `useMemo`.
- One draw per sprite instead of one `<Atlas>` per sheet.
- iOS capped at 60 fps. Allowing 120 Hz on ProMotion needs `CADisableMinimumFrameDurationOnPhone` in Info.plist. Expo's SDK 55 prebuild template already sets it to `true`, so check rather than add it.

## Known causes, from experience (judgment)
- Allocating objects in `stepWorld` or in buffer callbacks: GC pauses show up as periodic hitches.
- O(n²) neighbor checks: use a spatial grid (see [simulation.md](simulation.md)).
- Oversized sprite sheets and many simultaneous audio players: memory pressure on low-end Android.
- `scheduleOnRN` every frame: it floods the JS thread. Push HUD changes only when a value changes.

## Sources
- Reanimated performance guide (4.2.1): https://github.com/software-mansion/react-native-reanimated/blob/4.2.1/docs/docs-reanimated/docs/guides/performance.md
- Skia rendering modes (2.4.18): https://github.com/wcandillon/react-native-skia/blob/v2.4.18/apps/docs/docs/canvas/rendering-modes.md
- Expo SDK 55 iOS template Info.plist: https://github.com/expo/expo/blob/sdk-55/templates/expo-template-bare-minimum/ios/HelloWorld/Info.plist
