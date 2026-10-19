// DL / 一括DL on a PC browser and on a smartphone, for sheets and recordings
// (scores/save_dialog.js, recordings_feature.js). Headless Chromium with the
// device forced through window.portalSaveDeviceMode; the server is mocked.
// A real iPhone (share sheet, Files app, home-screen app) is NOT covered here.
const { test, expect } = require('@playwright/test');
const { installPortalApiMocks } = require('./fixtures/mockApi');
const { attachErrorMonitor } = require('./fixtures/errorMonitor');

const PDF = Buffer.from('%PDF-1.4\n%%EOF\n', 'latin1');
const ZIP = Buffer.from('PK\x05\x06' + '\0'.repeat(18), 'latin1');
const AUDIO = Buffer.from('ID3' + '\0'.repeat(61), 'latin1');

const SHEET = {
  id: 1, name: 'Two.pdf', piece: 'Sym', part: 'Violin', performance_id: 1, performance_title: 'Concert', revision: 1, size: PDF.length,
  url: '/api/sheets/view/s1.pdf', view_url: '/api/sheets/view/s1.pdf', download_url: '/api/sheets/download/s1.pdf',
};
const RECORDING = {
  id: 'rec-1', name: 'take1.mp3', date: '2026-07-15', piece: 'Sym', source: 'local', size: AUDIO.length,
  path: 'converted/2026-07-15/Sym/take1.mp3',
  play_url: '/api/recordings/play/converted/2026-07-15/Sym/take1.mp3',
  download_url: '/api/recordings/download/converted/2026-07-15/Sym/take1.mp3',
  duration: '00:03',
};

async function loginAsMember(page) {
  await page.fill('#portalNameInput', '団員テスト');
  await page.selectOption('#portalPartInput', { label: 'Violin' });
  await page.fill('#portalPasswordInput', 'dummy-pass');
  await page.click('#portalLoginBtn');
}

const attachment = (contentType, body, name) => ({
  status: 200, contentType, body, headers: { 'Content-Disposition': `attachment; filename="${name}"`, 'Content-Length': String(body.length) },
});

async function prepare(page, mode, options = {}) {
  const monitor = attachErrorMonitor(page);
  // The PC's "ダウンロードしますか？" (as before the save dialog): accepted and counted.
  const confirms = [];
  page.on('dialog', (dialog) => { confirms.push(dialog.message()); dialog.accept(); });
  await page.addInitScript((m) => {
    window.portalSaveDeviceMode = m;
    window.__shared = [];
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
    Object.defineProperty(navigator, 'share', { configurable: true, value: async (data) => { window.__shared.push(data.files.map((f) => ({ name: f.name, type: f.type, size: f.size }))); } });
  }, mode);
  await installPortalApiMocks(page, { bootstrapOverrides: { sheets: { files: [SHEET] }, recordings: { files: [RECORDING] } } });
  const requests = [];
  await page.route('**/api/sheets**', async (route) => {
    const url = new URL(route.request().url());
    requests.push(`${route.request().method()} ${url.pathname}`);
    if (url.pathname === '/api/sheets/version') return route.fulfill({ json: { list_version: 1, release: 'test-revision' } });
    if (url.pathname === '/api/sheets') return route.fulfill({ json: { files: [SHEET], list_version: 1 } });
    if (url.pathname === '/api/sheets/tickets') {
      const kind = route.request().postDataJSON().kind;
      return route.fulfill({ json: { url: `/api/sheets/tickets/${kind}-ticket`, expires_at: new Date(Date.now() + 600000).toISOString() } });
    }
    if (url.pathname === '/api/sheets/tickets/file-ticket') return route.fulfill(attachment('application/pdf', PDF, 'Two.pdf'));
    if (url.pathname === '/api/sheets/tickets/zip-ticket') return route.fulfill(attachment('application/zip', ZIP, 'Concert.zip'));
    if (url.pathname.startsWith('/api/sheets/zip-jobs')) {
      return route.fulfill({ json: { job_id: '11111111-1111-4111-8111-111111111111', state: 'ready', title: 'Concert', file_count: 1, done_count: 1,
        total_bytes: 3 * 1024 * 1024, written_bytes: 0, allow_partial: false, missing: [], zip_bytes: 3 * 1024 * 1024, list_version: 1, changed_since: false } });
    }
    return route.fallback();
  });
  await page.route('**/api/recordings**', async (route) => {
    const url = new URL(route.request().url());
    requests.push(`${route.request().method()} ${url.pathname}`);
    if (url.pathname === '/api/recordings') return route.fulfill({ json: { files: [RECORDING] } });
    if (url.pathname === '/api/recordings/download-zip/info') {
      return route.fulfill({ json: { file_count: 1, missing_count: 0, total_bytes: options.recordingZipBytes || 12 * 1024 * 1024 } });
    }
    if (url.pathname === '/api/recordings/download-zip') return route.fulfill(attachment('application/zip', ZIP, 'recordings.zip'));
    if (url.pathname.startsWith('/api/recordings/download/')) return route.fulfill(attachment('audio/mpeg', AUDIO, 'take1.mp3'));
    return route.fallback();
  });
  await page.goto('/');
  await loginAsMember(page);
  return { monitor, requests, confirms };
}

async function openMenu(page, name, tabId) {
  await page.click('#portalDrawerToggle');
  await page.locator('#portalDrawerMenu').getByRole('button', { name }).click();
  await expect(page.locator(tabId)).toBeVisible();
}

