# Input and HUD

## Touches become commands
- The sim never reads gestures directly.
- A gesture callback converts the touch to world coordinates and appends a command. The next step applies it, so input stays deterministic and testable (see [simulation.md](simulation.md)).
- Example commands: `{ type: 'attract', x, y }` (in the reference sim; a game adds its own, like `feed`), `{ type: 'select', id }`.

```tsx
import { Gesture, GestureDetector } from 'react-native-gesture-handler'; // 2.x builder API (SDK 57)

const tap = useMemo(
  () =>
    Gesture.Tap().onEnd((e) => {
      'worklet';
      const p = toWorld(e.x, e.y, scale.get()); // the one screen→world function
      world.modify((w) => {
        'worklet';
        w.commands.push({ type: 'attract', x: p.x, y: p.y });
        return w;
      });
    }),
  [world, scale],
);

<GestureDetector gesture={tap}>
  <Canvas style={{ flex: 1 }}>…</Canvas>
</GestureDetector>
```

- With Reanimated installed, gesture callbacks are workletized automatically and run on the UI thread.
- `e.x` and `e.y` are relative to the detector's view.
- Memoize gestures with `useMemo`, and give each detector its own gesture instance.
- Combine gestures with `Gesture.Exclusive(doubleTap, tap)`, `Simultaneous` or `Race`.
- Wrap the app root in `<GestureHandlerRootView>`. A modal needs its own root view.
- On Gesture Handler 3.x (SDK 58), the same tap is written as `useTapGesture({ onDeactivate: … })`. See [stack.md](stack.md).

## Hit testing
Skia has no scene-graph hit testing, so do it in world space:
- Find the agent nearest to the touch, and accept it if it's inside that agent's radius.
- Above about 100 agents, query the spatial grid from simulation.md instead of scanning every agent.
- For path shapes, `SkPath.contains(x, y)` works.

## HUD
- The HUD is ordinary RN views laid over the canvas, absolutely positioned. It holds buttons, counters, menus and dialogs.
- Feed it React state that changes only when its value changes, via `scheduleOnRN` (see [game-loop.md](game-loop.md)).
- Give every control a `testID` and an `accessibilityLabel`. Maestro and screen readers see only RN views, never canvas content.
- If a test must tap something drawn on the canvas, lay a transparent `Pressable` with a `testID` over that region.
- Give the canvas container an `accessibilityLabel` that summarizes the scene ("Tank with 12 fish"), and update it when the summary changes.

## Sources
- Skia + gestures: https://wcandillon.github.io/react-native-skia/docs/animations/gestures
- GestureDetector (2.x): https://docs.swmansion.com/react-native-gesture-handler/docs/2.x/gestures/gesture-detector
- Tap gesture (2.x): https://docs.swmansion.com/react-native-gesture-handler/docs/2.x/gestures/tap-gesture
- Installation, root view: https://docs.swmansion.com/react-native-gesture-handler/docs/2.x/fundamentals/installation
