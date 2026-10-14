// Fixture app for rnship tests. Every identifier here is made up.
const { withAndroidManifest } = require('expo/config-plugins');

// Raw inline config plugin: @expo/fingerprint can't see changes inside it.
function withFixtureFlag(config) {
  return withAndroidManifest(config, (mod) => {
    const app = mod.modResults.manifest.application[0];
    app['meta-data'] = [
      ...(app['meta-data'] ?? []),
      { $: { 'android:name': 'com.example.rnshipfixture.FLAG', 'android:value': 'on' } },
    ];
    return mod;
  });
}

module.exports = {
  name: 'rnship-fixture',
  slug: 'rnship-fixture',
  version: '1.0.0',
  runtimeVersion: { policy: 'fingerprint' },
  updates: { url: 'https://u.expo.dev/00000000-0000-0000-0000-000000000000' },
  ios: { bundleIdentifier: 'com.example.rnshipfixture' },
  android: { package: 'com.example.rnshipfixture', permissions: [] },
  plugins: [withFixtureFlag],
};
