import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['tests/unit/**/*.test.ts'], environment: 'node' },
      },
      {
        extends: true,
        // Requires a disposable PostgreSQL database: DATABASE_URL=postgres://... (see tests/db/README.md)
        test: {
          name: 'db',
          include: ['tests/db/**/*.test.ts'],
          environment: 'node',
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
      {
        extends: true,
        // Read-only checks of a deployed site: SITE_URL=https://… (safe against production).
        test: { name: 'smoke', include: ['tests/staging/smoke.test.ts'], environment: 'node', testTimeout: 30_000 },
      },
      {
        extends: true,
        // Writes throwaway data to a Supabase STAGING project; see the header of the test file.
        test: { name: 'staging', include: ['tests/staging/supabase.test.ts'], environment: 'node', testTimeout: 60_000, hookTimeout: 60_000, fileParallelism: false },
      },
    ],
  },
})
