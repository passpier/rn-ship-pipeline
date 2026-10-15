---
name: rn-2d-game
description: 2D game work in an Expo React Native app. Use it for game loops, sprites or many animated objects on a Skia canvas, touch input in a game world, game state, saves and offline progress, and sound effects. Read it before writing or changing that code.
---

# 2D games in Expo React Native

A game screen splits into four parts:
- the **sim**: plain data that steps forward in fixed time;
- the **loop**: a `useFrameCallback` on the UI thread that feeds frame time to the sim;
- the **canvas**: Skia, drawing straight from shared values;
- the **HUD**: ordinary RN views on top.

Per-frame work stays on the **UI thread**, and React renders only when the HUD changes.

## Steps
1. **Stack.** Check `package.json` against [references/stack.md](references/stack.md). If a package is missing and the app has `.rnship/`, read [references/pipeline.md](references/pipeline.md) before anything else. Done when every package the task needs is present at a version that matches the app's Expo SDK.
2. **Sim.** Model the state and the step function as pure, seeded and fixed-step, following [references/simulation.md](references/simulation.md) and [examples/sim.ts](examples/sim.ts). Write the jest tests first. Done when the tests pass with a fixed seed and the sim imports nothing from React Native, Skia or Reanimated.
3. **Loop.** Wire the sim to the frame clock: [references/game-loop.md](references/game-loop.md). Done when the loop pauses in the background and resumes without a burst of catch-up steps.
4. **Canvas.** Draw from the world: [references/rendering.md](references/rendering.md). Done when nothing in the frame path calls `setState`.
5. **Input and HUD.** [references/input-hud.md](references/input-hud.md). Done when touches map to world coordinates through one function, and every control a smoke test needs has a `testID`.
6. **Saves and sound**, when the task touches them: [references/persistence-audio.md](references/persistence-audio.md). Done when saves are versioned, and loading a save from the previous version is tested.
7. **Frame budget.** Check against [references/perf.md](references/perf.md) at the agent count the task specifies, or at 2× the count on screen today. Done when you've reported the measurement, or said that you couldn't measure it and why.

Constants (sizes, speeds, rates) go in one tuning module, because they're what changes most often and what ships as an OTA update.
