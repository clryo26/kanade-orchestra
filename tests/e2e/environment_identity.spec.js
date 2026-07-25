const { test, expect } = require('@playwright/test');
const { installPortalApiMocks } = require('./fixtures/mockApi');

const PROD_URL = 'https://kanade-orchestra-apmcj4meeq-dt.a.run.app';
const TEST_URL = 'https://kanade-orchestra-test-apmcj4meeq-dt.a.run.app';

async function loginAsAdmin(page) {
  await page.fill('#portalNameInput', 'administrator');
  await page.fill('#portalPasswordInput', 'dummy-pass');
  await page.click('#portalLoginBtn');
  await page.click('#portalDrawerToggle');
  await page.locator('#portalDrawerMenu').getByRole('button', { name: '管理者メニュー' }).click();
}

async function dynamicManifest(page) {
  return page.evaluate(async () => {
    const response = await fetch(document.querySelector('link[rel="manifest"]').href);
    return response.json();
  });
}

test.describe('production and test environment identity', () => {
  test('production keeps the current title and shows only the test link to administrators', async ({ page }) => {
    await installPortalApiMocks(page, {
      permission: '管理者',
      revisionPayload: { appEnv: 'production', otherEnvironmentUrl: TEST_URL },
    });
    await page.goto('/');

    await expect(page).toHaveTitle('奏オケポータル');
    await expect(page.locator('#portalLoginTitle')).toHaveText('奏オケポータル');
    await expect(page.locator('#portalBrandTitle')).toHaveText('奏オケポータル');
    await expect(page.locator('meta[name="application-name"]')).toHaveAttribute('content', '奏オケポータル');
    await expect(page.locator('meta[name="apple-mobile-web-app-title"]')).toHaveAttribute('content', '奏オケポータル');
    await expect.poll(() => dynamicManifest(page)).toMatchObject({
      name: '奏オケポータル',
      short_name: '奏オケポータル',
    });

    await loginAsAdmin(page);
    const link = page.locator('#otherEnvironmentLink');
    await expect(link).toBeVisible();
    await expect(link).toHaveText('テスト環境を開く');
    await expect(link).toHaveAttribute('href', TEST_URL);
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(page.getByRole('link', { name: '本番環境を開く' })).toHaveCount(0);
  });

  test('test adds the suffix and shows only the production link to administrators', async ({ page }) => {
    await installPortalApiMocks(page, {
      permission: '管理者',
      revisionPayload: { appEnv: 'test', otherEnvironmentUrl: PROD_URL },
    });
    await page.goto('/');

    await expect(page).toHaveTitle('奏オケポータル(テスト環境)');
    await expect(page.locator('#portalLoginTitle')).toHaveText('奏オケポータル(テスト環境)');
    await expect(page.locator('#portalBrandTitle')).toHaveText('奏オケポータル(テスト環境)');
    await expect(page.locator('meta[name="application-name"]')).toHaveAttribute('content', '奏オケポータル(テスト環境)');
    await expect(page.locator('meta[name="apple-mobile-web-app-title"]')).toHaveAttribute('content', '奏オケポータル(テスト環境)');
    await expect.poll(() => dynamicManifest(page)).toMatchObject({
      name: '奏オケポータル(テスト環境)',
      short_name: '奏オケポータル(テスト環境)',
    });

    await loginAsAdmin(page);
    const link = page.locator('#otherEnvironmentLink');
    await expect(link).toBeVisible();
    await expect(link).toHaveText('本番環境を開く');
    await expect(link).toHaveAttribute('href', PROD_URL);
    await expect(page.getByRole('link', { name: 'テスト環境を開く' })).toHaveCount(0);
  });

  test('general members never see the environment link', async ({ page }) => {
    await installPortalApiMocks(page, {
      permission: '一般',
      revisionPayload: { appEnv: 'production', otherEnvironmentUrl: TEST_URL },
    });
    await page.goto('/');

    await expect(page.locator('#otherEnvironmentLink')).toBeHidden();
    await expect(page.getByRole('link', { name: 'テスト環境を開く' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: '本番環境を開く' })).toHaveCount(0);
  });
});
