# Rendering with Skia

Skia props accept Reanimated shared and derived values directly, so there's no `useAnimatedProps` and no React render when they change. The canvas reads the world, and nothing in the frame path calls `setState`.

## Choose a mode
- **Many sprites from one sheet, fixed count:** `<Atlas>`, which draws them all in one call. This is the default for a scene full of agents.
- **Entities created and destroyed often, or drawing that changes shape each frame:** the Picture API (immediate mode). It records draw commands in a worklet, and costs more per frame.
- **A few static things** (background, decor): ordinary elements like `<Image>`, `<Rect>`, `<Path>`. Bake static layers into a texture with `useTexture` or `usePictureAsTexture`.
- You can mix modes in one `<Canvas>`.

## Atlas from the world
```tsx
import { Atlas, Canvas, rect, useImage, useRSXformBuffer, useRectBuffer } from '@shopify/react-native-skia';
import { lerp } from './sim';

const sheet = useImage(require('../assets/sprites.png')); // SkImage | null until loaded
const transforms = useRSXformBuffer(COUNT, (val, i) => {
  'worklet';
  const w = world.get();
  const a = w.agents[i];
  if (!a) { val.set(0, 0, 0, 0); return; } // spare slot: scale 0 hides it
  const t = alpha.get();
  const x = lerp(a.prevX, a.x, t);
  const y = lerp(a.prevY, a.y, t);
  // RSXform maps sprite point (px, py) to (x, y): rotate by `angle`, scale by `s`, around the sprite's center.
  const angle = 0; // or a.heading for top-down sprites
  const scos = SCALE * Math.cos(angle);
  const ssin = SCALE * Math.sin(angle);
  val.set(scos, ssin, x - (scos * PX - ssin * PY), y - (ssin * PX + scos * PY));
});
const sprites = useRectBuffer(COUNT, (r, i) => {
  'worklet';
  const a = world.get().agents[i];
  // pick the frame from the sheet: a facing direction, an animation frame from w.steps, a species…
  r.setXYWH(a && a.vx < 0 ? FRAME_W : 0, 0, FRAME_W, FRAME_H);
});

return (
  <Canvas style={{ flex: 1 }}>
    {sheet && <Atlas image={sheet} sprites={sprites} transforms={transforms} />}
  </Canvas>
);
```

- Every buffer callback needs the `'worklet'` directive. The Skia docs call this out.
- The buffers recompute when a shared value they capture changes. Here that's `alpha`, which changes every frame.
- The buffer size is fixed by `COUNT`, so give it the maximum capacity, and hide spare slots with a zero transform (a judgment call, not documented). If capacity changes a lot, switch to the Picture API.
- `Skia.RSXformFromRadians(scale, rad, tx, ty, px, py)` builds the same transform, but it allocates. Use `val.set(...)` inside buffers.
- `Atlas` also takes `colors` (per-sprite tint, via `useColorBuffer`), `colorBlendMode` and `sampling`.

## Images
- `useImage(require(...))` loads from the JS bundle. Bundled assets ship in OTA updates.
- For pixel art, pass `sampling={{ filter: FilterMode.Nearest, mipmap: MipmapMode.Nearest }}`. For smooth scaling, pass `sampling={CubicSampling}`.
- Pack sprites into one sheet per layer. One sheet means one Atlas draw.
- Size sheets for the largest scale you draw at. A 4096² RGBA texture is 64 MB of GPU memory.

## World units and screen size
- Simulate in fixed world units, such as a 1000×600 tank, and scale to the screen.
- Get the size from `<Canvas onSize={sizeSharedValue}>` on the UI thread, or from `useCanvasSize()` on the JS thread. `onLayout` doesn't work on Fabric.
- Wrap the scene in `<Group transform={derivedScaleTransform}>`.
- Input maps back through the same scale. See [input-hud.md](input-hud.md).

## Sources
- Animations (shared values as props): https://wcandillon.github.io/react-native-skia/docs/animations/animations
- Atlas: https://wcandillon.github.io/react-native-skia/docs/shapes/atlas
- Buffer hooks: https://wcandillon.github.io/react-native-skia/docs/animations/hooks
- Rendering modes: https://wcandillon.github.io/react-native-skia/docs/canvas/rendering-modes
- Pictures: https://wcandillon.github.io/react-native-skia/docs/shapes/pictures
- Images: https://wcandillon.github.io/react-native-skia/docs/images
- Performance example, 300+ sprites: https://github.com/wcandillon/react-native-skia/blob/v2.6.2/apps/example/src/Examples/Performance/Atlas.tsx
