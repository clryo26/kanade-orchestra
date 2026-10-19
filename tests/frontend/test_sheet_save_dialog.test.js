// Save dialog (scores/save_dialog.js) with a small fake DOM and network.
// Review finding 4 (in-memory limit) and finding 5 (opening the saved file
// from the user's own tap). Limits are injected small; no large buffers.
// A real iPhone (Safari / home-screen app) is NOT covered here.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const dir = path.resolve(__dirname, '../../src/static/js/modules/scores');
const read = (name) => fs.readFileSync(path.join(dir, name), 'utf8');
const flush = async (n = 30) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0)); };

function element(id) {
    return {
        id, hidden: false, textContent: '', style: {}, firstChild: { style: {} }, children: [], listeners: {},
        addEventListener(type, fn) { this.listeners[type] = fn; },
        setAttribute() {}, querySelectorAll: () => [], appendChild(c) { this.children.push(c); return c; }, focus() {},
        set innerHTML(v) { this.children = []; }, get innerHTML() { return ''; },
    };
}

// body: Uint8Array chunks; header: Content-Length (null = none).
function streamResponse(chunks, header, log) {
    let index = 0;
    let pending = null;
    const reader = {
        read() {
            log.reads += 1;
            if (log.hang || (log.hangAfter != null && index >= log.hangAfter)) return new Promise((resolve, reject) => { pending = { resolve, reject }; log.pending = pending; });
            if (index >= chunks.length) return Promise.resolve({ done: true });
            return Promise.resolve({ done: false, value: chunks[index++] });
        },
        cancel() { log.cancelled += 1; if (pending) pending.reject(new Error('cancelled')); return Promise.resolve(); },
    };
    return {
        status: 200, ok: true,
        headers: { get: (k) => (k.toLowerCase() === 'content-length' ? (header == null ? null : String(header)) : 'application/pdf') },
        body: { getReader: () => reader },
        json: async () => ({}),
    };
}

const json = (data, status = 200) => ({ status, ok: status < 400, headers: { get: (k) => (k === 'content-type' ? 'application/json' : null) }, json: async () => data });

