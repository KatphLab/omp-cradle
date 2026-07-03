import { fileURLToPath } from 'node:url'
import { configDefaults, defineConfig } from 'vitest/config'
import { strictReporter } from './vitest.strict-reporter'

export default defineConfig({
  resolve: {
    alias: {
      '@lib/': fileURLToPath(new URL('src/lib/', import.meta.url)),
      '@utils/': fileURLToPath(new URL('src/utils/', import.meta.url)),
      '@config/': fileURLToPath(new URL('src/config/', import.meta.url)),
      '@types/': fileURLToPath(new URL('src/types/', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    allowOnly: false,
    passWithNoTests: false,
    testTimeout: 10_000,
    reporters: ['default', strictReporter],
    exclude: [
      ...configDefaults.exclude,
      '**/.opencode/**',
      '**/.worktrees/**',
      '**/*.cjs',
      '**/*.mjs',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.{ts,mts}'],
      exclude: [
        'src/**/__tests__/**',
        '**/test-utils/**',
        '.opencode/**',
        'src/types/**',
        '.worktrees/**',
      ],
      thresholds: {
        perFile: true,
        statements: 90,
        branches: 90,
        functions: 90,
        lines: 90,
      },
    },
  },
})
