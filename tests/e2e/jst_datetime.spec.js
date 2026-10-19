const { test, expect } = require('@playwright/test');
const { installPortalApiMocks } = require('./fixtures/mockApi');

for (const timezoneId of ['UTC', 'America/New_York']) {
  test.describe(`JST display on ${timezoneId}`, () => {
    test.use({ timezoneId });
    test('production helpers use Japan dates, times and search boundaries', async ({ page }) => {
      await installPortalApiMocks(page, { permission: '一般' });
      await page.goto('/');
      await page.waitForFunction(() => typeof formatDateTimeLabel === 'function');
      const result = await page.evaluate(() => ({
        label: formatDateTimeLabel('2026-10-18T16:00:00.123456Z'),
        start: portalJstDateBoundaryIso('2026-10-19'),
        before: portalJstDateBoundaryIso('2026-10-19', true),
        unknown: formatDateTimeLabel('2026-10-19T01:00:00'),
      }));
      expect(result).toEqual({ label: '2026/10/19（月） 01:00', start: '2026-10-19T00:00:00+09:00', before: '2026-10-20T00:00:00+09:00', unknown: '日時不明' });
    });
  });
}

test('file result lost before reload is recovered with no second upload', async ({ page }) => {
  await installPortalApiMocks(page, { permission: '一般' });
  await page.route('**/api/portal-file-actor', (route) => route.fulfill({ json: { scope: 'a'.repeat(64) } }));
  let operationId; let uploads = 0;
  await page.route('**/api/members', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    uploads += 1;
    operationId = route.request().headers()['idempotency-key'];
    await route.abort('connectionfailed');
  });
  await page.route('**/api/portal-file-operations/*', async (route) => {
    expect(route.request().url()).toContain(operationId);
    await route.fulfill({ status: 200, json: { state: 'succeeded', result_status: 200, result_body: { id: 123, name: 'saved' } } });
  });
  const submit = () => page.evaluate(async () => {
    const body = new FormData();
    body.append('name', 'saved'); body.append('photo_file', new Blob(['image'], { type: 'image/png' }), 'photo.png');
    try { return await portalFileRequest('/api/members', { method: 'POST', body }); }
    catch (error) { return { error: error.message }; }
  });
  await page.goto('/');
  await page.fill('#portalNameInput', '団員テスト');
  await page.selectOption('#portalPartInput', { label: 'Violin' });
  await page.fill('#portalPasswordInput', 'dummy-pass');
  await page.click('#portalLoginBtn');
  await expect(page.locator('#memberPanel')).toBeVisible();
  expect(await submit()).toHaveProperty('error');
  expect(operationId).toMatch(/^[a-f0-9-]{36}$/);
  await expect(page.locator('#portalFileOperationStatus')).toBeVisible();
  await page.reload();
  await expect(page.locator('#memberPanel')).toBeVisible();
  await expect(page.locator('#portalFileOperationStatus button')).toBeVisible();
  await page.locator('#portalFileOperationStatus button').click();
  await expect(page.locator('#portalFileOperationStatus')).toContainText('処理は完了しました');
  expect(await submit()).toEqual({ id: 123, name: 'saved' });
  expect(uploads).toBe(1);
});
