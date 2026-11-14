import { defineConfig } from 'vitest/config';

// Opt-in smoke tests against the REAL Qoder API: QODER_PAT=pt-… npm run test:live
export default defineConfig({
  test: { include: ['test/live/**/*.test.ts'], testTimeout: 10 * 60_000, hookTimeout: 120_000, fileParallelism: false },
});
