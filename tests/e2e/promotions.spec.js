const { test, expect } = require('@playwright/test');
const { installPortalApiMocks } = require('./fixtures/mockApi');
const { attachErrorMonitor } = require('./fixtures/errorMonitor');

for (const withImage of [false, true]) {
  test(`member creates and edits a promotion (${withImage ? 'with image' : 'text only'})`, async ({ page }) => {
    const monitor = attachErrorMonitor(page);
    await installPortalApiMocks(page);
    let items = [];
    const writes = [];
    await page.route('**/api/extra/promotions**', async (route) => {
      const request = route.request();
      if (request.method() === 'GET') return route.fulfill({ json: items });
      writes.push({ headers: request.headers(), body: request.postDataBuffer().toString() });
      items = [{ id: 42, title: request.method() === 'POST' ? 'My concert' : 'Updated concert',
        summary: 'Description', member_id: 1, registered_by: '団員テスト', revision: writes.length,
        image_url: '', created_at: '2026-10-18T00:00:00Z' }];
      return route.fulfill({ json: items[0] });
    });
    await page.goto('/');
    await page.fill('#portalNameInput', '団員テスト');
    await page.selectOption('#portalPartInput', { label: 'Violin' });
    await page.fill('#portalPasswordInput', 'dummy-pass');
    await page.click('#portalLoginBtn');
    await page.click('#portalDrawerToggle');
    await page.locator('#portalDrawerMenu').getByRole('button', { name: '宣伝', exact: true }).click();
    await page.fill('#promotionTitle', 'My concert');
    await page.fill('#promotionSummary', 'Description');
    if (withImage) await page.locator('#promotionImageFile').setInputFiles({
      name: 'flyer.png', mimeType: 'image/png', buffer: Buffer.from('89504e470d0a1a0a', 'hex')
    });
    await page.click('#promotionSaveBtn');
    await expect(page.locator('#memberPromotionInfo h5')).toHaveText('My concert');
    expect(writes[0].headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(writes[0].body).toContain('name="image_action"');
    if (withImage) expect(writes[0].body).toContain('name="image_url_file"');
    await page.locator('.promotion-edit-btn').click();
    await page.fill('#promotionTitle', 'Updated concert');
    await page.click('#promotionSaveBtn');
    await expect(page.locator('#memberPromotionInfo h5')).toHaveText('Updated concert');
    expect(writes[1].body).toContain('name="expected_revision"');
    expect(writes[1].headers['idempotency-key']).not.toBe(writes[0].headers['idempotency-key']);
    monitor.assertNoClientErrors();
  });
}
