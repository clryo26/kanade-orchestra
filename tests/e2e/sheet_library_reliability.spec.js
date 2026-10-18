// Sheet library in a real browser (headless Chromium) with the real vendored
// PDF.js and real PDF files. The server API is mocked here except for the
// last test; DB/GCS behaviour is covered by tests/backend. An iPhone (Safari,
// home-screen app, share sheet, Files app) is NOT covered by this file.
const { test, expect } = require('@playwright/test');
const { installPortalApiMocks } = require('./fixtures/mockApi');
const { attachErrorMonitor } = require('./fixtures/errorMonitor');
const path = require('node:path');
const PDFJS_VERSION = '4.10.38';
const PDFJS_LOCAL = `/static/vendor/pdfjs/${PDFJS_VERSION}/`;
const PDFJS_CDN = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/legacy/build/`;

// A valid PDF with `pages` pages (one filled rectangle each), with a correct
// cross-reference table.
function makePdf(pages) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>'];
  const kids = [];
  const pageObjects = [];
  for (let i = 0; i < pages; i += 1) {
    const pageNo = 3 + i * 2;
    kids.push(`${pageNo} 0 R`);
    const stream = `0.2 0.4 0.8 rg ${20 + i * 10} 20 100 140 re f`;
    pageObjects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Contents ${pageNo + 1} 0 R >>`);
    pageObjects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  objects.push(`<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages} >>`);
  objects.push(...pageObjects);
  let body = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((obj, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((offset) => { body += `${String(offset).padStart(10, '0')} 00000 n \n`; });
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

const PDF_TWO = makePdf(2);
const PDF_THREE = makePdf(3);

function sheet(id, name, piece, extra = {}) {
  return {
    id, name, piece, part: 'Violin', performance_id: 1, performance_title: 'Concert', revision: 1,
    size: (id === 1 ? PDF_TWO : PDF_THREE).length,
    url: `/api/sheets/view/s${id}.pdf`, view_url: `/api/sheets/view/s${id}.pdf`, download_url: `/api/sheets/download/s${id}.pdf`,
    ...extra,
  };
}

async function loginAsMember(page) {
  await page.fill('#portalNameInput', '団員テスト');
  await page.selectOption('#portalPartInput', { label: 'Violin' });
  await page.fill('#portalPasswordInput', 'dummy-pass');
  await page.click('#portalLoginBtn');
}

// Server state for the library, changed by the tests.
function library(page, initial) {
  const server = { version: 1, files: initial, failList: false, requests: [] };
  return {
    server,
    install: async () => {
      await page.route('**/api/sheets**', async (route) => {
        const url = new URL(route.request().url());
        server.requests.push(`${route.request().method()} ${url.pathname}`);
        if (url.pathname === '/api/sheets/version') {
          return route.fulfill({ json: { list_version: server.version, release: 'test-revision' } });
        }
        if (url.pathname === '/api/sheets') {
          if (server.failList) return route.fulfill({ status: 503, json: { detail: { code: 'sheet_unavailable', message: '一時的に取得できません' } } });
          return route.fulfill({ json: { files: server.files, list_version: server.version } });
        }
        const match = url.pathname.match(/^\/api\/sheets\/(view|download)\/s(\d+)\.pdf$/);
        if (match) {
          if (server.delay && server.delay[match[2]]) await new Promise((r) => setTimeout(r, server.delay[match[2]]));
          const body = match[2] === '1' ? PDF_TWO : PDF_THREE;
          return route.fulfill({ status: 200, contentType: 'application/pdf', body, headers: { 'Content-Length': String(body.length) } });
        }
        return route.fallback();
      });
    },
  };
}

async function openLibrary(page) {
  await page.click('#portalDrawerToggle');
  await page.locator('#portalDrawerMenu').getByRole('button', { name: '楽譜ライブラリ' }).click();
  await expect(page.locator('#memberSheetTab')).toBeVisible();
}

async function prepare(page, files, options = {}) {
  const monitor = attachErrorMonitor(page);
  await installPortalApiMocks(page, { bootstrapOverrides: { sheets: { files } } });
  const lib = library(page, files);
  await lib.install();
  if (options.blockCdn !== false) {
    await page.route('https://cdnjs.cloudflare.com/**', (route) => route.abort());
    await page.route(`${PDFJS_CDN}**`, (route) => route.abort());
  }
  await page.goto('/');
  await loginAsMember(page);
  await openLibrary(page);
  return { monitor, lib };
}

test.describe('sheet library reliability (Chromium)', () => {
  test('real PDF.js from the portal renders real PDFs, zooms, switches and releases them', async ({ page }) => {
    const { monitor, lib } = await prepare(page, [sheet(1, 'Two.pdf', 'Sym'), sheet(2, 'Three.pdf', 'Ov')]);
    await page.locator('details[data-sheet-key="p:1:Sym"] summary').click();
    await page.locator('[data-sheet-view="1"]').click();
    await expect(page.locator('#sheetViewerPages canvas')).toHaveCount(2);
    await expect(page.locator('#sheetViewerStatus')).toHaveText('2ページ');
    const loaded = await page.evaluate(async () => {
      const lib = await window.loadPdfJs();
      return { source: window.portalPdfViewer.loadedFrom(), version: lib.version, worker: lib.GlobalWorkerOptions.workerSrc };
    });
    expect(loaded).toEqual({ source: PDFJS_LOCAL, version: PDFJS_VERSION, worker: `${PDFJS_LOCAL}pdf.worker.min.mjs` });
    const width = await page.locator('#sheetViewerPages canvas').first().evaluate((c) => c.width);
    await page.locator('#sheetViewerZoomIn').click();
    await expect(page.locator('#sheetViewerStatus')).toHaveText('2ページ');
    expect(await page.locator('#sheetViewerPages canvas').first().evaluate((c) => c.width)).toBeGreaterThan(width);
    // Fast switching: the slow first request never draws over the second.
    lib.server.delay = { 1: 1500 };
    await page.evaluate(() => {
      window.renderPdfViewer('/api/sheets/view/s1.pdf');
      window.renderPdfViewer('/api/sheets/view/s2.pdf');
    });
    await expect(page.locator('#sheetViewerStatus')).toHaveText('3ページ');
    await page.waitForTimeout(1800);
    await expect(page.locator('#sheetViewerPages canvas')).toHaveCount(3);
    // Leaving releases everything.
    await page.locator('#sheetViewerBackBtn').click();
    await expect(page.locator('#memberSheetTab')).toBeVisible();
    expect(await page.evaluate(() => window.portalPdfViewer.current())).toBeNull();
    await expect(page.locator('#sheetViewerPages canvas')).toHaveCount(0);
    monitor.assertNoClientErrors();
  });

  test('fallback uses the same real module and worker when the portal copy is unavailable', async ({ page }) => {
    // Serve the published, vendored bytes at the fallback URL to keep this
    // browser test deterministic and independent of public CDN availability.
    await page.route(`**${PDFJS_LOCAL}**`, (route) => route.abort());
    const requested = [];
    await page.context().route(`${PDFJS_CDN}**`, (route) => {
      const name = new URL(route.request().url()).pathname.split('/').pop();
      requested.push(name);
      return route.fulfill({ path: path.resolve(__dirname, '../../src/static/vendor/pdfjs', PDFJS_VERSION, name),
        contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' } });
    });
    // Expected local module failure is a browser console message; uncaught
    // page exceptions must still be absent.
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await prepare(page, [sheet(1, 'Two.pdf', 'Sym')], { blockCdn: false });
    await page.locator('details[data-sheet-key="p:1:Sym"] summary').click();
    await page.locator('[data-sheet-view="1"]').click();
    await expect(page.locator('#sheetViewerPages canvas')).toHaveCount(2);
    await expect(page.locator('#sheetViewerStatus')).toHaveText('2ページ');
    expect(await page.evaluate(() => window.portalPdfViewer.loadedFrom())).toBe(PDFJS_CDN);
    expect(requested).toContain('pdf.min.mjs');
    expect(requested).toContain('pdf.worker.min.mjs');
    expect(errors).toEqual([]);
  });

  test('a broken PDF and a missing PDF are reported apart and can be retried', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    const { lib } = await prepare(page, [sheet(1, 'Two.pdf', 'Sym')]);
    let broken = true;
    await page.route('**/api/sheets/view/s1.pdf', (route) => (broken
      ? route.fulfill({ status: 200, contentType: 'application/pdf', body: Buffer.from('%PDF-1.4 garbage') })
      : route.fulfill({ status: 200, contentType: 'application/pdf', body: PDF_TWO })));
    await page.locator('details[data-sheet-key="p:1:Sym"] summary').click();
    await page.locator('[data-sheet-view="1"]').click();
    await expect(page.locator('#sheetViewerStatus')).toContainText('PDFファイルが壊れているか');
    broken = false;
    await page.locator('#sheetViewerRetry').click();
    await expect(page.locator('#sheetViewerStatus')).toHaveText('2ページ');
    await page.route('**/api/sheets/view/s1.pdf', (route) => route.fulfill({ status: 404, json: { detail: 'File not found' } }));
    await page.evaluate(() => { window.clearSheetViewer(); window.renderPdfViewer('/api/sheets/view/s1.pdf'); });
    await expect(page.locator('#sheetViewerStatus')).toContainText('楽譜が見つかりません');
    expect(lib.server.requests.length).toBeGreaterThan(0);
    // The 404 and the broken PDF are logged by the browser on purpose here;
    // only uncaught page exceptions would be a defect.
    expect(pageErrors).toEqual([]);
  });

  test('a sheet registered elsewhere appears within about 5 s; filters and open sections stay; 更新 waits; failures keep the list', async ({ page }) => {
    test.setTimeout(60000);
    const { lib } = await prepare(page, [sheet(1, 'Two.pdf', 'Sym')]);
    await page.selectOption('#memberSheetPartFilter', 'Violin');
    await page.locator('details[data-sheet-key="p:1:Sym"] summary').click();
    lib.server.version = 2;
    lib.server.files = [sheet(1, 'Two.pdf', 'Sym'), sheet(2, 'New.pdf', 'Sym')];
    await expect(page.locator('[data-sheet-view="2"]')).toBeVisible({ timeout: 8000 });
    await expect(page.locator('#memberSheetPartFilter')).toHaveValue('Violin');
    await expect(page.locator('details[data-sheet-key="p:1:Sym"]')).toHaveAttribute('open', '');
    // 更新 with a failing server: the shown list stays, the failure is visible.
    lib.server.failList = true;
    await page.locator('#memberSheetSync .sheet-sync-refresh').click();
    await expect(page.locator('#memberSheetSync')).toContainText('一覧を更新できませんでした');
    await expect(page.locator('#memberSheetSync .sheet-sync-retry')).toBeVisible();
    await expect(page.locator('[data-sheet-view="2"]')).toBeVisible();
    lib.server.failList = false;
    lib.server.files = [sheet(2, 'New.pdf', 'Sym')];
    lib.server.version = 3;
    await page.locator('#memberSheetSync .sheet-sync-retry').click();
    await expect(page.locator('#memberSheetSync')).toContainText('最終確認');
    await expect(page.locator('[data-sheet-view="1"]')).toHaveCount(0);
    // Leaving the library stops the checks.
    await page.evaluate(() => window.showMemberTab('member-home'));
    await expect(page.locator('#memberSheetTab')).toBeHidden();
    const before = lib.server.requests.length;
    await page.waitForTimeout(6500);
    expect(lib.server.requests.length).toBe(before);
  });

  test('DL of a PDF opens the save dialog over the list; the share sheet is opened from the tap; nothing claims it was saved', async ({ page }) => {
    await page.addInitScript(() => {
      window.__shared = [];
      Object.defineProperty(navigator, 'canShare', { configurable: true, value: (data) => data.files.every((f) => f.type === 'application/pdf') });
      Object.defineProperty(navigator, 'share', { configurable: true, value: async (data) => { window.__shared.push(data.files.map((f) => ({ name: f.name, type: f.type, size: f.size }))); } });
    });
    const { monitor } = await prepare(page, [sheet(1, 'Two.pdf', 'Sym')]);
    const before = page.url();
    await page.locator('details[data-sheet-key="p:1:Sym"] summary').click();
    await page.locator('[data-sheet-save="1"]').click();
    await expect(page.locator('#sheetSaveDialog')).toBeVisible();
    await expect(page.locator('#sheetSaveTarget')).toHaveText('Two.pdf');
    await expect(page.locator('#sheetSaveShare')).toBeVisible();
    await page.locator('#sheetSaveShare').click();
    await expect(page.locator('#sheetSaveStatus')).toContainText('共有画面を閉じました');
    await expect(page.locator('#sheetSaveStatus')).not.toContainText('保存しました');
    expect(await page.evaluate(() => window.__shared)).toEqual([[{ name: 'Two.pdf', type: 'application/pdf', size: PDF_TWO.length }]]);
    await page.locator('#sheetSaveClose').click();
    await expect(page.locator('#sheetSaveDialog')).toBeHidden();
    await expect(page.locator('[data-sheet-view="1"]')).toBeVisible();
    expect(page.url()).toBe(before);
    monitor.assertNoClientErrors();
  });

  test('ZIP: built in steps with progress; sharing not possible for ZIP -> ticket link outside the portal', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'canShare', { configurable: true, value: (data) => data.files.every((f) => f.type === 'application/pdf') });
      Object.defineProperty(navigator, 'share', { configurable: true, value: async () => {} });
    });
    const { monitor } = await prepare(page, [sheet(1, 'Two.pdf', 'Sym'), sheet(2, 'Three.pdf', 'Sym')]);
    const bodies = [];
    let steps = 0;
    const job = (state, done, extra = {}) => ({ job_id: '11111111-1111-4111-8111-111111111111', state, title: 'Concert', file_count: 2,
      done_count: done, total_bytes: 900, written_bytes: 0, allow_partial: false, missing: [], zip_bytes: 1000, list_version: 1, changed_since: false, ...extra });
    await page.route('**/api/sheets/zip-jobs**', async (route) => {
      const url = new URL(route.request().url());
      if (route.request().method() === 'POST' && url.pathname === '/api/sheets/zip-jobs') {
        bodies.push(route.request().postDataJSON());
        return route.fulfill({ json: job('building', 0) });
      }
      if (url.pathname.endsWith('/step')) {
        steps += 1;
        await new Promise((r) => setTimeout(r, 300));
        return route.fulfill({ json: steps === 1 ? job('building', 1) : job('ready', 2) });
      }
      return route.fulfill({ json: job('ready', 2) });
    });
    await page.route('**/api/sheets/tickets', (route) => route.fulfill({ json: { url: '/api/sheets/tickets/ticket-abc', expires_at: new Date(Date.now() + 600000).toISOString() } }));
    await page.route('**/api/sheets/tickets/ticket-abc', (route) => route.fulfill({ status: 200, contentType: 'application/zip', body: Buffer.from('PK\x05\x06' + '\0'.repeat(18), 'latin1'),
      headers: { 'Content-Disposition': 'attachment; filename="sheets.zip"' } }));
    const before = page.url();
    await page.locator('details[data-sheet-key="p:1:Sym"] summary').click();
    await page.locator('details[data-sheet-key="p:1:Sym"] [data-sheet-zip]').click();
    await expect(page.locator('#sheetSaveDialog')).toBeVisible();
    await expect(page.locator('#sheetSaveStatus')).toContainText('ZIPを作成しています');
    await expect(page.locator('#sheetSaveCount')).toContainText('2 件');
    await expect(page.locator('#sheetSaveOpen')).toBeVisible({ timeout: 10000 });
    expect(bodies[0]).toMatchObject({ performance_id: '1', piece: 'Sym', scope: 'piece' });
    // A download (desktop) or a separate tab: either way the portal page is
    // not replaced. (The iPhone home-screen app behaviour is not tested here.)
    const outcome = Promise.race([
      page.waitForEvent('download').then((d) => d.url()),
      page.context().waitForEvent('page').then(async (popup) => {
        await popup.waitForLoadState('commit').catch(() => {});
        return popup.url();
      }),
    ]);
    await page.locator('#sheetSaveOpen').click();
    expect(await outcome).toContain('/api/sheets/tickets/ticket-abc');
    expect(page.url()).toBe(before);
    await expect(page.locator('#sheetSaveStatus')).toContainText('確認してください');
    monitor.assertNoClientErrors();
  });

  test('ZIP with a missing file: no silent partial ZIP; a partial one only on explicit choice; cancel stops the job', async ({ page }) => {
    await prepare(page, [sheet(1, 'Two.pdf', 'Sym'), sheet(2, 'Three.pdf', 'Sym')]);
    const created = [];
    const cancelled = [];
    let hang = false;
    await page.route('**/api/sheets/zip-jobs**', async (route) => {
      const url = new URL(route.request().url());
      const base = { job_id: '22222222-2222-4222-8222-222222222222', title: 'Concert', file_count: 2, total_bytes: 900, written_bytes: 0, list_version: 1, changed_since: false, zip_bytes: null };
      if (route.request().method() === 'POST' && url.pathname === '/api/sheets/zip-jobs') {
        created.push(route.request().postDataJSON());
        return route.fulfill({ json: { ...base, state: 'building', done_count: 0, allow_partial: false, missing: [] } });
      }
      if (url.pathname.endsWith('/cancel')) {
        cancelled.push(url.pathname);
        return route.fulfill({ json: { ...base, state: 'cancelled', done_count: 0, allow_partial: false, missing: [] } });
      }
      if (url.pathname.endsWith('/step')) {
        if (hang) { await new Promise((r) => setTimeout(r, 4000)); }
        return route.fulfill({ json: { ...base, state: 'incomplete', done_count: 1, allow_partial: false, missing: [{ sheet_id: 2, label: 'Sym Violin Three.pdf', reason: 'missing' }] } });
      }
      return route.fallback();
    });
    await page.locator('details[data-sheet-key="p:1"] summary [data-sheet-zip]').first().click();
    await expect(page.locator('#sheetSaveStatus')).toContainText('すべてを含むZIPは作成できませんでした');
    await expect(page.locator('#sheetSaveMissing')).toContainText('Three.pdf');
    await expect(page.locator('#sheetSaveShare')).toBeHidden();
    await expect(page.locator('#sheetSaveOpen')).toBeHidden();
    hang = true;
    await page.locator('#sheetSavePartial').click();
    await expect.poll(() => created.length).toBe(2);
    expect(created[1]).toMatchObject({ allow_partial: true, exclude_sheet_ids: [2] });
    await page.locator('#sheetSaveCancel').click();
    await expect(page.locator('#sheetSaveDialog')).toBeHidden();
    await expect.poll(() => cancelled.length).toBe(1);
    await expect(page.locator('details[data-sheet-key="p:1"]')).toBeVisible(); // the list is as it was
  });

  test('an expired save link is renewed first and only opens on the next tap', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => false });
    });
    await prepare(page, [sheet(1, 'Two.pdf', 'Sym')]);
    let issued = 0;
    await page.route('**/api/sheets/tickets', async (route) => {
      issued += 1;
      if (issued > 1) await new Promise((r) => setTimeout(r, 100));
      await route.fulfill({ json: { url: '/api/sheets/tickets/renewed-test',
        expires_at: new Date(Date.now() + (issued === 1 ? -1000 : 600000)).toISOString() } });
    });
    await page.context().route('**/api/sheets/tickets/renewed-test', (route) => route.fulfill({ contentType: 'text/plain', body: 'save destination' }));
    await page.locator('details[data-sheet-key="p:1:Sym"] summary').click();
    await page.locator('[data-sheet-save="1"]').click();
    await expect(page.locator('#sheetSaveOpen')).toBeVisible();
    const before = page.url();
    const pagesBefore = page.context().pages().length;
    await page.locator('#sheetSaveOpen').click();
    await expect(page.locator('#sheetSaveStatus')).toContainText('もう一度');
    expect(issued).toBe(2);
    expect(page.context().pages()).toHaveLength(pagesBefore);
    const opened = page.waitForEvent('popup');
    await page.locator('#sheetSaveOpen').click();
    const popup = await opened;
    await popup.waitForLoadState();
    expect(popup.url()).toContain('/api/sheets/tickets/renewed-test');
    expect(page.url()).toBe(before);
    await popup.close();
  });

  test('the real server: a sheet file opened without the portal session gets a page with the way back', async ({ request }) => {
    const response = await request.get('/api/sheets/view/sheets/v2/none/x.pdf', { headers: { accept: 'text/html' } });
    expect(response.status()).toBe(401);
    expect(await response.text()).toContain('ポータルに戻る');
    const list = await request.get('/api/sheets');
    expect(list.status()).toBe(401);
  });
});
