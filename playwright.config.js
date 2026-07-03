const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/e2e',
  timeout: 30000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://127.0.0.1:19081',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    locale: 'ja-JP',
  },
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'uv run uvicorn src.backend.main:app --host 127.0.0.1 --port 19081',
        url: 'http://127.0.0.1:19081',
        timeout: 120000,
        reuseExistingServer: false,
        env: {
          ...process.env,
          PYTHONUTF8: '1',
          DATA_BACKEND: 'local',
          LOCAL_JSON_FALLBACK_ENABLED: 'true',
          HTTP_PROXY: '',
          HTTPS_PROXY: '',
          ALL_PROXY: '',
          NO_PROXY: '127.0.0.1,localhost',
          no_proxy: '127.0.0.1,localhost',
        },
      },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
