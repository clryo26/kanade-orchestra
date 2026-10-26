// Same Linux/WebKit for both phases, synthetic APIs, actual portal JS and DOM.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { webkit, expect } = require('@playwright/test');
const { installPortalApiMocks } = require('../tests/e2e/fixtures/mockApi');
async function main() {
    const root = process.cwd(), output = path.resolve('.tmp/perf-stage2cde/browser');
    fs.mkdirSync(output, { recursive: true });
    let phase = 'before';
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://localhost');
        const relative = 'src' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname));
        const file = path.resolve(root, relative);
        if (!file.startsWith(path.join(root, 'src') + path.sep)) return res.writeHead(403).end();
        const previous = path.resolve(root, '.tmp/perf-stage2cde/before', relative);
        const target = phase === 'before' && fs.existsSync(previous) ? previous : file;
        if (!fs.existsSync(target)) return res.writeHead(404).end();
        res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png' })[path.extname(target)] || 'application/octet-stream');
        res.end(fs.readFileSync(target));
    });
    await new Promise(resolve => server.listen(0, '0.0.0.0', resolve));
    const browser = await webkit.launch();
    const report = { mode: 'fixed Linux/WebKit, mocked API, not physical iPhone/BFCache',
        browser: browser.version(), platform: process.platform, image: process.env.PERF_IMAGE,
        viewport: { width: 390, height: 844 }, dpr: 2, fixedTime: '2026-10-22T12:00:00+09:00', cases: [] };
    const previous = new Map();
    try {
        for (phase of ['before', 'after']) {
            for (const permission of ['一般', '管理者', 'システム管理者']) {
                const context = await browser.newContext({ viewport: report.viewport, deviceScaleFactor: 2, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
                try {
                    const page = await context.newPage(), errors = [];
                    page.on('pageerror', error => errors.push(error.message));
                    await page.clock.setFixedTime(new Date(report.fixedTime));
                    await page.route('https://cdn.jsdelivr.net/**', route => {
                        const name = path.basename(new URL(route.request().url()).pathname);
                        if (!['bootstrap.min.css', 'bootstrap.bundle.min.js'].includes(name)) return route.abort();
                        return route.fulfill({ body: fs.readFileSync(path.join('.tmp/perf-stage1-20261021/assets', name)), contentType: name.endsWith('.css') ? 'text/css' : 'text/javascript' });
                    });
                    await installPortalApiMocks(page, { permission });
                    await page.goto(`http://127.0.0.1:${server.address().port}`);
                    await expect(page.locator('#portalStartupPanel')).toBeHidden();
                    await page.fill('#portalNameInput', permission === '一般' ? '団員テスト' : 'administrator');
                    if (permission === '一般') await page.selectOption('#portalPartInput', { label: 'Violin' });
                    await page.fill('#portalPasswordInput', 'synthetic');
                    await page.click('#portalLoginBtn');
                    await expect(page.locator('#memberPanel')).toBeVisible();
                    await page.waitForLoadState('networkidle');
                    for (const tab of ['member-album', 'member-promotion', 'member-concert-record']) {
                        await page.evaluate(tab => switchTab('memberPanel', tab), tab);
                        await page.waitForLoadState('networkidle');
                        await page.evaluate(() => { document.activeElement?.blur(); document.getElementById('toastArea')?.replaceChildren(); });
                        await page.mouse.move(0, 0);
                        const png = await page.screenshot({ animations: 'disabled' });
                        const dom = await page.locator('#memberPanel').innerText();
                        const key = `${permission}:${tab}`;
                        const signature = { image: crypto.createHash('sha256').update(png).digest('hex'), dom: crypto.createHash('sha256').update(dom).digest('hex') };
                        fs.writeFileSync(path.join(output, `${phase}-${report.cases.length}.png`), png);
                        if (phase === 'before') previous.set(key, signature);
                        else expect(signature).toEqual(previous.get(key));
                        report.cases.push({ phase, permission, tab, ...signature, matchesBaseline: phase === 'after' ? true : null });
                    }
                    await page.evaluate(() => { document.getElementById('orgName').value = 'synthetic unsaved'; });
                    await page.locator('#orgIconFile').setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: Buffer.from('synthetic') });
                    await page.evaluate(() => loadExtraData(['albums']));
                    const preserved = await page.evaluate(() => document.getElementById('orgName').value === 'synthetic unsaved'
                        && document.getElementById('orgIconFile').files[0]?.name === 'synthetic.png');
                    expect(preserved).toBe(phase === 'after');
                    expect(errors).toEqual([]);
                    report.cases.push({ phase, permission, unrelatedInputAndFilePreserved: preserved, pageErrors: errors });
                } finally { await context.close(); }
            }
        }
        fs.writeFileSync('.tmp/perf_stage2_cde/c_browser.json', JSON.stringify(report, null, 2) + '\n');
        console.log(JSON.stringify({ cases: report.cases.length, browser: report.browser, passed: true }));
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
