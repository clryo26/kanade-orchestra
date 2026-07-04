const { test, expect } = require('@playwright/test');
const { installPortalApiMocks } = require('./fixtures/mockApi');

async function loginAsMember(page) {
  await page.fill('#portalNameInput', '団員テスト');
  await page.selectOption('#portalPartInput', { label: 'Violin' });
  await page.fill('#portalPasswordInput', 'dummy-pass');
  await page.click('#portalLoginBtn');
}

test.describe('Member menu smoke', () => {
  test('member home navigation shows major tabs', async ({ page }) => {
    await installPortalApiMocks(page, { permission: '一般' });
    await page.goto('/');
    await loginAsMember(page);

    await expect(page.locator('#memberPanel')).toBeVisible();

    await page.click('#portalDrawerToggle');
    await expect(page.locator('#portalDrawerMenu')).toBeVisible();
    const drawer = page.locator('#portalDrawerMenu');

    for (const label of ['練習予定', '演奏会情報', '録音部屋', '楽譜ライブラリ', '欠席連絡']) {
      await expect(drawer.getByRole('button', { name: label })).toBeVisible();
    }

    await drawer.getByRole('button', { name: '練習予定' }).click();
    await expect(page.locator('#memberScheduleTab')).toBeVisible();

    await page.click('#portalDrawerToggle');
    await drawer.getByRole('button', { name: '演奏会情報' }).click();
    await expect(page.locator('#memberPerformanceTab')).toBeVisible();

    await page.click('#portalDrawerToggle');
    await drawer.getByRole('button', { name: '録音部屋' }).click();
    await expect(page.locator('#memberRecordingTab')).toBeVisible();

    await page.click('#portalDrawerToggle');
    await drawer.getByRole('button', { name: '楽譜ライブラリ' }).click();
    await expect(page.locator('#memberSheetTab')).toBeVisible();

    await page.click('#portalDrawerToggle');
    await drawer.getByRole('button', { name: '欠席連絡' }).click();
    await expect(page.locator('#memberAbsenceTab')).toBeVisible();
  });
});
