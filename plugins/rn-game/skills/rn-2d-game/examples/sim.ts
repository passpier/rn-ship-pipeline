// Reference simulation for the rn-2d-game skill: agents wandering inside a
// bounded area. It follows the rules in references/simulation.md:
// - The world is plain JSON-safe data, so a save file is JSON.stringify(world).
// - Time advances in fixed steps, so results don't depend on frame rate.
// - Randomness comes from a seeded RNG whose state lives in the world.
// - No React Native imports, so jest/vitest can run it as-is.
// Every function is a worklet, so the same code can run on the UI thread from useFrameCallback.

export const STEP_MS = 1000 / 60;
// A long frame (a debugger pause, a GC, the app resuming) runs at most this much sim time.
export const MAX_FRAME_MS = 250;
// Offline progress is capped, and only the first few seconds are simulated step by step.
export const MAX_OFFLINE_MS = 8 * 60 * 60 * 1000;
export const MAX_SETTLE_MS = 5_000;

const EPSILON_MS = 1e-6; // absorbs float drift when frame times sum to an exact multiple of STEP_MS
const CRUISE_SPEED = 60; // px/s
const MAX_SPEED = 90;
const TURN_RATE = 2; // how fast velocity follows the wander heading, 1/s
const WANDER_JITTER = 0.6; // max heading change per step, radians
const EDGE_MARGIN = 40; // px
const ATTRACT_STEPS = 180; // how long an attract point lasts: 3 s
const ATTRACT_RADIUS = 250; // agents farther away ignore it

export type Agent = {
  x: number;
  y: number;
  prevX: number; // position before the last step, for render interpolation
  prevY: number;
  vx: number;
  vy: number;
  heading: number;
};

// Input from gestures, applied at the start of the next step (references/input-hud.md).
export type Command = { type: 'attract'; x: number; y: number };

export type World = {
  width: number;
  height: number;
  agents: Agent[];
  commands: Command[];
  attract: { x: number; y: number; untilStep: number } | null;
  rng: number; // mulberry32 state
  accMs: number; // sim time owed but not yet stepped
  steps: number;
};

/** mulberry32: a small, fast PRNG whose whole state is one 32-bit int. */
export function random(world: World): number {
  'worklet';
  let t = (world.rng = (world.rng + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function createWorld(seed: number, width: number, height: number, count: number): World {
  'worklet';
  const world: World = { width, height, agents: [], commands: [], attract: null, rng: seed | 0, accMs: 0, steps: 0 };
  for (let i = 0; i < count; i++) {
    const x = EDGE_MARGIN + random(world) * (width - 2 * EDGE_MARGIN);
    const y = EDGE_MARGIN + random(world) * (height - 2 * EDGE_MARGIN);
    const heading = random(world) * 2 * Math.PI;
    world.agents.push({
      x,
      y,
      prevX: x,
      prevY: y,
      vx: Math.cos(heading) * CRUISE_SPEED,
      vy: Math.sin(heading) * CRUISE_SPEED,
      heading,
    });
  }
  return world;
}

/** One fixed step. Mutates in place: no per-frame allocation on the UI thread. */
export function stepWorld(world: World): void {
  'worklet';
  const dt = STEP_MS / 1000;
  const { width, height } = world;
  for (const c of world.commands) {
    if (c.type === 'attract') world.attract = { x: c.x, y: c.y, untilStep: world.steps + ATTRACT_STEPS };
  }
  world.commands.length = 0;
  if (world.attract && world.steps >= world.attract.untilStep) world.attract = null;
  const target = world.attract;

  for (const a of world.agents) {
    a.prevX = a.x;
    a.prevY = a.y;

    const nearEdge =
      a.x < EDGE_MARGIN || a.x > width - EDGE_MARGIN || a.y < EDGE_MARGIN || a.y > height - EDGE_MARGIN;
    const jitter = (random(world) - 0.5) * WANDER_JITTER; // drawn every step, so RNG use doesn't depend on branches
    if (nearEdge) a.heading = Math.atan2(height / 2 - a.y, width / 2 - a.x);
    else if (target && Math.hypot(target.x - a.x, target.y - a.y) < ATTRACT_RADIUS)
      a.heading = Math.atan2(target.y - a.y, target.x - a.x);
    else a.heading += jitter;

    a.vx += (Math.cos(a.heading) * CRUISE_SPEED - a.vx) * TURN_RATE * dt;
    a.vy += (Math.sin(a.heading) * CRUISE_SPEED - a.vy) * TURN_RATE * dt;
    const speed = Math.hypot(a.vx, a.vy);
    if (speed > MAX_SPEED) {
      a.vx *= MAX_SPEED / speed;
      a.vy *= MAX_SPEED / speed;
    }

    a.x = Math.min(Math.max(a.x + a.vx * dt, 0), width);
    a.y = Math.min(Math.max(a.y + a.vy * dt, 0), height);
  }
  world.steps++;
}

/**
 * Feed one frame's elapsed time (FrameInfo.timeSincePreviousFrame in useFrameCallback).
 * Runs as many fixed steps as are owed and returns the interpolation factor in [0, 1)
 * for drawing between prev and current positions.
 */
export function advance(world: World, frameMs: number): number {
  'worklet';
  world.accMs += Math.min(Math.max(frameMs, 0), MAX_FRAME_MS);
  while (world.accMs >= STEP_MS - EPSILON_MS) {
    stepWorld(world);
    world.accMs -= STEP_MS;
  }
  return Math.min(Math.max(world.accMs / STEP_MS, 0), 1);
}

export function lerp(from: number, to: number, alpha: number): number {
  'worklet';
  return from + (to - from) * alpha;
}

/**
 * Catch up after the app was closed or backgrounded. Returns the capped time away.
 * The caller applies slow-moving state (currency, hunger, growth) for that time
 * in closed form, for example `coins += ratePerMs * away`, rather than stepping
 * hours of motion. Only the first MAX_SETTLE_MS of motion is stepped. A clock that
 * moved backwards counts as no time away.
 */
export function catchUp(world: World, savedAtMs: number, nowMs: number): number {
  'worklet';
  const away = Math.min(Math.max(nowMs - savedAtMs, 0), MAX_OFFLINE_MS);
  const settleSteps = Math.floor(Math.min(away, MAX_SETTLE_MS) / STEP_MS);
  for (let i = 0; i < settleSteps; i++) stepWorld(world);
  return away;
}
