# Simulation: state, time, randomness

The reference implementation is [../examples/sim.ts](../examples/sim.ts), and its tests are `plugins/rn-game/test/sim.test.ts`. Copy the pattern, not the constants.

## Rules
1. **The world is plain data.** It's numbers, strings, arrays and plain objects: no classes, Maps, functions or Skia objects. That gives you three things:
   - a save file is `JSON.stringify(world)`;
   - tests can compare worlds with `toEqual`;
   - the world can live in a shared value and cross threads.
2. **Steps are pure and fixed-size.** `stepWorld(world)` advances exactly one step (`STEP_MS`, 1/60 s). Frame time goes through `advance(world, frameMs)`:
   - It adds the frame's time to an accumulator, runs every whole step that's owed, and returns `alpha` for drawing between the previous and current positions.
   - A 30 Hz device, a 120 Hz device, and a janky frame sequence all produce the same world after the same total time. The tests check this.
   - It clamps one frame to `MAX_FRAME_MS`, so a debugger pause or a resume from background can't trigger thousands of catch-up steps in one frame.
3. **Randomness is seeded, and the RNG state lives in the world.** Never call `Math.random()` in sim code. With a seed, tests are reproducible, a bug report can carry the seed, and a save and load continues the same sequence.
4. **The sim doesn't import from React Native, Skia or Reanimated.** Rendering reads the world, and input writes *commands* (for example `{ type: 'feed', x, y }`) into a queue that the next step applies. Then jest can test everything that matters.
5. **Mutate in place inside a step.** Allocating objects every frame on the UI thread causes GC pauses. Allocation is fine in tests and in save/load code.
6. **Mark sim functions with `'worklet'`** so that they can run inside `useFrameCallback` on the UI thread. The directive is a plain string, so jest ignores it. See [game-loop.md](game-loop.md) for where the world lives.

## Offline progress (idle games)
- Save `savedAtMs` (wall clock) with the world. On load, call `catchUp(world, savedAtMs, Date.now())`. It:
  - caps time away at `MAX_OFFLINE_MS`;
  - treats a clock that moved backwards as zero;
  - steps only the first `MAX_SETTLE_MS` of motion, so positions look natural.
- Apply slow state in **closed form** for the returned duration, for example `coins += ratePerMs * away`, or hunger rising linearly up to a cap. Never step hours at 60 Hz.
- Clock changes are an exploit. The cap limits the gain, and if the economy matters, also refuse to give credit when `now` is earlier than the last *seen* time.

## Many agents
- Steering (wander, seek, flee, staying inside bounds) costs O(n) per step. Flocking (separation, alignment, cohesion) is O(n²) if every agent checks every other.
- Above about 100 agents, use a uniform grid: bucket agents by cell each step and check only the neighboring cells.
- Measure before optimizing. See [perf.md](perf.md).

## Save format
- Put `version: n` in the save, and keep one migration function per version bump. Loading an old save must never throw: migrate it, or fall back to a fresh world and log the failure.
- See [persistence-audio.md](persistence-audio.md) for where the save lives.
