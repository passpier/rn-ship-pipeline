import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{policy,ota,cli,plugin,release}/test/**/*.test.ts', 'plugins/*/test/**/*.test.ts'],
    testTimeout: 120_000,
  },
});