// mode: the device the dialog runs on ('mobile' | 'desktop'); null = detected
// from the navigator (userAgent / platform / maxTouchPoints in navigatorExtra).
// clicks: links opened in a separate screen; downloads: <a download> links.
function makeDialog({ canShare = true, standalone = false, limits = { pdf: 1024, zip: 1024 }, network, mode = 'mobile', navigatorExtra = {} }) {
    const elements = {};
    let inserted = false;
    const clicks = [];
    const downloads = [];
    const alerts = [];
    const calls = [];
    const shared = [];
    const appState = { portalAuthVerified: true, currentUserMemberId: 7, currentUserPermission: '一般' };
    const document = {
        getElementById(id) {
            if (id === 'sheetSaveDialog' && !inserted) return null;
            if (!elements[id]) elements[id] = element(id);
            return elements[id];
        },
        body: { insertAdjacentHTML() { inserted = true; }, classList: { add() {}, remove() {} }, appendChild() {} },
        contains: () => true,
        activeElement: null,
        createElement(tag) {
            if (tag === 'a') {
                return {
                    tag, remove() {},
                    click() {
                        if ('download' in this) downloads.push({ href: this.href, download: this.download, target: this.target });
                        else clicks.push(this.href);
                    },
                };
            }
            return element(tag);
        },
    };
    const sandbox = {
        console, Promise, JSON, Math, Date, Object, Array, String, Number, Uint8Array, AbortController, setTimeout, clearTimeout,
        File,
        document,
        localStorage: { getItem: (k) => (k === 'device' ? 'dev-1' : null), setItem() {}, removeItem() {} },
        window: {
            portalRuntimeContext: { appState, PORTAL_DEVICE_ID_KEY: 'device' },
            matchMedia: () => ({ matches: standalone }),
            navigator: {
                standalone,
                canShare: canShare ? () => true : () => false,
                share: async (data) => { shared.push(data.files.map((f) => ({ name: f.name, size: f.size, type: f.type }))); },
                ...navigatorExtra,
            },
            localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        },
        portalSheetSaveLimits: limits,
        portalSaveDeviceMode: mode,
        showAlert: (message, tone) => alerts.push({ message, tone }),
        fetchWithTimeout: (url, init) => {
            calls.push({ url, method: init.method || 'GET', signal: init.signal });
            return Promise.resolve(network(url, init, calls.length));
        },
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(read('sheet_api.js'), sandbox);
    vm.runInContext(read('save_dialog.js'), sandbox);
    const el = (id) => document.getElementById(id);
    return { sandbox, el, clicks, downloads, alerts, calls, shared, appState };
}

const bytes = (n, value = 1) => new Uint8Array(n).fill(value);
const ticket = (seconds) => json({ url: '/api/sheets/tickets/t-' + seconds, expires_at: new Date(Date.now() + seconds * 1000).toISOString() });
const sheet = (size) => ({ id: 1, name: 'a.pdf', size, download_url: '/api/sheets/download/a.pdf' });

describe('save dialog: in-memory limit (finding 4)', () => {
    test.each([
        ['under the limit', 1000],
        ['exactly the limit', 1024],
    ])('%s: the file is read and offered to the share sheet', async (_name, size) => {
        const log = { reads: 0, cancelled: 0 };
        const d = makeDialog({ network: (url) => (url.includes('/download/') ? streamResponse([bytes(size)], size, log) : ticket(600)) });
        d.sandbox.openSheetSave({ kind: 'file', sheet: sheet(size) });
        await flush();
        expect(d.el('sheetSaveShare').hidden).toBe(false);
        expect(d.sandbox.portalSheetSave.current().file.size).toBe(size);
    });

    test('registered size above the limit: the body is never fetched; the other way is offered', async () => {
        const d = makeDialog({ network: (url) => (url.includes('/tickets') ? ticket(600) : streamResponse([bytes(2048)], 2048, { reads: 0, cancelled: 0 })) });
        d.sandbox.openSheetSave({ kind: 'file', sheet: sheet(2048) });
        await flush();
        expect(d.calls.map((c) => c.url)).toEqual(['/api/sheets/tickets']);
        expect(d.el('sheetSaveOpen').hidden).toBe(false);
        expect(d.el('sheetSaveShare').hidden).toBe(true);
    });

    test('Content-Length above the limit (size not registered): nothing is read, the transfer is stopped', async () => {
        const log = { reads: 0, cancelled: 0 };
        const d = makeDialog({ network: (url) => (url.includes('/tickets') ? ticket(600) : streamResponse([bytes(1024), bytes(1024)], 2048, log)) });
        d.sandbox.openSheetSave({ kind: 'file', sheet: sheet(0) });
        await flush();
        expect(log.reads).toBe(0);
        expect(log.cancelled).toBe(1);
        expect(d.calls[0].signal.aborted).toBe(true);
        expect(d.sandbox.portalSheetSave.current().file).toBeNull();
        expect(d.el('sheetSaveOpen').hidden).toBe(false);
    });

    test('unknown size: reading stops at the first chunk beyond the limit', async () => {
        const log = { reads: 0, cancelled: 0 };
        const chunks = [bytes(512), bytes(512), bytes(512), bytes(512)];
        const d = makeDialog({ network: (url) => (url.includes('/tickets') ? ticket(600) : streamResponse(chunks, null, log)) });
        d.sandbox.openSheetSave({ kind: 'file', sheet: sheet(0) });
        await flush();
        expect(log.reads).toBe(3); // 1536 > 1024: stopped, the 4th chunk is never read
        expect(log.cancelled).toBe(1);
        expect(d.sandbox.portalSheetSave.current().file).toBeNull();
        expect(d.el('sheetSaveOpen').hidden).toBe(false);
    });

    test('a body larger than its Content-Length is refused without keeping it', async () => {
        const log = { reads: 0, cancelled: 0 };
        const d = makeDialog({ network: (url) => (url.includes('/tickets') ? ticket(600) : streamResponse([bytes(400), bytes(400), bytes(400)], 500, log)) });
        d.sandbox.openSheetSave({ kind: 'file', sheet: sheet(0) });
        await flush();
        expect(log.reads).toBe(2);
        expect(log.cancelled).toBe(1);
        expect(d.sandbox.portalSheetSave.current().file).toBeNull();
        expect(d.el('sheetSaveStatus').textContent).toContain('大きさが一致しません');
        expect(d.el('sheetSaveRetry').hidden).toBe(false);
    });

    test('ZIP: the ready size above the limit goes the other way without downloading', async () => {
        const job = { job_id: '11111111-1111-4111-8111-111111111111', state: 'ready', title: 'C', file_count: 1, done_count: 1,
            total_bytes: 10, written_bytes: 10, allow_partial: false, missing: [], zip_bytes: 4096, list_version: 1, changed_since: false };
        const d = makeDialog({ network: (url) => (url.includes('/tickets') ? ticket(600) : json(job)) });
        d.sandbox.openSheetSave({ kind: 'zip', performanceId: 1, piece: '', part: '', title: 'C', count: 1 });
        await flush();
        expect(d.calls.map((c) => c.url)).toEqual(['/api/sheets/zip-jobs', '/api/sheets/tickets']);
        expect(d.el('sheetSaveOpen').hidden).toBe(false);
    });

    test('cancel while reading stops the transfer and frees what was read', async () => {
        const log = { reads: 0, cancelled: 0, hangAfter: 1 };
        const d = makeDialog({ network: (url) => streamResponse([bytes(100)], 900, log) });
        d.sandbox.openSheetSave({ kind: 'file', sheet: sheet(900) });
        await flush();
        // (first chunk consumed; the next read waits)
        await flush();
        d.sandbox.closeSheetSave();
        await flush();
        expect(d.calls[0].signal.aborted).toBe(true);
        expect(log.cancelled).toBeGreaterThanOrEqual(1);
        const readsAfterClose = log.reads;
        await flush();
        expect(log.reads).toBe(readsAfterClose);
        expect(d.sandbox.portalSheetSave.current()).toBeNull();
    });

    test('the timeout remains active when headers arrived but the body stalls', async () => {
        vi.useFakeTimers();
        try {
            const log = { reads: 0, cancelled: 0, hangAfter: 1 };
            const d = makeDialog({ network: () => streamResponse([bytes(100)], 900, log) });
            d.sandbox.openSheetSave({ kind: 'file', sheet: sheet(900) });
            await vi.advanceTimersByTimeAsync(1);
            expect(log.reads).toBe(2);
            await vi.advanceTimersByTimeAsync(120000);
            expect(log.cancelled).toBeGreaterThanOrEqual(1);
            expect(d.calls[0].signal.aborted).toBe(true);
            expect(d.sandbox.portalSheetSave.current().file).toBeNull();
            expect(d.el('sheetSaveStatus').textContent).toContain('タイムアウト');
        } finally {
            vi.useRealTimers();
        }
    });

    test('limits can only be lowered by the hook, never raised', () => {
        const d = makeDialog({ limits: { pdf: 999 * 1024 * 1024 * 1024 }, network: () => json({}) });
        expect(d.sandbox.portalSheetSave.limit('application/pdf')).toBe(d.sandbox.portalSheetSave.PDF_MEMORY_LIMIT);
    });
});

describe('save dialog: opening from the user tap (finding 5)', () => {
    async function ready(options) {
        const d = makeDialog({ canShare: false, ...options });
        d.sandbox.openSheetSave({ kind: 'file', sheet: sheet(100) });
        await flush();
        return d;
    }

    test('a valid link opens synchronously inside the tap, without claiming it opened', async () => {
        const d = await ready({ network: () => ticket(600) });
        d.el('sheetSaveOpen').listeners.click();
        expect(d.clicks).toEqual(['/api/sheets/tickets/t-600']); // no await before opening
        await flush();
        expect(d.el('sheetSaveStatus').textContent).not.toMatch(/開きました|ダウンロードを開始しました/);
    });

    test.each([['about to expire', 10], ['expired', -5]])('%s: the tap only renews; the next tap opens', async (_name, seconds) => {
        let renew;
        let first = true;
        const d = await ready({
            network: (url) => {
                if (first) { first = false; return ticket(seconds); }
                return new Promise((resolve) => { renew = () => resolve(ticket(600)); });
            },
        });
        d.el('sheetSaveOpen').listeners.click();
        expect(d.clicks).toEqual([]);
        renew();
        await flush();
        expect(d.clicks).toEqual([]); // renewed, but not opened outside the tap
        expect(d.el('sheetSaveStatus').textContent).toContain('もう一度「別の画面で開いて保存」を押してください');
        expect(d.el('sheetSaveOpen').hidden).toBe(false);
        d.el('sheetSaveOpen').listeners.click();
        expect(d.clicks).toEqual(['/api/sheets/tickets/t-600']);
    });

    test('a renewal that fails opens nothing and says so', async () => {
        let first = true;
        const d = await ready({ network: () => { if (first) { first = false; return ticket(5); } return json({ detail: { message: '失敗' } }, 503); } });
        d.el('sheetSaveOpen').listeners.click();
        await flush();
        expect(d.clicks).toEqual([]);
        expect(d.el('sheetSaveStatus').textContent).toContain('失敗');
    });

    test('a renewal finishing after the dialog closed (or another account signed in) changes nothing', async () => {
        for (const change of ['close', 'account']) {
            let renew;
            let first = true;
            const d = await ready({ network: () => { if (first) { first = false; return ticket(5); } return new Promise((r) => { renew = () => r(ticket(600)); }); } });
            d.el('sheetSaveOpen').listeners.click();
            const before = d.el('sheetSaveStatus').textContent;
            if (change === 'close') d.sandbox.closeSheetSave();
            else d.appState.currentUserMemberId = 8;
            renew();
            await flush();
            expect(d.clicks).toEqual([]);
            if (change === 'account') expect(d.el('sheetSaveStatus').textContent).toBe(before);
        }
    });

    test('home-screen app and browser get different guidance', async () => {
        const pwa = await ready({ standalone: true, network: () => ticket(600) });
        const browser = await ready({ standalone: false, network: () => ticket(600) });
        expect(pwa.el('sheetSaveStatus').textContent).toContain('完了');
        expect(browser.el('sheetSaveStatus').textContent).not.toContain('完了');
    });
});

const readyJob = (zipBytes) => ({ job_id: '11111111-1111-4111-8111-111111111111', state: 'ready', title: 'C', file_count: 3, done_count: 3,
    total_bytes: zipBytes, written_bytes: zipBytes, allow_partial: false, missing: [], zip_bytes: zipBytes, list_version: 1, changed_since: false });

describe('save dialog: the ZIP size is shown before the download', () => {
    test('mobile: a small ZIP is not read into the page either; the size is shown, then a separate screen', async () => {
        const d = makeDialog({ network: (url) => (url.includes('/tickets') ? ticket(600) : json(readyJob(512))) });
        d.sandbox.openSheetSave({ kind: 'zip', performanceId: 1, piece: 'Sym', part: '', title: 'C', count: 3 });
        await flush();
        expect(d.calls.map((c) => c.url)).toEqual(['/api/sheets/zip-jobs', '/api/sheets/tickets']);
        expect(d.el('sheetSaveCount').textContent).toBe('3 件の楽譜・ZIP 1 KB');
        expect(d.el('sheetSaveStatus').textContent).toContain('ZIPの準備ができました（1 KB）');
        expect(d.el('sheetSaveShare').hidden).toBe(true);
        expect(d.el('sheetSaveOpen').hidden).toBe(false);
        expect(d.el('sheetSaveOpen').textContent).toBe('別の画面で開いて保存');
        expect(d.clicks).toEqual([]); // opened only from the user's tap
        d.el('sheetSaveOpen').listeners.click();
        expect(d.clicks).toEqual(['/api/sheets/tickets/t-600']);
        expect(d.downloads).toEqual([]);
    });

    test('mobile recording ZIP: the size is asked first; nothing is downloaded until the tap', async () => {
        const d = makeDialog({ network: () => json({ file_count: 4, missing_count: 1, total_bytes: 5 * 1024 * 1024 }) });
        d.sandbox.openSheetSave({ kind: 'recording-zip', url: '/api/recordings/download-zip?date=d', infoUrl: '/api/recordings/download-zip/info?date=d', title: 'D' });
        await flush();
        expect(d.calls.map((c) => c.url)).toEqual(['/api/recordings/download-zip/info?date=d']);
        expect(d.el('sheetSaveTitle').textContent).toBe('録音のZIPを保存');
        expect(d.el('sheetSaveCount').textContent).toBe('4 件の録音・ZIP 約 5.0 MB');
        expect(d.el('sheetSaveStatus').textContent).toContain('約 5.0 MB');
        expect(d.el('sheetSaveStatus').textContent).toContain('取得できない録音 1 件');
        expect(d.clicks).toEqual([]);
        d.el('sheetSaveOpen').listeners.click();
        expect(d.clicks).toEqual(['/api/recordings/download-zip?date=d']);
    });

    test('a recording ZIP without recordings says so', async () => {
        const d = makeDialog({ network: () => json({ detail: 'Recording files not found' }, 404) });
        d.sandbox.openSheetSave({ kind: 'recording-zip', url: '/z', infoUrl: '/z/info', title: 'D' });
        await flush();
        expect(d.el('sheetSaveStatus').textContent).toContain('保存できる録音がありません');
        expect(d.el('sheetSaveRetry').hidden).toBe(false);
    });
});

describe('save dialog: mobile recording (single file)', () => {
    test('a recording under the limit is offered to the share sheet with an audio type', async () => {
        const log = { reads: 0, cancelled: 0 };
        const d = makeDialog({ network: () => streamResponse([bytes(600)], 600, log) });
        d.sandbox.openSheetSave({ kind: 'url', media: 'audio', url: '/api/recordings/download/a.mp3', name: 'a.mp3', size: 600 });
        await flush();
        expect(d.el('sheetSaveTitle').textContent).toBe('録音を保存');
        expect(d.el('sheetSaveShare').hidden).toBe(false);
        await d.el('sheetSaveShare').listeners.click();
        expect(d.shared).toEqual([[{ name: 'a.mp3', size: 600, type: 'audio/mpeg' }]]);
    });

    test('a recording above the limit is never fetched; it opens in a separate screen', async () => {
        const d = makeDialog({ network: () => { throw new Error('must not fetch'); } });
        d.sandbox.openSheetSave({ kind: 'url', media: 'audio', url: '/api/recordings/download/big.m4a', name: 'big.m4a', size: 4096 });
        await flush();
        expect(d.calls).toEqual([]);
        d.el('sheetSaveOpen').listeners.click();
        expect(d.clicks).toEqual(['/api/recordings/download/big.m4a']);
    });
});

describe('save dialog: PC browser download', () => {
    test('a sheet DL downloads at once through a ticket, without the dialog or the share sheet', async () => {
        const d = makeDialog({ mode: 'desktop', network: () => ticket(600) });
        d.sandbox.openSheetSave({ kind: 'file', sheet: sheet(100) });
        await flush();
        expect(d.calls.map((c) => [c.url, c.method])).toEqual([['/api/sheets/tickets', 'POST']]);
        expect(d.downloads).toEqual([{ href: '/api/sheets/tickets/t-600', download: '', target: undefined }]);
        expect(d.clicks).toEqual([]); // no new tab
        expect(d.shared).toEqual([]);
        expect(d.sandbox.portalSheetSave.current()).toBeNull();
    });

    test('a failed ticket is reported and nothing is downloaded', async () => {
        const d = makeDialog({ mode: 'desktop', network: () => json({ detail: { message: '楽譜が見つかりません。一覧を更新してください' } }, 404) });
        d.sandbox.openSheetSave({ kind: 'file', sheet: sheet(100) });
        await flush();
        expect(d.downloads).toEqual([]);
        expect(d.alerts).toEqual([{ message: '楽譜が見つかりません。一覧を更新してください', tone: 'danger' }]);
    });

    test('a reference score downloads its URL directly with its name', () => {
        const d = makeDialog({ mode: 'desktop', network: () => { throw new Error('must not fetch'); } });
        d.sandbox.openSheetSave({ kind: 'url', url: '/api/extra/desired_pieces/1/reference_score', name: 'Ref.pdf' });
        expect(d.downloads).toEqual([{ href: '/api/extra/desired_pieces/1/reference_score', download: 'Ref.pdf', target: undefined }]);
        expect(d.calls).toEqual([]);
    });

    test('a ZIP shows its progress and size, then the download starts by itself', async () => {
        const d = makeDialog({ mode: 'desktop', network: (url) => (url.includes('/tickets') ? ticket(600) : json(readyJob(3 * 1024 * 1024))) });
        d.sandbox.openSheetSave({ kind: 'zip', performanceId: 1, piece: '', part: '', title: 'C', count: 3 });
        await flush();
        expect(d.downloads).toEqual([{ href: '/api/sheets/tickets/t-600', download: '', target: undefined }]);
        expect(d.el('sheetSaveCount').textContent).toBe('3 件の楽譜・ZIP 3.0 MB');
        expect(d.el('sheetSaveStatus').textContent).toContain('ダウンロードを開始しました');
        expect(d.el('sheetSaveOpen').textContent).toBe('ダウンロード');
        expect(d.clicks).toEqual([]);
        d.el('sheetSaveOpen').listeners.click(); // download again
        expect(d.downloads).toHaveLength(2);
    });

    test('a recording ZIP shows its size, then downloads the stream URL', async () => {
        const d = makeDialog({ mode: 'desktop', network: () => json({ file_count: 2, missing_count: 0, total_bytes: 2048 }) });
        d.sandbox.openSheetSave({ kind: 'recording-zip', url: '/api/recordings/download-zip?date=d', infoUrl: '/api/recordings/download-zip/info?date=d', title: 'D' });
        await flush();
        expect(d.el('sheetSaveCount').textContent).toBe('2 件の録音・ZIP 約 2 KB');
        expect(d.downloads).toEqual([{ href: '/api/recordings/download-zip?date=d', download: '', target: undefined }]);
    });
});

describe('save dialog: device detection', () => {
    const mode = (navigatorExtra, standalone = false) => makeDialog({ mode: null, standalone, navigatorExtra, network: () => json({}) }).sandbox.portalSheetSave.mode();

    test.each([
        ['Windows Chrome (can share files)', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0', platform: 'Win32', maxTouchPoints: 0 }, 'desktop'],
        ['macOS Safari', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15', platform: 'MacIntel', maxTouchPoints: 0 }, 'desktop'],
        ['iPhone Safari', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', platform: 'iPhone', maxTouchPoints: 5 }, 'mobile'],
        ['iPad reporting a Mac', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15', platform: 'MacIntel', maxTouchPoints: 5 }, 'mobile'],
        ['Android Chrome', { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/130.0 Mobile', platform: 'Linux armv8l', maxTouchPoints: 5 }, 'mobile'],
        ['Client Hints mobile', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', userAgentData: { mobile: true } }, 'mobile'],
    ])('%s', (_name, nav, expected) => {
        expect(mode(nav)).toBe(expected);
    });

    test('a home-screen app is always mobile', () => {
        expect(mode({ userAgent: 'Mozilla/5.0 (Windows NT 10.0)' }, true)).toBe('mobile');
    });
});
