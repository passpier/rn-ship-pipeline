import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classify } from '../src/index.ts';
import { scenario } from './scenario.ts';

describe('classify', () => {
  it('ships a JS-only change as an OTA update on both platforms', async () => {
    const s = await scenario();
    s.edit('src/App.js', (text) => text.replace('rnship fixture', 'rnship fixture v2'));

    const result = await classify({ base: s.base, artifacts: s.artifacts, candidate: s.candidate });

    expect(result).toMatchObject({ ios: 'OTA', android: 'OTA', reasons: [], base_build_id: 'fixture-build-1' });
  });

  it("fingerprints with the app's own @expo/fingerprint, and needs a build when the build used another version", async () => {
    const s = await scenario();
    const buildJson = join(s.artifacts, 'build.json');
    const fromExpo = createRequire(createRequire(join(s.base, 'package.json')).resolve('expo/package.json'));
    const appVersion = (JSON.parse(readFileSync(fromExpo.resolve('@expo/fingerprint/package.json'), 'utf8')) as { version: string }).version;
    expect(JSON.parse(readFileSync(buildJson, 'utf8'))).toMatchObject({ fingerprintVersion: appVersion });

    writeFileSync(buildJson, JSON.stringify({ buildId: 'fixture-build-1', fingerprintVersion: '0.0.1' }));
    const result = await classify({ base: s.base, artifacts: s.artifacts, candidate: s.candidate });

    expect(result).toMatchObject({ ios: 'BUILD', android: 'BUILD' });
    expect(result.reasons).toContainEqual(expect.objectContaining({ ruleId: 'fingerprint.version_changed' }));
  });

  it('needs a store build and the permissions gate when expo-camera is added', async () => {
    const s = await scenario();
    s.installExtra('expo-camera');
    s.edit('package.json', (text) => text.replace('"expo-status-bar"', '"expo-camera": "~55.0.23",\n    "expo-status-bar"'));
    s.edit('app.config.js', (text) => text.replace('plugins: [withFixtureFlag]', "plugins: [withFixtureFlag, 'expo-camera']"));

    const result = await classify({ base: s.base, artifacts: s.artifacts, candidate: s.candidate });

    expect(result).toMatchObject({ ios: 'BUILD', android: 'BUILD' });
    expect(result.reasons.map((r) => r.ruleId)).toContain('fingerprint.changed');
    expect(result.gates).toContainEqual(
      expect.objectContaining({ ruleId: 'permissions.native', matches: expect.arrayContaining(['plugins[expo-camera]']) }),
    );
  });

  it('needs a store build when android.permissions changes', async () => {
    const s = await scenario();
    s.edit('app.config.js', (text) => text.replace('permissions: []', "permissions: ['android.permission.VIBRATE']"));

    const result = await classify({ base: s.base, artifacts: s.artifacts, candidate: s.candidate });

    expect(result.android).toBe('BUILD');
    expect(result.gates).toContainEqual(
      expect.objectContaining({ ruleId: 'permissions.native', matches: ['android.permissions'] }),
    );
  });

  it('needs a store build when a raw inline config plugin is edited, which the fingerprint misses', async () => {
    const s = await scenario();
    s.edit('app.config.js', (text) => text.replace("'android:value': 'on'", "'android:value': 'off'"));

    const result = await classify({ base: s.base, artifacts: s.artifacts, candidate: s.candidate });

    expect(result).toMatchObject({ ios: 'BUILD', android: 'BUILD' });
    expect(result.reasons).toContainEqual(
      expect.objectContaining({ ruleId: 'gap.inline_config_plugin', verdict: 'BUILD' }),
    );
  });

  it('needs a store build when app JS requires a native module the build does not ship', async () => {
    const s = await scenario();
    s.write('src/foo.js', "import { requireNativeModule } from 'expo';\nexport default requireNativeModule('Foo');\n");

    const result = await classify({ base: s.base, artifacts: s.artifacts, candidate: s.candidate });

    expect(result).toMatchObject({ ios: 'BUILD', android: 'BUILD' });
    expect(result.reasons).toContainEqual(
      expect.objectContaining({ ruleId: 'gap.unknown_native_module', detail: expect.stringContaining('Foo') }),
    );
  });

  it('ships app JS that requires a native module the build already has as an OTA update', async () => {
    const s = await scenario();
    s.write('src/updates.js', "import { requireNativeModule } from 'expo';\nexport default requireNativeModule('ExpoUpdates');\n");

    const result = await classify({ base: s.base, artifacts: s.artifacts, candidate: s.candidate });

    expect(result).toMatchObject({ ios: 'OTA', android: 'OTA', reasons: [] });
  });

  it('needs a store build when the fingerprint configuration changes', async () => {
    const s = await scenario();
    s.write('.fingerprintignore', 'android/**/*\n');

    const result = await classify({ base: s.base, artifacts: s.artifacts, candidate: s.candidate });

    expect(result).toMatchObject({ ios: 'BUILD', android: 'BUILD' });
    expect(result.reasons).toContainEqual(expect.objectContaining({ ruleId: 'gap.fingerprint_config' }));
  });

  it('needs a store build when the expo-updates configuration changes', async () => {
    const s = await scenario();
    s.edit('app.config.js', (text) => text.replace('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111'));

    const result = await classify({ base: s.base, artifacts: s.artifacts, candidate: s.candidate });

    expect(result).toMatchObject({ ios: 'BUILD', android: 'BUILD' });
    expect(result.reasons).toContainEqual(
      expect.objectContaining({ ruleId: 'gap.updates_config', detail: expect.stringContaining('updates.url') }),
    );
  });

  it('needs a store build when a patch touches a package that ships native code', async () => {
    const s = await scenario();
    s.write('patches/expo-updates+55.0.30.patch', 'diff --git a/node_modules/expo-updates/ios/EXUpdates/AppController.swift b/node_modules/expo-updates/ios/EXUpdates/AppController.swift\n');

    const result = await classify({ base: s.base, artifacts: s.artifacts, candidate: s.candidate });

    expect(result).toMatchObject({ ios: 'BUILD', android: 'BUILD' });
    expect(result.reasons).toContainEqual(
      expect.objectContaining({ ruleId: 'gap.native_patch', detail: expect.stringContaining('expo-updates') }),
    );
  });

  it('asks a human when a JS-only change adds a permission prompt', async () => {
    const s = await scenario();
    s.write(
      'src/notify.js',
      "import * as Notifications from 'expo-notifications';\nexport const ask = () => Notifications.requestPermissionsAsync();\n",
    );

    const result = await classify({ base: s.base, artifacts: s.artifacts, candidate: s.candidate });

    expect(result).toMatchObject({ ios: 'HUMAN', android: 'HUMAN' });
    expect(result.reasons).toContainEqual(expect.objectContaining({ ruleId: 'store.permission_prompt', verdict: 'HUMAN' }));
  });

  it('asks a human when a JS-only change adds an expo-router screen', async () => {
    const s = await scenario();
    s.write('app/settings.js', "import { Text } from 'react-native';\nexport default function Settings() { return <Text>Settings</Text>; }\n");

    const result = await classify({ base: s.base, artifacts: s.artifacts, candidate: s.candidate });

    expect(result).toMatchObject({ ios: 'HUMAN', android: 'HUMAN' });
    expect(result.reasons).toContainEqual(
      expect.objectContaining({ ruleId: 'store.new_screen', detail: expect.stringContaining('app/settings.js') }),
    );
  });
});
