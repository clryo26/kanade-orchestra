const { test, expect } = require('@playwright/test');
const { installPortalApiMocks } = require('./fixtures/mockApi');
const { BOOTSTRAP_DATA } = require('./fixtures/mockData');

test('practice schedules and SNS display without either collection in bootstrap', async ({ page }) => {
  await installPortalApiMocks(page, { permission: '一般' });
  const bootstrap = JSON.parse(JSON.stringify(BOOTSTRAP_DATA));
  delete bootstrap.schedules;
  delete bootstrap.extras.sns_settings;
  // Keep every bootstrap route free of the data so a background full response
  // cannot accidentally make the on-demand navigation test pass.
  const bootstrapPaths = new Set(['/api/bootstrap-lite', '/api/bootstrap-core', '/api/bootstrap']);
  await page.route(url => bootstrapPaths.has(url.pathname), route => route.fulfill({ json: bootstrap }));
  const schedules = [{ id: 901, date: '2099-09-12', start_time: '13:00', end_time: '16:30',
    venue: '遅延読込テスト会場', notes: '画面表示用の練習' }];
  let scheduleRequests = 0;
  let snsRequests = 0;
  await page.route(url => url.pathname === '/api/schedules', route => {
    scheduleRequests += 1;
    return route.fulfill({ json: schedules });
  });
  await page.route(url => url.pathname === '/api/extra/sns_settings', route => {
    snsRequests += 1;
    return route.fulfill({ json: [{ id: 902, facebook_url: 'https://example.com/deferred-facebook',
      instagram_url: 'https://example.com/deferred-instagram', x_url: 'https://example.com/deferred-x' }] });
  });

  await page.goto('/');
  await expect(page.locator('#portalLoginBtn')).toBeVisible();
  expect(snsRequests).toBe(0);
  await page.fill('#portalNameInput', '団員テスト');
  await page.selectOption('#portalPartInput', { label: 'Violin' });
  await page.fill('#portalPasswordInput', 'dummy-pass');
  await page.click('#portalLoginBtn');
  await expect(page.locator('#memberPanel')).toBeVisible();
  expect(snsRequests).toBe(0);

  await page.click('#portalDrawerToggle');
  await page.locator('#portalDrawerMenu [data-home-tab="member-schedule"]').click();
  await expect(page.locator('#memberSchedInfo')).toContainText('遅延読込テスト会場');
  await expect(page.locator('#memberSchedInfo [data-attendance-form]')).toHaveCount(1);
  // Startup attendance reminders may already have fetched schedules after paint.
  expect(scheduleRequests).toBeGreaterThanOrEqual(1);

  await page.click('#portalDrawerToggle');
  await page.locator('#portalDrawerMenu [data-home-tab="member-sns"]').click();
  await expect(page.locator('#memberSnsInfo').getByRole('link', { name: 'Facebook', exact: true }))
    .toHaveAttribute('href', 'https://example.com/deferred-facebook');
  await expect(page.locator('#memberSnsInfo').getByRole('link', { name: 'Instagram', exact: true }))
    .toHaveAttribute('href', 'https://example.com/deferred-instagram');
  await expect(page.locator('#memberSnsInfo').getByRole('link', { name: 'X', exact: true }))
    .toHaveAttribute('href', 'https://example.com/deferred-x');
  expect(snsRequests).toBe(1);
  await page.click('#portalDrawerToggle');
  await page.locator('#portalDrawerMenu [data-home-tab="member-schedule"]').click();
  await page.click('#portalDrawerToggle');
  await page.locator('#portalDrawerMenu [data-home-tab="member-sns"]').click();
  await expect(page.locator('#memberSnsInfo')).toBeVisible();
  expect(snsRequests).toBe(1);
});