test.describe('PC browser: the browser downloads the file', () => {
  test('sheet DL downloads at once (no dialog, no new tab); 一括DL shows the size and downloads by itself', async ({ page }) => {
    const { monitor, confirms } = await prepare(page, 'desktop');
    await openMenu(page, '楽譜ライブラリ', '#memberSheetTab');
    const before = page.url();
    const pages = page.context().pages().length;
    await page.locator('details[data-sheet-key="p:1:Sym"] summary').click();
    const single = page.waitForEvent('download');
    await page.locator('[data-sheet-save="1"]').click();
    expect((await single).url()).toContain('/api/sheets/tickets/file-ticket');
    expect(confirms).toEqual(['ダウンロードしますか？']); // as before the save dialog, once
    await expect(page.locator('#sheetSaveDialog')).toHaveCount(0);
    expect(page.context().pages()).toHaveLength(pages);

    const zip = page.waitForEvent('download');
    await page.locator('details[data-sheet-key="p:1:Sym"] [data-sheet-zip]').click();
    expect((await zip).url()).toContain('/api/sheets/tickets/zip-ticket');
    await expect(page.locator('#sheetSaveCount')).toHaveText('1 件の楽譜・ZIP 3.0 MB');
    await expect(page.locator('#sheetSaveStatus')).toContainText('ダウンロードを開始しました');
    await expect(page.locator('#sheetSaveShare')).toBeHidden();
    await page.locator('#sheetSaveClose').click();
    expect(confirms).toHaveLength(1); // the ZIP dialog showed the size instead
    expect(page.url()).toBe(before);
    expect(page.context().pages()).toHaveLength(pages);
    expect(await page.evaluate(() => window.__shared)).toEqual([]);
    monitor.assertNoClientErrors();
  });

  test('recording DL is the browser download; 一括DL shows the size first, then downloads', async ({ page }) => {
    const { monitor, requests, confirms } = await prepare(page, 'desktop');
    await openMenu(page, '録音部屋', '#memberRecordingTab');
    await page.locator('.recording-piece-summary').first().click();
    const single = page.waitForEvent('download');
    await page.locator('.recording-download-btn').first().click();
    expect((await single).url()).toContain('/api/recordings/download/');
    expect(confirms).toEqual(['ダウンロードしますか？']);
    await expect(page.locator('#sheetSaveDialog')).toHaveCount(0);

    const zip = page.waitForEvent('download');
    await page.locator('.recording-date-summary .recording-bulk-download-btn').click();
    expect((await zip).url()).toContain('/api/recordings/download-zip?date=2026-07-15');
    await expect(page.locator('#sheetSaveCount')).toHaveText('1 件の録音・ZIP 約 12.0 MB');
    expect(requests.indexOf('GET /api/recordings/download-zip/info')).toBeGreaterThanOrEqual(0);
    expect(confirms).toHaveLength(1);
    monitor.assertNoClientErrors();
  });
});

test.describe('smartphone: the save dialog', () => {
  test('recording DL opens the dialog and the share sheet with an audio file', async ({ page }) => {
    const { monitor, confirms } = await prepare(page, 'mobile');
    await openMenu(page, '録音部屋', '#memberRecordingTab');
    const before = page.url();
    await page.locator('.recording-piece-summary').first().click();
    await page.locator('.recording-download-btn').first().click();
    await expect(page.locator('#sheetSaveTitle')).toHaveText('録音を保存');
    await expect(page.locator('#sheetSaveShare')).toBeVisible();
    await page.locator('#sheetSaveShare').click();
    await expect(page.locator('#sheetSaveStatus')).toContainText('共有画面を閉じました');
    expect(await page.evaluate(() => window.__shared)).toEqual([[{ name: 'take1.mp3', type: 'audio/mpeg', size: AUDIO.length }]]);
    expect(confirms).toEqual([]); // the dialog is the confirmation
    expect(page.url()).toBe(before);
    monitor.assertNoClientErrors();
  });

  test('recording 一括DL shows the size; it opens in a separate screen only from the tap', async ({ page }) => {
    const { monitor, requests } = await prepare(page, 'mobile');
    await openMenu(page, '録音部屋', '#memberRecordingTab');
    const before = page.url();
    await page.locator('.recording-piece-summary .recording-bulk-download-btn').first().click();
    await expect(page.locator('#sheetSaveTitle')).toHaveText('録音のZIPを保存');
    await expect(page.locator('#sheetSaveCount')).toHaveText('1 件の録音・ZIP 約 12.0 MB');
    await expect(page.locator('#sheetSaveOpen')).toHaveText('別の画面で開いて保存');
    expect(requests.filter((r) => r === 'GET /api/recordings/download-zip')).toEqual([]);
    // A separate tab (or its download): the portal page is not replaced.
    const outcome = Promise.race([
      page.waitForEvent('download').then((d) => d.url()),
      page.context().waitForEvent('page').then(async (popup) => {
        await popup.waitForLoadState('commit').catch(() => {});
        return popup.url();
      }),
    ]);
    await page.locator('#sheetSaveOpen').click();
    expect(await outcome).toContain('/api/recordings/download-zip?date=2026-07-15&piece=Sym');
    expect(page.url()).toBe(before);
    monitor.assertNoClientErrors();
  });
});
