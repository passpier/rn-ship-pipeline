# Game loop

The loop is one `useFrameCallback` that feeds frame time to the sim's `advance` (see [simulation.md](simulation.md)). It runs as a worklet on the UI thread, so the sim never waits on the JS thread, and the JS thread never sees per-frame traffic.

## Where the world lives
Keep the world in one shared value, and mutate it with `modify`. Assigning `world.value = {...}` copies the object every frame, and `world.value.agents.push()` loses reactivity.

```tsx
import { useCallback } from 'react';
import { useFrameCallback, useSharedValue, type FrameInfo } from 'react-native-reanimated';
import { advance, createWorld } from './sim';

const world = useSharedValue(() => createWorld(seed, WORLD_W, WORLD_H, COUNT)); // lazy init: Reanimated ≥ 4.4
const alpha = useSharedValue(0); // interpolation factor for the renderer

const loop = useFrameCallback(
  useCallback((info: FrameInfo) => {
    'worklet';
    const frameMs = info.timeSincePreviousFrame ?? 0; // null on the first frame after activation
    world.modify((w) => {
      'worklet';
      alpha.set(advance(w, frameMs));
      return w;
    });
  }, [world, alpha]),
);
```

- `useFrameCallback(cb, autostart = true)` returns `{ setActive, isActive, callbackId }`.
- `FrameInfo` has three fields:
  - `timestamp`;
  - `timeSincePreviousFrame`, which is `null` right after activation;
  - `timeSinceFirstFrame`.
- Memoize the callback with `useCallback`, which the Reanimated performance guide recommends.
- Prefer `get()`/`set()` over `.value`. They mean the same thing, but `get`/`set` is what React Compiler expects.

## Pause and resume
It isn't documented that frame callbacks stop when the app is backgrounded, so stop them explicitly:

```tsx
useEffect(() => {
  const sub = AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      // catchUp(...) for the time away (simulation.md), then:
      loop.setActive(true);
    } else {
      loop.setActive(false);
      // save here (persistence-audio.md)
    }
  });
  return () => sub.remove();
}, [loop]);
```

Re-activation gives `timeSincePreviousFrame: null`, which counts as 0. A resume therefore never turns into a burst of steps, and `MAX_FRAME_MS` bounds any other long frame.

## Getting data to React
- The HUD (score, coins, a modal) lives in React state. Push changes with `scheduleOnRN(setCoins, value)`, imported from `react-native-worklets`, and only when the value changes, never every frame.
- `setCoins` must be defined on the RN side, in the component body or a module, not inside a worklet.
- Reading a shared value on the JS thread blocks until the threads sync. That's fine for an occasional save, but don't do it in a render or a timer.

## Sources
- `useFrameCallback`: https://docs.swmansion.com/react-native-reanimated/docs/advanced/useFrameCallback
- `useSharedValue`, `modify`: https://docs.swmansion.com/react-native-reanimated/docs/core/useSharedValue
- `scheduleOnRN`: https://docs.swmansion.com/react-native-worklets/docs/threading/scheduleOnRN
- `AppState`: https://reactnative.dev/docs/appstate
