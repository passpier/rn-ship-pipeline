# Fixtures

- `app/`: a minimal Expo SDK 55 app with `runtimeVersion: { policy: "fingerprint" }` and one raw inline config plugin. Tests copy it into temp `base` and `candidate` dirs and change the candidate.
- `extras/`: native packages a scenario adds to a candidate, such as `expo-camera`. They're kept out of `app/` because Expo autolinks devDependencies too.

Every identifier here is made up (`com.example.rnshipfixture`, a zero-UUID update URL). Never add real app IDs, EAS project IDs, owners, or DSNs (ADR 0001).
