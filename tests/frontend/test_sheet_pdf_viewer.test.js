// The PDF viewer with a fake PDF.js (logic only). The real PDF.js with real
// PDF files in a real browser is tests/e2e/sheet_library_reliability.spec.js.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.resolve(__dirname, '../../src/static/js/modules/scores/pdf_viewer.js'), 'utf8');

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

function element(id) {
    const el = {
        id, textContent: '', innerHTML: '', children: [], clientWidth: 600, dataset: {},
        listeners: {},
        appendChild(child) { this.children.push(child); return child; },
        addEventListener(type, fn) { this.listeners[type] = fn; },
        querySelectorAll(selector) { return selector === 'canvas' ? this.children.flatMap((c) => c.canvases || []) : []; },
    };
    Object.defineProperty(el, 'innerHTML', {
        get() { return this._html || ''; },
        set(value) { this._html = value; if (value === '') this.children = []; },
    });
    return el;
}

function makeViewer({ fetchImpl, pdfjs } = {}) {
    const elements = { sheetViewerPages: element('sheetViewerPages'), sheetViewerStatus: element('sheetViewerStatus') };
    const appState = {};
    const created = [];
    const document = {
        head: { appendChild: (script) => { created.push(script.src); setTimeout(() => script.listeners.load?.(), 0); } },
        getElementById: (id) => elements[id] || null,
        createElement: (tag) => {
            if (tag === 'canvas') {
                const canvas = { width: 0, height: 0, style: {}, getContext: () => ({}) };
                return canvas;
            }
            if (tag === 'section') {
                const section = element('page');
                section.canvases = [];
                section.appendChild = function (child) { if ('getContext' in child) this.canvases.push(child); return child; };
                return section;
            }
            const node = element(tag);
            node.remove = () => {};
            return node;
        },
    };
    const sandbox = {
        console, setTimeout, Promise, Set, Math,
        AbortController,
        document,
        window: { portalRuntimeContext: { appState, getById: (id) => elements[id] || null }, innerWidth: 600, devicePixelRatio: 1 },
        portalSheetApi: { deviceId: () => 'dev-1' },
        fetchWithTimeout: fetchImpl,
        PORTAL_TIMEOUT_GET: 15000,
    };
    if (pdfjs) sandbox.window.pdfjsLib = pdfjs;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(SOURCE, sandbox);
    return { sandbox, elements, appState, created };
}

// A fake PDF.js whose documents and render tasks are controlled by the test.
function fakePdfjs({ pages = 2, renderGate = null, openError = null } = {}) {
    const log = { opened: 0, destroyed: 0, rendered: [], cancelled: 0 };
    const lib = {
        GlobalWorkerOptions: {},
        getDocument: () => {
            log.opened += 1;
            const pdf = {
                numPages: pages,
                destroy: () => { log.destroyed += 1; },
                getPage: async (n) => ({
                    getViewport: ({ scale }) => ({ width: 100 * scale, height: 140 * scale }),
                    render: () => {
                        let cancelled = false;
                        const gate = renderGate ? renderGate() : Promise.resolve();
                        return {
                            cancel: () => { cancelled = true; log.cancelled += 1; },
                            promise: gate.then(() => {
                                if (cancelled) throw Object.assign(new Error('cancelled'), { name: 'RenderingCancelledException' });
                                log.rendered.push(n);
                            }),
                        };
                    },
                }),
            };
            return { promise: openError ? Promise.reject(openError) : Promise.resolve(pdf), destroy: () => { log.destroyed += 1; } };
        },
    };
    return { lib, log };
}

const okResponse = () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) });
const flush = async (n = 30) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0)); };

