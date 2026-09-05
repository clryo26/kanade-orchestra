const { test, expect } = require('@playwright/test');
const { installPortalApiMocks } = require('./fixtures/mockApi');
const { attachErrorMonitor } = require('./fixtures/errorMonitor');

async function loginAsMember(page) {
  await page.fill('#portalNameInput', '団員テスト');
  await page.selectOption('#portalPartInput', { label: 'Violin' });
  await page.fill('#portalPasswordInput', 'dummy-pass');
  await page.click('#portalLoginBtn');
}

test.describe('Member flow smoke', () => {
  test('member menu major tabs are reachable', async ({ page }) => {
    const monitor = attachErrorMonitor(page);
    await installPortalApiMocks(page, { permission: '一般' });
    await page.goto('/');
    await loginAsMember(page);

    await expect(page.locator('#memberPanel')).toBeVisible();

    await page.click('#portalDrawerToggle');
    const drawer = page.locator('#portalDrawerMenu');

    await drawer.getByRole('button', { name: '練習予定' }).click();
    await expect(page.locator('#memberScheduleTab')).toBeVisible();

    await page.click('#portalDrawerToggle');
    await drawer.getByRole('button', { name: '録音部屋' }).click();
    await expect(page.locator('#memberRecordingTab')).toBeVisible();

    await page.click('#portalDrawerToggle');
    await drawer.getByRole('button', { name: '楽譜ライブラリ' }).click();
    await expect(page.locator('#memberSheetTab')).toBeVisible();

    await page.click('#portalDrawerToggle');
    await drawer.getByRole('button', { name: '演奏会情報' }).click();
    await expect(page.locator('#memberPerformanceTab')).toBeVisible();

    await page.click('#portalDrawerToggle');
    await expect(drawer.getByRole('button', { name: '管理者メニュー' })).toHaveCount(0);
    await expect(page.locator('#adminPanel')).toBeHidden();

    monitor.assertNoClientErrors();
  });
});
