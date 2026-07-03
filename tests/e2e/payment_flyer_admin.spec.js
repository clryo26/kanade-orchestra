const { test, expect } = require('@playwright/test');
const { installPortalApiMocks } = require('./fixtures/mockApi');

async function loginAsAdmin(page) {
  await page.fill('#portalNameInput', 'administrator');
  await page.fill('#portalPasswordInput', 'dummy-pass');
  await page.click('#portalLoginBtn');
}

test.describe('Payment and flyer admin', () => {
  test('shows unpaid-first payment summary and manages flyer master and plans', async ({ page }) => {
    await installPortalApiMocks(page, {
      permission: '管理者',
      bootstrapOverrides: {
        performances: [
          { id: 1, title: '第1回定期演奏会', date: '2026-08-20', pieces: [{ title: '交響曲第5番', composer: 'ベートーヴェン', alias: 'ベト5', duration: '35' }], flyer_image: '' },
          { id: 2, title: '第2回定期演奏会', date: '2026-11-10', pieces: [], flyer_image: '' },
        ],
        members: [
          { id: 1, name: '管理者テスト', last_name: '管理者', first_name: 'テスト', part: 'Violin', permission: '管理者', password_set: true },
          { id: 2, name: '一般テスト', last_name: '一般', first_name: 'テスト', part: 'Cello', permission: '一般', password_set: true },
        ],
        extras: {
          payments: [
            { id: 1, member_id: 1, name: '管理者テスト', paid_until_month: '2026-07', latest_payment_date: '2026-07-01', performance_fees: { '1': true, '2': false } },
            { id: 2, member_id: 2, name: '一般テスト', paid_until_month: '2026-05', latest_payment_date: '2026-06-10', performance_fees: { '1': false, '2': false } },
          ],
          flyer_places: [
            { id: 1, performance_id: '', performance_title: '', place_name: '天神文具', area: '天神', note: '受付横' },
            { id: 2, performance_id: '', performance_title: '', place_name: '天神文具', area: '天神', note: '重複検証用' },
            { id: 3, performance_id: '', performance_title: '', place_name: '博多書店', area: '博多', note: '' },
          ],
          flyer_distributions: [],
        },
      },
    });

    await page.goto('/');
    await loginAsAdmin(page);

    await expect(page.locator('#memberPanel')).toBeVisible();
    await page.click('#portalDrawerToggle');
    await page.locator('#portalDrawerMenu').getByRole('button', { name: '管理者メニュー' }).click();

    await page.locator('#adminPanel [data-tab="payment-admin"]').click();
    const paymentList = page.locator('#paymentAdminList');
    await expect(page.locator('#paymentAdminList .payment-admin-item')).toHaveCount(2);
    await expect(paymentList).toContainText('管理者テスト');
    await expect(paymentList).toContainText('一般テスト');
    await expect(paymentList).toContainText('未払い確認');
    await expect(paymentList).toContainText('残2ヶ月分');
    await expect(paymentList).toContainText('未払いなし');

    await page.locator('#adminPanel [data-tab="flyer-admin"]').click();
    const flyerList = page.locator('#flyerPlaceList');
    await expect(flyerList).toContainText('重複の可能性あり');
    await expect(page.locator('.flyer-place-duplicate-badge')).toHaveCount(2);

    await page.fill('#flyerPlaceName', '新規店舗');
    await page.fill('#flyerPlaceArea', '博多 / 博多区');
    await page.fill('#flyerPlaceNote', '追加分');
    await page.click('#saveFlyerPlaceBtn');
    await expect(flyerList).toContainText('新規店舗');

    await page.locator('#flyerPlaceList tbody tr').filter({ hasText: '天神文具' }).first().locator('.flyer-place-edit-btn').click();
    await expect(page.locator('#flyerPlaceName')).toHaveValue('天神文具');
    await page.fill('#flyerPlaceNote', '更新済み');
    await page.click('#saveFlyerPlaceBtn');
    await expect(flyerList).toContainText('更新済み');

    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('#flyerPlaceList tbody tr').filter({ hasText: '天神文具' }).first().locator('.flyer-place-delete-btn').click();
    await expect(page.locator('.flyer-place-duplicate-badge')).toHaveCount(0);
    await expect(flyerList).toContainText('博多書店');

    await page.click('#portalDrawerToggle');
    await page.locator('#portalDrawerMenu').getByRole('button', { name: 'チラシ配布' }).click();
    await expect(page.locator('#memberFlyerDistributionTab')).toBeVisible();
    await expect(page.locator('#flyerDistributionList tbody tr')).toHaveCount(3);

    await page.locator('#flyerDistributionPerformanceId').selectOption('1');
    const targetRow = page.locator('#flyerDistributionList tr[data-flyer-place-id="3"]');
    await targetRow.locator('[data-field="planned-member-id"]').selectOption('2');
    await targetRow.locator('[data-field="planned-date"]').fill('2026-08-01');
    await targetRow.locator('[data-field="executed-member-id"]').selectOption('1');
    await targetRow.locator('[data-field="executed-date"]').fill('2026-08-02');
    await targetRow.locator('.flyer-distribution-save-btn').click();

    await expect(targetRow.locator('[data-field="planned-member-id"]')).toHaveValue('2');
    await expect(targetRow.locator('[data-field="planned-date"]')).toHaveValue('2026-08-01');
    await expect(targetRow.locator('[data-field="executed-member-id"]')).toHaveValue('1');
    await expect(targetRow.locator('[data-field="executed-date"]')).toHaveValue('2026-08-02');
  });
});