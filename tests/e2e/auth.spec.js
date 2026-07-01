const { test, expect } = require('@playwright/test');

test.describe('Authentication smoke', () => {
  test('hidden Administrator can enter the portal with local fallback data', async ({ page }) => {
    await page.goto('/');

    await page.fill('#portalNameInput', 'Administrator');
    await page.fill('#portalPasswordInput', 'systemadminadmin');
    await page.click('#portalLoginBtn');

    await expect(page.locator('#portalLoginPanel')).toBeHidden();
    await expect(page.locator('#memberPanel')).toBeVisible();
    await expect(page.locator('#portalDrawerToggle')).toBeVisible();
  });
});
