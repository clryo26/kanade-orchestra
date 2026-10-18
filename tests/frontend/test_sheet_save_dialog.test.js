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

function makeDialog({ canShare = true, standalone = false, limits = { pdf: 1024, zip: 1024 }, network }) {
    const elements = {};
    let inserted = false;
    const clicks = [];
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
            if (tag === 'a') return { tag, click() { clicks.push(this.href); }, remove() {} };
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
                share: async (data) => { shared.push(data.files.map((f) => ({ name: f.name, size: f.size }))); },
            },
            localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        },
        portalSheetSaveLimits: limits,
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
    return { sandbox, el, clicks, calls, shared, appState };
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