describe('sheet PDF viewer', () => {
    test('a newer request wins: the slow older fetch never draws pages', async () => {
        const slow = deferred();
        const calls = [];
        const pdf = fakePdfjs({ pages: 1 });
        const { sandbox, log = pdf.log } = makeViewer({
            pdfjs: pdf.lib,
            fetchImpl: (url, init) => { calls.push({ url, headers: init.headers, signal: init.signal }); return url === '/a.pdf' ? slow.promise : Promise.resolve(okResponse()); },
        });
        const a = sandbox.renderPdfViewer('/a.pdf');
        await flush();
        const b = sandbox.renderPdfViewer('/b.pdf');
        await b;
        expect(calls[0].signal.aborted).toBe(true); // the old fetch was stopped
        expect(calls[0].headers['X-Device-Id']).toBe('dev-1');
        slow.resolve(okResponse());
        await a;
        expect(log.opened).toBe(1); // only b was opened
        expect(sandbox.window.portalRuntimeContext.appState.sheetPdfUrl).toBe('/b.pdf');
    });

    test('zoom re-renders the same document without fetching again and cancels unfinished pages', async () => {
        let gate = null;
        const pdf = fakePdfjs({ pages: 3, renderGate: () => (gate ? gate.promise : Promise.resolve()) });
        let fetches = 0;
        const { sandbox, elements } = makeViewer({ pdfjs: pdf.lib, fetchImpl: async () => { fetches += 1; return okResponse(); } });
        await sandbox.renderPdfViewer('/a.pdf');
        expect(pdf.log.rendered).toEqual([1, 2, 3]);
        gate = deferred();
        const zoomA = sandbox.zoomSheetViewer(0.15);
        await flush();
        const zoomB = sandbox.zoomSheetViewer(0.15); // pressed again while page 1 renders
        await flush();
        expect(pdf.log.cancelled).toBeGreaterThanOrEqual(1);
        gate.resolve();
        await Promise.all([zoomA, zoomB]);
        expect(fetches).toBe(1);
        expect(pdf.log.opened).toBe(1);
        expect(elements.sheetViewerStatus.textContent).toBe('3ページ');
    });

    test('closing releases the document, the render tasks and the canvas memory', async () => {
        const pdf = fakePdfjs({ pages: 2 });
        const { sandbox, elements, appState } = makeViewer({ pdfjs: pdf.lib, fetchImpl: async () => okResponse() });
        await sandbox.renderPdfViewer('/a.pdf');
        const canvases = elements.sheetViewerPages.children.flatMap((c) => c.canvases);
        expect(canvases.length).toBe(2);
        sandbox.clearSheetViewer();
        expect(pdf.log.destroyed).toBe(1);
        expect(canvases.every((c) => c.width === 0 && c.height === 0)).toBe(true);
        expect(elements.sheetViewerPages.children).toEqual([]);
        expect(appState.sheetPdfUrl).toBe('');
    });

    test.each([
        ['fetch', { fetch: async () => ({ ok: false, status: 404 }) }, '楽譜が見つかりません'],
        ['network', { fetch: async () => { throw new Error('offline'); } }, 'PDFを取得できませんでした'],
        ['corrupt', { openError: Object.assign(new Error('Invalid PDF structure'), { name: 'InvalidPDFException' }) }, 'PDFファイルが壊れているか'],
    ])('%s failure is told apart and offers a retry', async (_name, setup, text) => {
        const pdf = fakePdfjs({ openError: setup.openError });
        const { sandbox, elements } = makeViewer({ pdfjs: pdf.lib, fetchImpl: setup.fetch || (async () => okResponse()) });
        await sandbox.renderPdfViewer('/a.pdf');
        expect(elements.sheetViewerStatus.textContent).toContain(text);
        expect(elements.sheetViewerStatus.children.map((c) => c.id)).toEqual(['sheetViewerRetry']);
    });

    test('render failure keeps the document for a retry and is reported as such', async () => {
        const pdf = fakePdfjs({ pages: 1, renderGate: () => Promise.reject(new Error('canvas lost')) });
        const { sandbox, elements } = makeViewer({ pdfjs: pdf.lib, fetchImpl: async () => okResponse() });
        await sandbox.renderPdfViewer('/a.pdf');
        expect(elements.sheetViewerStatus.textContent).toContain('PDFを描画できませんでした');
    });

    // Loading, versions and safe options: test_sheet_pdfjs_security.test.js.
});
