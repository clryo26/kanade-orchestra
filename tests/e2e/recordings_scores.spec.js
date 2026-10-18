const { test, expect } = require('@playwright/test');
const { installPortalApiMocks } = require('./fixtures/mockApi');
const { attachErrorMonitor } = require('./fixtures/errorMonitor');

async function loginAsMember(page) {
  await page.fill('#portalNameInput', '団員テスト');
  await page.selectOption('#portalPartInput', { label: 'Violin' });
  await page.fill('#portalPasswordInput', 'dummy-pass');
  await page.click('#portalLoginBtn');
}

test.describe('Recordings and scores smoke', () => {
  test('a member opens a sheet directly and renders a page without visiting casting', async ({ page }) => {
    const monitor = attachErrorMonitor(page);
    const sheet = { id: 1, name: 'Direct.pdf', piece: 'Piece', part: 'Violin', performance_id: 1,
      view_url: '/api/sheets/view/direct.pdf' };
    await installPortalApiMocks(page, { bootstrapOverrides: { sheets: { files: [sheet] } } });
    await page.route('**/api/sheets', (route) => route.fulfill({ json: { files: [sheet] } }));
    // Keep this navigation/render integration independent of the external CDN.
    // PDF parsing itself is the library's responsibility; draw a real canvas.
    await page.addInitScript(() => {
      window.pdfjsLib = {
        getDocument: () => ({ promise: Promise.resolve({ numPages: 1, getPage: async () => ({
          getViewport: ({ scale }) => ({ width: 600 * scale, height: 800 * scale }),
          render: ({ canvasContext }) => {
            canvasContext.fillRect(0, 0, 20, 20);
            return { promise: Promise.resolve() };
          }
        }) }) })
      };
    });
    await page.goto('/');
    await loginAsMember(page);
    await page.click('#portalDrawerToggle');
    await page.locator('#portalDrawerMenu').getByRole('button', { name: '楽譜ライブラリ' }).click();
    await page.locator('.sheet-piece-details summary').click();
    const pdfRequest = page.waitForRequest('**/api/sheets/view/direct.pdf');
    await page.locator('[data-sheet-view="1"]').click();
    await pdfRequest;
    await expect(page.locator('#sheetViewerPages canvas')).toHaveCount(1);
    await expect(page.locator('#sheetViewerStatus')).toHaveText('1ページ');
    await page.locator('#sheetViewerZoomIn').click();
    await expect(page.locator('#sheetViewerStatus')).toHaveText('1ページ');
    await page.locator('#sheetViewerBackBtn').click();
    await expect(page.locator('#memberSheetTab')).toBeVisible();
    monitor.assertNoClientErrors();
  });

  test('recording and score pages open with empty data without crashing', async ({ page }) => {
    const monitor = attachErrorMonitor(page);
    await installPortalApiMocks(page, {
      permission: '一般',
      bootstrapOverrides: {
        recordings: { files: [] },
        sheets: { files: [] },
      },
    });

    await page.goto('/');
    await loginAsMember(page);

    await page.click('#portalDrawerToggle');
    const drawer = page.locator('#portalDrawerMenu');

    await drawer.getByRole('button', { name: '録音部屋' }).click();
    await expect(page.locator('#memberRecordingTab')).toBeVisible();

    await page.click('#portalDrawerToggle');
    await drawer.getByRole('button', { name: '楽譜ライブラリ' }).click();
    await expect(page.locator('#memberSheetTab')).toBeVisible();

    monitor.assertNoClientErrors();
  });
});
