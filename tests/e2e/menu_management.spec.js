const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const { installPortalApiMocks } = require('./fixtures/mockApi');
const { BOOTSTRAP_DATA } = require('./fixtures/mockData');
const catalog = [...fs.readFileSync('src/backend/services/menu_settings_service.py', 'utf8')
  .matchAll(/\("([a-z-]+)", "([^"\n]+)"\)/g)].map((match) => ({ key: match[1], label: match[2] }));
const hasNotifications = fs.readFileSync('src/static/js/modules/navigation/menu.js', 'utf8').includes("tab: 'notification-settings'");
const declaredKeys = catalog.map((item) => item.key).filter((key) => hasNotifications || key !== 'notification-settings');

async function prepare(page, state, permission = 'システム管理者') {
  await installPortalApiMocks(page, { permission });
  await page.route('**/api/bootstrap*', (route) => route.fulfill({
    json: { ...BOOTSTRAP_DATA, menu_visibility: state.visibility },
    headers: { ETag: JSON.stringify(state.visibility) },
  }));
  await page.route('**/api/system/menu-settings', (route) => {
    if (route.request().method() === 'PUT') {
      if (state.failSave) return route.fulfill({ status: 503, json: { detail: '保存失敗テスト' } });
      state.visibility = route.request().postDataJSON().visibility;
    }
    return route.fulfill({ json: { groups: [{ title: 'メインメニュー', items: catalog }], visibility: state.visibility, optional_keys: ['notification-settings'] } });
  });
  await page.goto('/');
  await page.fill('#portalNameInput', '団員テスト');
  await page.selectOption('#portalPartInput', { label: 'Violin' });
  await page.fill('#portalPasswordInput', 'dummy-pass');
  await page.click('#portalLoginBtn');
  await expect(page.locator('#memberPanel')).toBeVisible();
}

async function openManagement(page) {
  await page.click('#portalDrawerToggle');
  await page.locator('#portalDrawerMenu').getByRole('button', { name: 'システム管理', exact: true }).click();
  await expect(page.locator('#systemPanel')).toBeVisible();
  await page.locator('#systemPanel .toolbar').getByRole('button', { name: 'メニュー管理', exact: true }).click();
  await expect(page.locator('#systemMenuManagementSaveBtn')).toBeEnabled();
}

test('bulk save changes only shared main menus and persists for another user', async ({ page, browser }) => {
  const state = { visibility: Object.fromEntries(catalog.map((item) => [item.key, true])) };
  await prepare(page, state);
  await expect(page.locator('#portalHomeMenu [data-home-tab="notification-settings"]')).toHaveCount(hasNotifications ? 1 : 0);
  await openManagement(page);
  const switches = page.locator('#systemMenuManagementList [role="switch"]');
  await expect(switches).toHaveCount(hasNotifications ? 22 : 21);
  expect(await switches.evaluateAll((inputs) => inputs.map((input) => input.dataset.menuKey))).toEqual(declaredKeys);
  await expect(page.locator('#menu-visible-system')).toHaveCount(0);
  await page.locator('#menu-visible-member-recording').uncheck();
  if (hasNotifications) await page.locator('#menu-visible-notification-settings').uncheck();
  expect(state.visibility['member-recording']).toBe(true);
  await page.screenshot({ path: '.tmp/menu-management-screen.png', fullPage: true });
  await page.click('#systemMenuManagementSaveBtn');
  await expect(page.locator('#systemMenuManagementStatus')).toHaveText('保存しました。');
  expect(Object.keys(state.visibility).sort()).toEqual([...declaredKeys].sort());
  for (const container of ['portalHomeMenu', 'portalDrawerMenu']) {
    await expect(page.locator(`#${container} [data-home-tab="member-recording"]`)).toHaveCount(0);
    await expect(page.locator(`#${container} [data-home-tab="notification-settings"]`)).toHaveCount(0);
    await expect(page.locator(`#${container} [data-home-system]`)).toHaveCount(1);
  }
  // Existing toolbar elements and direct feature routing remain intact.
  await page.locator('.navbar-brand').click();
  await expect(page.locator('#memberPanel [data-tab="member-recording"]')).toHaveCount(1);
  await page.evaluate(() => showMemberTab('member-recording'));
  await expect(page.locator('#memberRecordingTab')).toBeVisible();
  const otherContext = await browser.newContext();
  try {
    const other = await otherContext.newPage();
    await prepare(other, state, '一般');
    await expect(other.locator('#portalHomeMenu [data-home-tab="member-recording"]')).toHaveCount(0);
    await expect(other.locator('#portalHomeMenu [data-home-admin]')).toHaveCount(0);
    await expect(other.locator('#portalHomeMenu [data-home-system]')).toHaveCount(0);
    await expect(other.locator('#portalHomeMenu [data-home-tab="member-schedule"]')).toBeVisible();
  } finally { await otherContext.close(); }
});

test('save failure preserves published settings and leaves switches editable', async ({ page }) => {
  const state = { visibility: Object.fromEntries(catalog.map((item) => [item.key, true])), failSave: true };
  await prepare(page, state);
  await openManagement(page);
  await page.locator('#menu-visible-member-recording').uncheck();
  await page.click('#systemMenuManagementSaveBtn');
  await expect(page.locator('#systemMenuManagementStatus')).toContainText('保存失敗テスト');
  await expect(page.locator('#systemMenuManagementSaveBtn')).toBeEnabled();
  await expect(page.locator('#menu-visible-member-recording')).not.toBeChecked();
  await expect(page.locator('#portalHomeMenu [data-home-tab="member-recording"]')).toHaveCount(1);
});
