const { defineConfig, devices } = require('@playwright/test');

const e2eBaseUrl = process.env.E2E_BASE_URL || 'http://127.0.0.1:8000';
const useExistingServer = process.env.E2E_USE_EXISTING_SERVER === 'true' && !!process.env.E2E_BASE_URL;

module.exports = defineConfig({
  testDir: './tests/e2e',
  timeout: 30000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: e2eBaseUrl,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    locale: 'ja-JP',
  },
  webServer: useExistingServer
    ? undefined
    : {
        command: 'uv run uvicorn src.backend.main:app --host 127.0.0.1 --port 8000',
        url: 'http://127.0.0.1:8000',
        timeout: 120000,
        reuseExistingServer: true,
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
