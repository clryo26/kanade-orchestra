const { test, expect } = require('@playwright/test');
const { installPortalApiMocks } = require('./fixtures/mockApi');
const { attachErrorMonitor } = require('./fixtures/errorMonitor');

async function loginAsAdmin(page) {
  await page.fill('#portalNameInput', 'administrator');
  await page.fill('#portalPasswordInput', 'dummy-pass');
  await page.click('#portalLoginBtn');
}

test.describe('Admin flow smoke', () => {
  test('admin menu and management tabs are displayed', async ({ page }) => {
    const monitor = attachErrorMonitor(page);
    await installPortalApiMocks(page, { permission: '管理者' });
    await page.goto('/');
    await loginAsAdmin(page);

    await expect(page.locator('#memberPanel')).toBeVisible();

    await page.click('#portalDrawerToggle');
    const drawer = page.locator('#portalDrawerMenu');
    await drawer.getByRole('button', { name: '管理者メニュー' }).click();

    await expect(page.locator('#adminPanel')).toBeVisible();

    for (const tabId of ['#scheduleTab', '#performanceTab', '#uploadTab', '#sheetAdminTab', '#memberTab']) {
      await expect(page.locator(tabId)).toHaveCount(1);
    }

    await expect(page.getByRole('button', { name: '練習予定' })).toBeVisible();
    await expect(page.getByRole('button', { name: '演奏会情報' })).toBeVisible();
    await expect(page.getByRole('button', { name: '団員登録' })).toBeVisible();
    await expect(page.getByRole('button', { name: '支払状況' })).toBeVisible();

    await page.click('#portalDrawerToggle');
    await expect(page.locator('#portalDrawerMenu').getByRole('button', { name: 'システム管理' })).toHaveCount(0);

    monitor.assertNoClientErrors();
  });
});
