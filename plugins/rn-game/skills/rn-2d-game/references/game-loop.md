# Game loop

The loop is one `useFrameCallback` that feeds frame time to the sim's `advance` (see [simulation.md](simulation.md)). It runs as a worklet on the UI thread, so the sim never waits on the JS thread, and the JS thread never sees per-frame traffic.

## Where the world lives
Keep the world in one shared value, and mutate it with `modify`. Assigning `world.value = {...}` copies the object every frame, and `world.value.agents.push()` loses reactivity.

```tsx
import { useCallback, useState } from 'react';
import { useFrameCallback, useSharedValue, type FrameInfo } from 'react-native-reanimated';
import { advance, createWorld } from './sim';

// Reanimated 4.2 (SDK 55) has no lazy init: useSharedValue(() => …) would store the function.
const [initialWorld] = useState(() => createWorld(seed, WORLD_W, WORLD_H, COUNT)); // built once
const world = useSharedValue(initialWorld);
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
- `useFrameCallback` (4.2.1): https://github.com/software-mansion/react-native-reanimated/blob/4.2.1/docs/docs-reanimated/docs/advanced/useFrameCallback.mdx
- `useSharedValue`, `modify` (4.2.1): https://github.com/software-mansion/react-native-reanimated/blob/4.2.1/docs/docs-reanimated/docs/core/useSharedValue.mdx
- `scheduleOnRN` (0.7.4): https://github.com/software-mansion/react-native-reanimated/blob/worklets-0.7.4/docs/docs-worklets/docs/threading/scheduleOnRN.mdx
- `AppState`: https://reactnative.dev/docs/appstate
