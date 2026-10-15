import { describe, expect, it } from 'vitest';
import {
  MAX_FRAME_MS,
  MAX_OFFLINE_MS,
  MAX_SETTLE_MS,
  STEP_MS,
  advance,
  catchUp,
  createWorld,
  stepWorld,
  type World,
} from '../skills/rn-2d-game/examples/sim.ts';

const world = () => createWorld(42, 390, 700, 30);

function runFrames(w: World, frames: number[]) {
  for (const ms of frames) advance(w, ms);
  return w;
}

describe('reference sim', () => {
  it('is deterministic for a seed and differs across seeds', () => {
    const a = world();
    const b = world();
    const c = createWorld(43, 390, 700, 30);
    for (let i = 0; i < 600; i++) [a, b, c].forEach(stepWorld);

    expect(a).toEqual(b);
    expect(a.agents).not.toEqual(c.agents);
  });

  it('gives the same world at 30, 60, 120 fps and with uneven frames', () => {
    const at = (fps: number) => runFrames(world(), Array<number>(fps).fill(1000 / fps));
    const uneven = runFrames(world(), [5, 40, 16, 33, 1, 100, 7, 48, 250, 250, 250]); // sums to 1000

    const reference = at(60);
    expect(reference.steps).toBe(60);
    expect(at(30).agents).toEqual(reference.agents);
    expect(at(120).agents).toEqual(reference.agents);
    expect(uneven.steps).toBe(60);
    expect(uneven.agents).toEqual(reference.agents);
  });

  it('caps one long frame instead of running a burst of steps', () => {
    const w = world();
    advance(w, 10_000);
    expect(w.steps).toBe(Math.round(MAX_FRAME_MS / STEP_MS)); // 250 ms is exactly 15 steps
  });

  it('returns an interpolation factor in [0, 1)', () => {
    const w = world();
    const alpha = advance(w, STEP_MS * 1.5);
    expect(w.steps).toBe(1);
    expect(alpha).toBeCloseTo(0.5);
  });

  it('keeps every agent inside the bounds', () => {
    const w = world();
    for (let i = 0; i < 10_000; i++) stepWorld(w);
    for (const a of w.agents) {
      expect(a.x).toBeGreaterThanOrEqual(0);
      expect(a.x).toBeLessThanOrEqual(w.width);
      expect(a.y).toBeGreaterThanOrEqual(0);
      expect(a.y).toBeLessThanOrEqual(w.height);
    }
  });

  it('continues identically after a JSON save and load', () => {
    const live = world();
    for (let i = 0; i < 100; i++) stepWorld(live);
    const loaded = JSON.parse(JSON.stringify(live)) as World;
    for (let i = 0; i < 100; i++) [live, loaded].forEach(stepWorld);

    expect(loaded).toEqual(live);
  });

  it('applies a command on the next step and draws agents toward it', () => {
    const plain = world();
    const attracted = world();
    const point = { x: 200, y: 350 };
    attracted.commands.push({ type: 'attract', ...point });
    const meanDistance = (w: World) =>
      w.agents.reduce((sum, a) => sum + Math.hypot(a.x - point.x, a.y - point.y), 0) / w.agents.length;
    for (let i = 0; i < 120; i++) [plain, attracted].forEach(stepWorld);

    expect(attracted.commands).toEqual([]);
    expect(meanDistance(attracted)).toBeLessThan(meanDistance(plain));
  });

  it('replays the same commands at the same steps identically', () => {
    const run = () => {
      const w = world();
      for (let i = 0; i < 300; i++) {
        if (i === 50) w.commands.push({ type: 'attract', x: 100, y: 100 });
        stepWorld(w);
      }
      return w;
    };
    expect(run()).toEqual(run());
  });

  it('drops the attract point after it expires', () => {
    const w = world();
    w.commands.push({ type: 'attract', x: 100, y: 100 });
    stepWorld(w);
    expect(w.attract).not.toBeNull();
    for (let i = 0; i < 200; i++) stepWorld(w);
    expect(w.attract).toBeNull();
  });

  describe('catchUp', () => {
    it('caps time away and steps only the settle window', () => {
      const w = world();
      const away = catchUp(w, 0, 3 * 24 * 60 * 60 * 1000);

      expect(away).toBe(MAX_OFFLINE_MS);
      expect(w.steps).toBe(Math.floor(MAX_SETTLE_MS / STEP_MS));
    });

    it('treats a clock that moved backwards as no time away', () => {
      const w = world();
      const before = structuredClone(w);

      expect(catchUp(w, 10_000, 5_000)).toBe(0);
      expect(w).toEqual(before);
    });
  });
});
