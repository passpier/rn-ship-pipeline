# Saves and sound

## Saves
- **Save shape:** `{ version, savedAtMs, world, economy }`. The world is already plain data (see [simulation.md](simulation.md)), so the save is `JSON.stringify` of that object.
- **Storage:** use whichever of `expo-sqlite/kv-store` (an AsyncStorage drop-in that also has `getItemSync`/`setItemSync`) or `@react-native-async-storage/async-storage` the app already has. Expo documents both. A single small key-value entry is enough until saves outgrow it.
- **When to save:** when `AppState` leaves `active` (see [game-loop.md](game-loop.md)), after important events (a purchase, a level-up), and on a slow timer (around 30 s) as a backstop. A save reads the world on the JS thread, which blocks until the threads sync. That's acceptable at this rate.
- **When to load:** at startup, before the loop starts. Migrate first, then `catchUp(world, save.savedAtMs, Date.now())`.
- **Versioning:** keep a `migrations[version]` function for every bump, and test loading a fixture save from the previous version. A save that fails to parse or migrate must never crash the app: fall back to a new game, keep the bad blob under a backup key, and log the failure.

## Sound
```tsx
import { preload, setAudioModeAsync, useAudioPlayer } from 'expo-audio';

preload(require('../assets/sfx/bubble.mp3')); // module scope, so the first play starts without delay

await setAudioModeAsync({ interruptionMode: 'mixWithOthers', playsInSilentMode: false });

const bubble = useAudioPlayer(require('../assets/sfx/bubble.mp3')); // released on unmount
const playBubble = () => { bubble.seekTo(0); bubble.play(); };      // replay pattern from the docs
```

- **Mode:** `mixWithOthers` is the default, and the docs recommend it for sound effects, so the player's own music keeps playing.
  - `playsInSilentMode` defaults to `true`. Most games set it to `false`, so the mute switch silences them.
- **Music:** one player with `player.loop = true`. The `loop: boolean` property is typed, but the docs give no looping example, so check it on a device.
- **Players that outlive a component:** create them with `createAudioPlayer(source)` and call `release()` yourself, or they leak.
- **Background:** pause music when `AppState` leaves `active`, or call `setIsAudioActiveAsync(false)`. The expo-audio config plugin's `enableBackgroundPlayback` defaults to `true`, which adds the iOS `audio` background mode and an Android foreground service. A game without background audio should set it to `false`. Under rn-ship-pipeline, that change is a config change that needs a build.
- **Calling from the UI thread:** sound calls are JS-thread APIs. Trigger them from a worklet with `scheduleOnRN(playBubble)`, and throttle bursts, for example to one bubble sound per 100 ms.
- **Limits:** no maximum number of concurrent players is documented, so reuse a small pool per effect rather than one player per event. For sample-accurate or heavy audio, the Expo docs point to React Native Audio API.

## Sources
- expo-audio (SDK 57): https://docs.expo.dev/versions/v57.0.0/sdk/audio/
- Storing data: https://docs.expo.dev/develop/user-interface/store-data/
- expo-sqlite, kv-store: https://docs.expo.dev/versions/v57.0.0/sdk/sqlite/
