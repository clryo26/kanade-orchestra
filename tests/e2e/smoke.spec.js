const { test, expect } = require('@playwright/test');
const { installPortalApiMocks } = require('./fixtures/mockApi');
const { attachErrorMonitor } = require('./fixtures/errorMonitor');

async function loginAsMember(page) {
  await page.fill('#portalNameInput', '団員テスト');
  await page.selectOption('#portalPartInput', { label: 'Violin' });
  await page.fill('#portalPasswordInput', 'dummy-pass');
  await page.click('#portalLoginBtn');
}

test.describe('Portal smoke', () => {
  test('top screen and login form are displayed', async ({ page }) => {
    const monitor = attachErrorMonitor(page);
    await installPortalApiMocks(page, { permission: '一般' });
    await page.goto('/');

    await expect(page.locator('#portalLoginPanel')).toBeVisible();
    await expect(page.locator('#portalLoginTitle')).toContainText('奏オケ');
    await expect(page.locator('#portalNameInput')).toBeVisible();
    await expect(page.locator('#portalPartInput')).toBeVisible();
    await expect(page.locator('#portalPasswordInput')).toBeVisible();

    await loginAsMember(page);
    await expect(page.locator('#memberPanel')).toBeVisible();
    await page.click('#portalDrawerToggle');
    const drawer = page.locator('#portalDrawerMenu');
    for (const label of ['練習予定', '演奏会情報', '録音部屋', '楽譜ライブラリ', '欠席連絡']) {
      await expect(drawer.getByRole('button', { name: label })).toBeVisible();
    }

    monitor.assertNoClientErrors();
  });
});
