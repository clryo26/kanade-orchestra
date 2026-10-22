// Synthetic API + real portal JS/DOM in WebKit. No backend or live credentials.
// Use the same pinned Linux image as PERF_STAGE2B_IMPLEMENTATION.md.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { webkit, expect } = require('@playwright/test');
const { installPortalApiMocks } = require('../tests/e2e/fixtures/mockApi');

async function runManualWait(page, result, output) {
    const before = process.env.PORTAL_PERF_WAIT_PHASE === 'before';
    let busy = false;
    let sends = 0;
    let albums = 0;
    await page.route('**/api/extra/promotions', (route) => {
        sends++;
        return route.fulfill(busy ? { status: 503, headers: { 'Retry-After': '300' },
            json: { detail: { code: 'maintenance', message: 'synthetic maintenance' } } }
            : { json: [{ id: 90001, title: '表示済みの宣伝', summary: 'synthetic', created_at: '2026-10-21T03:00:00Z' }] });
    });
    await page.route('**/api/extra/albums', (route) => { albums++; return route.fulfill({ json: [] }); });
    const open = async (name) => {
        await page.click('#portalDrawerToggle');
        await page.locator('#portalDrawerMenu').getByRole('button', { name, exact: true }).click();
    };
    await open('宣伝');
    await expect.poll(() => page.evaluate(() => window.portalRuntimeContext.appState.promotionLoadState)).toBe('loaded');
    await page.fill('#promotionTitle', '入力を保持する');
    await page.locator('#promotionImageFile').setInputFiles({ name: 'keep.png', mimeType: 'image/png',
        buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64') });
    await expect.poll(() => page.locator('#promotionImagePreview img').evaluate((el) => el.naturalWidth)).toBe(1);
    await page.evaluate(() => { document.querySelector('.promotion-form').dataset.waitFixture = 'same-form'; document.activeElement.blur(); });
    await page.mouse.move(0, 0);
    const initialImage = await page.locator('.promotion-form').screenshot({ animations: 'disabled' });
    busy = true;
    const warm = sends;
    await page.click('#promotionReloadBtn');
    await expect.poll(() => page.evaluate(() => window.portalRuntimeContext.appState.promotionLoadState)).toBe('error');
    await page.evaluate(() => { document.getElementById('promotionReloadBtn').click(); document.getElementById('promotionReloadBtn').click(); });
    await expect.poll(() => sends - warm).toBe(before ? 3 : 1);
    await expect.poll(() => page.evaluate(() => window.portalRuntimeContext.appState.promotionLoadState)).toBe('error');
    result.manualFailureSends = sends - warm;
    expect(result.manualFailureSends).toBe(before ? 3 : 1);
    if (!before) await expect(page.locator('#toastArea')).toContainText('あと10秒');
    result.waitWarning = await page.locator('#toastArea').innerText();
    expect(await page.locator('#promotionTitle').inputValue()).toBe('入力を保持する');
    expect(await page.locator('#promotionImageFile').evaluate((el) => el.files[0]?.name)).toBe('keep.png');
    expect(await page.locator('.promotion-form').getAttribute('data-wait-fixture')).toBe('same-form');
    await expect(page.locator('#memberPromotionInfo')).toContainText('表示済みの宣伝');
    // The countdown toast was asserted separately; exclude its overlay when
    // checking that the existing form's text/positions/image did not change.
    await page.evaluate(() => { document.activeElement.blur(); document.getElementById('toastArea')?.replaceChildren(); });
    await page.mouse.move(0, 0);
    const waitingImage = await page.locator('.promotion-form').screenshot({ animations: 'disabled' });
    fs.writeFileSync(path.join(output, 'form-before-wait.png'), initialImage);
    fs.writeFileSync(path.join(output, 'form-during-wait.png'), waitingImage);
    result.formPixelsEqual = initialImage.equals(waitingImage);
    expect(result.formPixelsEqual).toBe(true);
    await open('アルバム');
    await expect.poll(() => albums).toBe(1);
    result.unrelatedAlbumSends = albums;
    await open('宣伝');
    await page.clock.setFixedTime(new Date('2026-10-21T12:00:10+09:00'));
    busy = false;
    await page.click('#promotionReloadBtn');
    await expect.poll(() => page.evaluate(() => window.portalRuntimeContext.appState.promotionLoadState)).toBe('loaded');
    result.failureAndProbeSends = sends - warm;
    expect(result.failureAndProbeSends).toBe(before ? 4 : 2);
    await page.evaluate(() => request('/api/extra/promotions', { _requestOrigin: 'automatic' }));
    result.afterSuccessfulProbeSends = sends - warm;
    expect(result.afterSuccessfulProbeSends).toBe(before ? 5 : 3);
    result.fileAndInputRetained = (await page.locator('#promotionTitle').inputValue()) === '入力を保持する'
        && await page.locator('#promotionImageFile').evaluate((el) => el.files[0]?.name === 'keep.png');
    expect(result.fileAndInputRetained).toBe(true);
    expect(result.pageErrors).toEqual([]);
}

async function main() {
    const root = path.resolve(process.env.PERF_SOURCE_ROOT || '.');
    const output = path.resolve(process.env.PERF_OUTPUT || '.tmp/perf-stage2-http/auth-races');
    const assets = path.resolve(process.env.PERF_ASSETS || '.tmp/perf-stage1-20261021/assets');
    fs.mkdirSync(output, { recursive: true });
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://localhost');
        const file = path.resolve(root, 'src', '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
        if (!file.startsWith(path.join(root, 'src') + path.sep)) return res.writeHead(403).end();
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return res.writeHead(404).end();
        res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
        res.end(fs.readFileSync(file));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    let browser;
    const report = { scope: process.env.PERF_RETRY_WAIT === '1'
        ? 'synthetic API; actual WebKit JS/DOM and manual clicks; not BFCache or physical iPhone'
        : 'synthetic API; actual WebKit JS/DOM; explicit pageshow, not BFCache or physical iPhone',
        platform: process.platform, image: process.env.PERF_IMAGE || null, fixedTime: '2026-10-21T12:00:00+09:00', cases: [] };
    try {
        browser = await webkit.launch();
        report.browser = browser.version();
        for (const order of process.env.PERF_RETRY_WAIT === '1' ? ['manual-wait'] : ['data-first', 'resume-first', 'other-tab-logout']) {
            const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2,
                locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
            let releaseAuth;
            const gate = new Promise((resolve) => { releaseAuth = resolve; });
            const result = { order, authSends: 0, pageErrors: [] };
            try {
                const page = await context.newPage();
                page.on('pageerror', (error) => result.pageErrors.push(error.message));
                await page.clock.setFixedTime(new Date(report.fixedTime));
                await page.route('https://cdn.jsdelivr.net/**', (route) => {
                    const name = path.basename(new URL(route.request().url()).pathname);
                    if (!['bootstrap.min.css', 'bootstrap.bundle.min.js'].includes(name)) return route.abort();
                    return route.fulfill({ body: fs.readFileSync(path.join(assets, name)), contentType: name.endsWith('.css') ? 'text/css' : 'text/javascript' });
                });
                await installPortalApiMocks(page, { permission: '一般' });
                await page.goto(`http://127.0.0.1:${server.address().port}`);
                await expect(page.locator('#portalStartupPanel')).toBeHidden();
                await page.fill('#portalNameInput', '団員テスト');
                await page.selectOption('#portalPartInput', { label: 'Violin' });
                await page.fill('#portalPasswordInput', 'synthetic-password');
                await page.click('#portalLoginBtn');
                await expect(page.locator('#memberPanel')).toBeVisible();
                await page.waitForLoadState('networkidle');
                if (order === 'manual-wait') {
                    await runManualWait(page, result, output);
                    result.passed = true;
                } else {
                await page.evaluate(() => {
                    const original = window.fetchPortalSessionCheck;
                    window.__raceAuthChecks = 0;
                    window.fetchPortalSessionCheck = function (...args) { window.__raceAuthChecks++; return original(...args); };
                    const clear = window.clearPortalAuthState;
                    window.__raceClears = 0;
                    window.clearPortalAuthState = function (...args) { window.__raceClears++; return clear(...args); };
                    window.portalRuntimeContext.appState.lastPortalSessionVerifiedAt = 0;
                    document.getElementById('toastArea')?.replaceChildren();
                });
                await page.route('**/api/events', (route) => route.fulfill({ status: 401, json: { detail: 'expired fixture' } }));
                await page.route('**/api/auth/devices/*', async (route) => {
                    result.authSends++;
                    await gate;
                    await route.fulfill({ status: 401, json: { detail: 'expired fixture' } });
                });
                const startData = () => page.evaluate(() => { window.__raceData = request('/api/events', { _forceRevalidate: true }).catch(() => null); });
                const startResume = () => page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
                await (order === 'data-first' ? startData() : startResume());
                await expect.poll(() => result.authSends).toBe(1);
                if (order === 'other-tab-logout') {
                    const other = await context.newPage();
                    await other.goto(`http://127.0.0.1:${server.address().port}/static/css/style.css`);
                    await page.evaluate(() => { window.__raceStorageSeen = false; window.addEventListener('storage', () => { window.__raceStorageSeen = true; }, { once: true }); });
                    await other.evaluate(() => localStorage.removeItem('kanadePortalAuthenticated'));
                    await expect.poll(() => page.evaluate(() => window.__raceStorageSeen)).toBe(true);
                } else {
                    await (order === 'data-first' ? startResume() : startData());
                    await expect.poll(() => page.evaluate(() => window.__raceAuthChecks)).toBe(2);
                }
                releaseAuth();
                await expect(page.locator('#toastArea')).toContainText(/ログイン期限が切れました|通信が不安定/, { timeout: 3000 });
                result.warning = await page.locator('#toastArea').innerText();
                result.loginVisible = await page.locator('#portalLoginPanel').isVisible();
                result.clearCalls = await page.evaluate(() => window.__raceClears);
                await expect(page.locator('#portalLoginPanel')).toBeVisible({ timeout: 3000 });
                expect(result.warning).toContain('ログイン期限が切れました');
                expect(result.warning).not.toContain('通信が不安定');
                expect(result.authSends).toBe(1);
                expect(result.pageErrors).toEqual([]);
                result.passed = true;
                }
            } catch (error) {
                result.passed = false;
                result.error = error.message;
            } finally {
                releaseAuth();
                await context.close();
            }
            report.cases.push(result);
        }
    } finally {
        if (browser) await browser.close();
        await new Promise((resolve) => server.close(resolve));
    }
    report.sourceSha256 = Object.fromEntries(['src/static/js/modules/common_helpers/api_runtime.js', 'src/static/js/auth_feature.js',
        'src/static/js/modules/common_helpers/transport_retry.js'].map((file) => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
    if (report.cases.some((result) => !result.passed)) process.exitCode = 1;
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
