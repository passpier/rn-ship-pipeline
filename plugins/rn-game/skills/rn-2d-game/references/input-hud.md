# Input and HUD

## Touches become commands
- The sim never reads gestures directly.
- A gesture callback converts the touch to world coordinates and appends a command. The next step applies it, so input stays deterministic and testable (see [simulation.md](simulation.md)).
- Example commands: `{ type: 'attract', x, y }` (in the reference sim; a game adds its own, like `feed`), `{ type: 'select', id }`.

```tsx
import { Gesture, GestureDetector } from 'react-native-gesture-handler'; // 2.x builder API (SDK 55)

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
- Don't copy the hook API (`useTapGesture({ onDeactivate: … })`) from the current docs. It's Gesture Handler 3, which SDK 55 doesn't have. See [stack.md](stack.md).

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
- Skia + gestures (2.4.18): https://github.com/wcandillon/react-native-skia/blob/v2.4.18/apps/docs/docs/animations/gestures.md
- GestureDetector (2.30): https://github.com/software-mansion/react-native-gesture-handler/blob/v2.30.0/packages/docs-gesture-handler/docs/gestures/gesture-detector.md
- Tap gesture (2.30): https://github.com/software-mansion/react-native-gesture-handler/blob/v2.30.0/packages/docs-gesture-handler/docs/gestures/tap-gesture.md
- Installation, root view (2.30): https://github.com/software-mansion/react-native-gesture-handler/blob/v2.30.0/packages/docs-gesture-handler/docs/fundamentals/installation.md
