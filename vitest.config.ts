import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // stt.ts needs a local whisper install; covered by its own opt-in checks.
      exclude: ['src/stt.ts'],
      reporter: ['text-summary', 'json-summary', 'html'],
      // A little under the current numbers: fail on real regressions only.
      thresholds: { lines: 86, statements: 86, functions: 85, branches: 80 },
    },
  },
})
