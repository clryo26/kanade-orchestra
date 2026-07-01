const { test, expect } = require('@playwright/test');
const { installPortalApiMocks } = require('./fixtures/mockApi');

async function loginAsAdmin(page) {
  await page.fill('#portalNameInput', 'administrator');
  await page.fill('#portalPasswordInput', 'dummy-pass');
  await page.click('#portalLoginBtn');
}

test.describe('Admin menu smoke', () => {
  test('admin menu and core tabs are reachable', async ({ page }) => {
    await installPortalApiMocks(page, { permission: '管理者' });
    await page.goto('/');
    await loginAsAdmin(page);

    await expect(page.locator('#memberPanel')).toBeVisible();

    await page.click('#portalDrawerToggle');
    const drawer = page.locator('#portalDrawerMenu');
    await drawer.getByRole('button', { name: '管理者メニュー' }).click();

    await expect(page.locator('#adminPanel')).toBeVisible();
    for (const label of ['演奏会情報', '練習予定', 'お知らせ', '団員登録', '支払状況']) {
      await expect(page.getByRole('button', { name: label })).toBeVisible();
    }
  });
});
