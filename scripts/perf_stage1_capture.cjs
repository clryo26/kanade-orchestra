// PERF-R28/R29: isolated, synthetic browser baseline; never uses a live API.
// Run before application edits, then again with the same Linux image and assets.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { webkit, expect } = require('@playwright/test');
const { installPortalApiMocks } = require('../tests/e2e/fixtures/mockApi');

async function main() {
  const root = path.resolve(process.env.PERF_SOURCE_ROOT || '.');
  const out = path.resolve(process.env.PERF_OUTPUT || '.tmp/perf-stage1/capture');
  const assets = path.resolve(process.env.PERF_ASSETS || '.tmp/perf-stage1/assets');
  const captureOnly = process.env.PERF_CAPTURE_ONLY === '1';
  fs.mkdirSync(out, { recursive: true }); fs.mkdirSync(assets, { recursive: true });
  const cdn = new Map();
  for (const [suffix, type] of [['css/bootstrap.min.css', 'text/css'], ['js/bootstrap.bundle.min.js', 'text/javascript']]) {
    const url = 'https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/' + suffix;
    const file = path.join(assets, path.basename(suffix));
    if (!fs.existsSync(file)) {
      const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`Fixture download failed: ${response.status}`);
      fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
    }
    cdn.set(url, { body: fs.readFileSync(file), contentType: type });
  }
  const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.svg': 'image/svg+xml', '.mjs': 'text/javascript' };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const file = path.resolve(root, 'src', '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
    if (!file.startsWith(path.join(root, 'src') + path.sep)) { res.writeHead(403).end(); return; }
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await webkit.launch();
  const report = { scope: 'synthetic API; real static files and WebKit; NOT DB/GCS performance',
    platform: process.platform, node: process.version, browser: browser.version(),
    sourceCommit: process.env.PERF_COMMIT || null, image: process.env.PERF_IMAGE || null,
    fixedTime: '2026-10-21T12:00:00+09:00', captureOnly,
    timingScope: 'synthetic startup until network idle, includes idle window; route mocking disables HTTP cache',
    sqlCalls: null, gcsCalls: null, cases: [], errors: [] };
  try {
    for (const permission of ['一般', 'システム管理者']) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2,
        locale: 'ja-JP', timezoneId: 'Asia/Tokyo', recordHar: { path: path.join(out, `${permission}.har`), content: 'omit' } });
      const page = await context.newPage();
      await page.clock.setFixedTime(new Date(report.fixedTime));
      await page.route('https://cdn.jsdelivr.net/**', route => {
        const fixture = cdn.get(route.request().url());
        return fixture ? route.fulfill(fixture) : route.abort();
      });
      await installPortalApiMocks(page, { permission });
      await page.addInitScript(() => localStorage.setItem('kanadePortalDeviceId', 'synthetic-perf-device'));
      await page.addInitScript(() => {
        const originalCreate = URL.createObjectURL.bind(URL), originalRevoke = URL.revokeObjectURL.bind(URL);
        const live = new Set(); let created = 0, released = 0;
        URL.createObjectURL = blob => { const url = originalCreate(blob); if (blob.type.startsWith('image/')) { live.add(url); created++; } return url; };
        URL.revokeObjectURL = url => { if (live.delete(url)) released++; return originalRevoke(url); };
        window.perfPreviewCounts = () => ({ created, released, live: live.size });
      });
      page.on('pageerror', error => report.errors.push(error.message));
      const requests = [];
      page.on('request', request => requests.push(new URL(request.url()).pathname));
      const timings = [];
      for (let i = 0; i < (captureOnly ? 1 : 40); i++) {
        if (i > 0 && i < 10) await page.evaluate(async () => {
          localStorage.clear();
          window.portalRuntimeContext?.dbCache?.db?.close();
          await new Promise((resolve, reject) => {
            const request = indexedDB.deleteDatabase('OrchestraAppCache');
            request.onsuccess = resolve; request.onerror = () => reject(request.error);
            request.onblocked = () => reject(new Error('baseline cache reset blocked'));
          });
        });
        await page.addInitScript(() => localStorage.setItem('kanadePortalDeviceId', 'synthetic-perf-device'));
        const started = performance.now();
        await page.goto(base);
        await expect(page.locator('#portalStartupPanel')).toBeHidden({ timeout: 20000 });
        if (await page.locator('#portalNameInput').isVisible()) {
          await page.fill('#portalNameInput', '団員テスト');
          await page.selectOption('#portalPartInput', { label: 'Violin' });
          await page.fill('#portalPasswordInput', 'synthetic-password');
          await page.click('#portalLoginBtn');
        }
        await expect(page.locator('#memberPanel')).toBeVisible({ timeout: 20000 });
        await expect(page.locator('#portalStartupPanel')).toBeHidden();
        // Finish deferred API calls before navigation so cancellation noise is
        // not mistaken for application errors. Includes the fixed idle window.
        await page.waitForLoadState('networkidle');
        timings.push(performance.now() - started);
      }
      const quantiles = values => { const a = [...values].sort((a, b) => a - b); return a.length ? { n: a.length, p50: a[Math.ceil(a.length * .5) - 1], p95: a[Math.ceil(a.length * .95) - 1] } : null; };
      const entry = { permission, viewport: '390x844@2', cold: quantiles(timings.slice(0, 10)), warm: quantiles(timings.slice(10)),
        actorRequests: requests.filter(p => p === '/api/portal-file-actor').length, requests: Object.fromEntries([...new Set(requests)].sort().map(p => [p, requests.filter(v => v === p).length])), screenshots: [] };
      const capture = async name => {
        await page.evaluate(() => { document.getElementById('toastArea')?.replaceChildren(); });
        await page.screenshot({ path: path.join(out, `${permission}-${name}.png`), fullPage: true, animations: 'disabled' });
        const dom = await page.locator('body').evaluate(el => Array.from(el.querySelectorAll('button,input,label,h1,h2,h3,h4,h5,h6')).filter(n => n.getClientRects().length).map(n => ({ tag: n.tagName, id: n.id, text: (n.textContent || '').trim(), type: n.type || '' })));
        fs.writeFileSync(path.join(out, `${permission}-${name}.json`), JSON.stringify(dom, null, 2));
        entry.screenshots.push(name);
      };
      await capture('home');
      await page.evaluate(() => showMemberTab('member-promotion'));
      await expect(page.locator('.promotion-form')).toBeVisible();
      await page.waitForLoadState('networkidle');
      await capture('promotions');
      const png = await page.evaluate(() => {
        const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 32;
        const ctx = canvas.getContext('2d'); ctx.fillStyle = '#235789'; ctx.fillRect(0, 0, 32, 32);
        return canvas.toDataURL('image/png').split(',')[1];
      });
      const image = { name: 'synthetic-preview.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') };
      const preview = async (input, selector, name) => {
        await page.locator(input).setInputFiles(image);
        await page.locator(input).setInputFiles(image);
        // Flyer previews use loading=lazy and may be below the fold.
        await page.locator(selector).scrollIntoViewIfNeeded();
        await expect.poll(() => page.locator(selector).evaluate(img => img.naturalWidth)).toBeGreaterThan(0);
        await capture(name);
      };
      await preview('#promotionImageFile', '#promotionImagePreview img', 'promotion-preview');
      await page.evaluate(() => clearPromotionForm());
      if (permission === 'システム管理者') {
        await page.evaluate(() => showAdminPanel());
        await expect(page.locator('#adminPanel')).toBeVisible();
        await page.waitForLoadState('networkidle');
        await capture('performance-form');
        await preview('#perfFlyerFile', '#perfFlyerPreview img', 'flyer-preview');
        await page.evaluate(() => renderPerformanceFlyerPreview(''));
        await page.evaluate(() => showSystemPanel());
        await page.evaluate(() => switchTab('systemPanel', 'system-org'));
        await expect(page.locator('#orgIconPreview')).toBeVisible();
        await page.waitForLoadState('networkidle');
        await capture('organization');
        await preview('#orgIconFile', '#orgIconPreview', 'organization-preview');
        await page.evaluate(() => clearOrgSettingForm());
      }
      entry.previewObjectUrls = await page.evaluate(() => window.perfPreviewCounts());
      for (const width of [375, 430]) {
        await page.setViewportSize({ width, height: 844 });
        await page.evaluate(() => showMemberPanel());
        await page.waitForLoadState('networkidle');
        await capture(`home-${width}`);
      }
      report.cases.push(entry);
      await context.close();
      // HAR contains synthetic values only, but redact authentication payloads
      // and identifiers as well so the artifact is safe to inspect/share.
      const harFile = path.join(out, `${permission}.har`);
      const har = JSON.parse(fs.readFileSync(harFile));
      for (const e of har.log.entries) {
        for (const message of [e.request, e.response]) {
          message.headers = message.headers.filter(h => !/^(cookie|set-cookie|authorization|x-device-id)$/i.test(h.name));
          message.cookies = [];
        }
        if (new URL(e.request.url).pathname.startsWith('/api/auth/')) delete e.request.postData;
        e.request.url = e.request.url.replace(base, 'http://synthetic-portal.test');
      }
      fs.writeFileSync(harFile, JSON.stringify(har));
    }
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
  report.assetHashes = Object.fromEntries([...cdn].map(([url, f]) => [url, crypto.createHash('sha256').update(f.body).digest('hex')]));
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (report.errors.length) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
