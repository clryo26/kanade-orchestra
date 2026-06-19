import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
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
