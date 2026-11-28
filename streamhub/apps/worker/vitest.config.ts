import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: { name: 'unit', include: ['tests/unit/**/*.test.ts'], environment: 'node' },
      },
      {
        // Needs Redis and the S3-compatible storage (pnpm infra:up) plus ffmpeg on PATH.
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          testTimeout: 120_000,
          hookTimeout: 60_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
