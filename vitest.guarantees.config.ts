import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const workspaceSdkRoot = resolve(process.cwd(), '../sdk');
const useWorkspaceSdk = existsSync(resolve(workspaceSdkRoot, 'src/index.ts'));

const criticalReviewerFiles = [
  'src/shared/guarantee-review.ts',
  'src/shared/workplan.ts',
  'src/server/guarantee-runs.ts',
  'src/server/evidence.ts',
  'src/server/workplans.ts',
  'src/server/routes.ts',
];

export default defineConfig({
  resolve: useWorkspaceSdk
    ? {
      alias: [
        { find: /^@treeseed\/sdk$/, replacement: resolve(workspaceSdkRoot, 'src/index.ts') },
        { find: /^@treeseed\/sdk\/(.*)$/, replacement: resolve(workspaceSdkRoot, 'src/$1') },
        { find: /^@treeseed\/reviewer$/, replacement: resolve(__dirname, 'src/index.ts') },
        { find: /^@treeseed\/reviewer\/(.*)$/, replacement: resolve(__dirname, 'src/$1') },
      ],
    }
    : undefined,
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: 'coverage-guarantees',
      include: criticalReviewerFiles,
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
});
