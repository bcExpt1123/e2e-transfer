import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'packages',
          include: ['packages/*/test/**/*.test.ts'],
          environment: 'node',
        },
      },
      'apps/web',
    ],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**', 'apps/web/src/**'],
      exclude: ['**/index.ts', '**/*.d.ts', '**/testing/**'],
      // docs/MAINTAINABILITY.md § Testing pyramid
      thresholds: {
        'packages/core/src/**': { lines: 90 },
        'packages/{signaling,storage}/src/**': { lines: 80 },
      },
    },
  },
});
