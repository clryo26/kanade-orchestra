const { test, expect } = require('@playwright/test');
const { installPortalApiMocks } = require('./fixtures/mockApi');
const { attachErrorMonitor } = require('./fixtures/errorMonitor');

async function loginAsMember(page) {
  await page.fill('#portalNameInput', '団員テスト');
  await page.selectOption('#portalPartInput', { label: 'Violin' });
  await page.fill('#portalPasswordInput', 'dummy-pass');
  await page.click('#portalLoginBtn');
}

test.describe('Recordings and scores smoke', () => {
  test('recording and score pages open with empty data without crashing', async ({ page }) => {
    const monitor = attachErrorMonitor(page);
    await installPortalApiMocks(page, {
      permission: '一般',
      bootstrapOverrides: {
        recordings: { files: [] },
        sheets: { files: [] },
      },
    });

    await page.goto('/');
    await loginAsMember(page);

    await page.click('#portalDrawerToggle');
    const drawer = page.locator('#portalDrawerMenu');

    await drawer.getByRole('button', { name: '録音部屋' }).click();
    await expect(page.locator('#memberRecordingTab')).toBeVisible();

    await page.click('#portalDrawerToggle');
    await drawer.getByRole('button', { name: '楽譜ライブラリ' }).click();
    await expect(page.locator('#memberSheetTab')).toBeVisible();

    monitor.assertNoClientErrors();
  });
});
