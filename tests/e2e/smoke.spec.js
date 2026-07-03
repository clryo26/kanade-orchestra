const { test, expect } = require('@playwright/test');
const { installPortalApiMocks } = require('./fixtures/mockApi');

test.describe('Portal smoke', () => {
  test('top screen and login form are displayed', async ({ page }) => {
    await installPortalApiMocks(page, { permission: '一般' });
    await page.goto('/');

    await expect(page.locator('#portalLoginPanel')).toBeVisible();
    await expect(page.locator('#portalLoginTitle')).toContainText('奏オケ');
    await expect(page.locator('#portalNameInput')).toBeVisible();
    await expect(page.locator('#portalPartInput')).toBeVisible();
    await expect(page.locator('#portalPasswordInput')).toBeVisible();
  });
});
