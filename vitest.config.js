import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // A single worker keeps the suite deterministic in constrained CI/agent environments.
    // The tests share global browser-like state, so parallel worker churn can exit unexpectedly.
    pool: 'forks',
    maxWorkers: 1,
    globals: true,
    include: ['tests/frontend/**/*.test.js', 'tests/integration/frontend/**/*.test.js'],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage/frontend',
      reporter: ['text', 'json-summary', 'lcov'],
      include: ['src/static/js/frontend_testable_logic.js'],
    },
  },
});
