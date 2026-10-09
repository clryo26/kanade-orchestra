const { test, expect } = require('@playwright/test');
const { installPortalApiMocks } = require('./fixtures/mockApi');

const categories = { notices: 'お知らせ', schedules: '練習予定', recordings: '録音部屋', piece_infos: '楽曲情報',
  sheets: '楽譜ライブラリ', events: 'イベント調整', maintenance: 'メンテナンス情報', improvements: '改善要望受付' };

async function prepare(page, permission = '一般', options = {}) {
  await installPortalApiMocks(page, { permission });
  const visible = { ...categories };
  if (permission !== 'システム管理者') delete visible.improvements;
  let preferences = Object.fromEntries(Object.keys(visible).map((key) => [key, true]));
  let failSave = false;
  let subscriptions = 0;
  let subscribed = false;
  await page.route('**/api/notifications/**', async (route) => {
    const req = route.request();
    if (req.url().includes('/subscriptions')) subscriptions++;
    if (req.url().includes('/subscriptions') && req.method() === 'POST') {
      subscribed = true;
      return route.fulfill({ json: { id: 'test-subscription' } });
    }
    if (req.url().includes('/subscriptions') && req.method() === 'DELETE') {
      subscribed = false;
      return route.fulfill({ json: { ok: true } });
    }
    if (req.method() === 'PUT') {
      if (failSave) return route.fulfill({ status: 500, json: { detail: '保存失敗' } });
      preferences = { ...preferences, ...req.postDataJSON().preferences };
      return route.fulfill({ json: { preferences } });
    }
    return route.fulfill({ json: { categories: visible, preferences, configured: options.configured || false, subscribed, public_key: options.publicKey || '' } });
  });
  await page.goto('/');
  await page.fill('#portalNameInput', '団員テスト');
  await page.selectOption('#portalPartInput', { label: 'Violin' });
  await page.fill('#portalPasswordInput', 'dummy-pass');
  await page.click('#portalLoginBtn');
  await expect(page.locator('#memberPanel')).toBeVisible();
  return { setFail: () => { failSave = true; }, subscriptions: () => subscriptions };
}

async function openSettings(page) {
  await page.click('#portalDrawerToggle');
  await page.locator('#portalDrawerMenu').getByRole('button', { name: '通知設定', exact: true }).click();
  await expect(page.locator('#notificationSettingsTab')).toBeVisible();
  await expect(page.locator('#notificationSaveBtn')).toBeEnabled();
}

test('notification preferences persist, default ON and never subscribe automatically', async ({ page }) => {
  const controls = await prepare(page);
  await openSettings(page);
  await expect(page.locator('#notificationCategories input')).toHaveCount(7);
  await expect(page.locator('#notification-improvements')).toHaveCount(0);
  for (const key of Object.keys(categories).filter((key) => key !== 'improvements')) {
    await expect(page.locator(`#notification-${key}`)).toBeChecked();
  }
  await page.locator('#notification-schedules').uncheck();
  await page.click('#notificationSaveBtn');
  await expect(page.locator('#notificationStatus')).toHaveText('通知の種類を保存しました。');
  await page.click('#notificationBackBtn');
  await openSettings(page);
  await expect(page.locator('#notification-schedules')).not.toBeChecked();
  expect(controls.subscriptions()).toBe(0);
});

test('failed save is visible and does not change the saved preferences', async ({ page }) => {
  const controls = await prepare(page);
  await openSettings(page);
  controls.setFail();
  await page.locator('#notification-schedules').uncheck();
  await page.click('#notificationSaveBtn');
  await expect(page.locator('#notificationStatus')).toContainText('保存できませんでした');
  await page.click('#notificationBackBtn');
  await openSettings(page);
  await expect(page.locator('#notification-schedules')).toBeChecked();
});

test('system administrators see all eight notification categories', async ({ page }) => {
  await prepare(page, 'システム管理者');
  await openSettings(page);
  await expect(page.locator('#notificationCategories input')).toHaveCount(8);
  await expect(page.locator('#notification-improvements')).toBeChecked();
});

test('notification launch survives login and opens the existing schedule tab', async ({ page }) => {
  await prepare(page);
  await page.goto('/?notification=member-schedule');
  await expect(page.locator('#memberScheduleTab')).toBeVisible();
  await expect(page).not.toHaveURL(/notification=/);
});

async function mockBrowserPush(page, permission) {
  await page.addInitScript(({ permission }) => {
    window.pushTestPermissionRequests = 0;
    let sub = null;
    const notification = { permission, requestPermission: async () => {
      window.pushTestPermissionRequests++;
      notification.permission = 'granted';
      return 'granted';
    } };
    Object.defineProperty(window, 'Notification', { configurable: true, value: notification });
    const registration = { pushManager: {
      getSubscription: async () => sub,
      subscribe: async (options) => {
        sub = { options, unsubscribe: async () => { sub = null; return true; },
          toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/test', keys: { p256dh: 'test', auth: 'test' } }) };
        return sub;
      }
    } };
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: {
      register: async () => registration, ready: Promise.resolve(registration), getRegistration: async () => registration
    } });
  }, { permission });
}

test('permission is requested only on click and this device can be unsubscribed', async ({ page }) => {
  await mockBrowserPush(page, 'default');
  const publicKey = Buffer.from([4, ...Array(64).fill(1)]).toString('base64url');
  const controls = await prepare(page, '一般', { configured: true, publicKey });
  await openSettings(page);
  expect(await page.evaluate(() => window.pushTestPermissionRequests)).toBe(0);
  expect(controls.subscriptions()).toBe(0);
  await page.click('#notificationEnableBtn');
  await expect(page.locator('#notificationStatus')).toHaveText('この端末で通知を受信できます。');
  await expect(page.locator('#notificationEnableBtn')).toBeDisabled();
  expect(await page.evaluate(() => window.pushTestPermissionRequests)).toBe(1);
  await page.click('#notificationDisableBtn');
  await expect(page.locator('#notificationStatus')).toContainText('通知を受信していません');
  expect(controls.subscriptions()).toBe(2);
});

test('denied permission is displayed without prompting or registering subscriptions', async ({ page }) => {
  await mockBrowserPush(page, 'denied');
  const publicKey = Buffer.from([4, ...Array(64).fill(1)]).toString('base64url');
  const controls = await prepare(page, '一般', { configured: true, publicKey });
  await openSettings(page);
  await expect(page.locator('#notificationStatus')).toContainText('通知が拒否されています');
  await expect(page.locator('#notificationEnableBtn')).toBeDisabled();
  expect(await page.evaluate(() => window.pushTestPermissionRequests)).toBe(0);
  expect(controls.subscriptions()).toBe(0);
});
