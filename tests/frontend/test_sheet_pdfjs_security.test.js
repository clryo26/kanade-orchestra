// PDF.js version and safe options (review finding 1, CVE-2024-4367 /
// GHSA-wgrm-67xf-hhpq: affected <= 4.1.392, patched 4.2.67; workaround
// isEvalSupported: false). Logic level with a fake PDF.js module; the real
// library in a real browser is tests/e2e/sheet_library_reliability.spec.js.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '../..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'src/static/js/modules/scores/pdf_viewer.js'), 'utf8');
const VERSION = '4.10.38';
const LOCAL = `/static/vendor/pdfjs/${VERSION}/`;
const CDN = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${VERSION}/legacy/build/`;

function el() {
    return { children: [], textContent: '', clientWidth: 600, appendChild(c) { this.children.push(c); return c; }, querySelectorAll: () => [], addEventListener() {} };
}

function fakeModule(version, calls, { openError } = {}) {
    return {
        version,
        GlobalWorkerOptions: {},
        getDocument(options) {
            calls.push(options);
            return {
                promise: openError ? Promise.reject(openError) : Promise.resolve({
                    numPages: 1,
                    destroy() {},
                    getPage: async () => ({
                        getViewport: ({ scale }) => ({ width: 100 * scale, height: 100 * scale }),
                        render: () => ({ cancel() {}, promise: Promise.resolve() }),
                    }),
                }),
                destroy() {},
            };
        },
    };
}

function makeViewer({ modules, preset } = {}) {
    const elements = { sheetViewerPages: el(), sheetViewerStatus: el() };
    Object.defineProperty(elements.sheetViewerPages, 'innerHTML', { set(v) { if (v === '') this.children = []; }, get() { return ''; } });
    const imported = [];
    const sandbox = {
        console, setTimeout, Promise, Set, Math, AbortController,
        document: {
            getElementById: (id) => elements[id] || null,
            createElement: (tag) => (tag === 'canvas' ? { style: {}, getContext: () => ({}) } : Object.assign(el(), { canvases: [] })),
        },
        window: { portalRuntimeContext: { appState: {}, getById: (id) => elements[id] || null }, innerWidth: 600, devicePixelRatio: 1 },
        portalSheetApi: { deviceId: () => 'dev-1' },
        fetchWithTimeout: async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) }),
        PORTAL_TIMEOUT_GET: 15000,
        // Test seam for import(): vm scripts cannot import real modules.
        portalPdfViewerImport: async (url) => {
            imported.push(url);
            if (!(url in modules)) throw new Error('404 ' + url);
            return modules[url];
        },
    };
    if (preset) sandbox.window.pdfjsLib = preset;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(SOURCE, sandbox);
    return { sandbox, elements, imported };
}

describe('PDF.js version and safe settings', () => {
    test('the portal copy of the patched version is imported first; the worker comes from the same place', async () => {
        const calls = [];
        const { sandbox, imported } = makeViewer({ modules: { [`${LOCAL}pdf.min.mjs`]: fakeModule(VERSION, calls) } });
        const lib = await sandbox.loadPdfJs();
        expect(imported).toEqual([`${LOCAL}pdf.min.mjs`]);
        expect(lib.GlobalWorkerOptions.workerSrc).toBe(`${LOCAL}pdf.worker.min.mjs`);
        expect(sandbox.portalPdfViewer.version).toBe(VERSION);
    });

    test('every document is opened with isEvalSupported: false (also from the fallback source)', async () => {
        const calls = [];
        const { sandbox, imported, elements } = makeViewer({ modules: { [`${CDN}pdf.min.mjs`]: fakeModule(VERSION, calls) } });
        await sandbox.renderPdfViewer('/a.pdf');
        expect(imported).toEqual([`${LOCAL}pdf.min.mjs`, `${CDN}pdf.min.mjs`]);
        expect(calls).toHaveLength(1);
        expect(calls[0].isEvalSupported).toBe(false);
        expect(calls[0].data).toBeInstanceOf(ArrayBuffer);
        expect(elements.sheetViewerStatus.textContent).toBe('1ページ');
    });

    test('a module of another version is refused and the next source is tried', async () => {
        const calls = [];
        const { sandbox, imported } = makeViewer({
            modules: { [`${LOCAL}pdf.min.mjs`]: fakeModule('3.11.174', calls), [`${CDN}pdf.min.mjs`]: fakeModule(VERSION, calls) },
        });
        const lib = await sandbox.loadPdfJs();
        expect(lib.version).toBe(VERSION);
        expect(imported).toEqual([`${LOCAL}pdf.min.mjs`, `${CDN}pdf.min.mjs`]);
        expect(lib.GlobalWorkerOptions.workerSrc).toBe(`${CDN}pdf.worker.min.mjs`);
    });

    test('an old PDF.js already on the page is not used', async () => {
        const calls = [];
        const old = fakeModule('3.11.174', calls);
        const { sandbox } = makeViewer({ preset: old, modules: { [`${LOCAL}pdf.min.mjs`]: fakeModule(VERSION, calls) } });
        const lib = await sandbox.loadPdfJs();
        expect(lib).not.toBe(old);
        expect(lib.version).toBe(VERSION);
    });

    test('a worker of another version is reported as a library problem, not as a broken PDF', async () => {
        const calls = [];
        const mismatch = new Error('The API version "4.10.38" does not match the Worker version "3.11.174".');
        const { sandbox, elements } = makeViewer({ modules: { [`${LOCAL}pdf.min.mjs`]: fakeModule(VERSION, calls, { openError: mismatch }) } });
        await sandbox.renderPdfViewer('/a.pdf');
        expect(elements.sheetViewerStatus.textContent).toContain('PDFを表示する部品');
        expect(elements.sheetViewerStatus.textContent).not.toContain('壊れている');
    });

    test('no source available: a library error with retry', async () => {
        const { sandbox, elements } = makeViewer({ modules: {} });
        await sandbox.renderPdfViewer('/a.pdf');
        expect(elements.sheetViewerStatus.textContent).toContain('PDFを表示する部品を読み込めませんでした');
        expect(elements.sheetViewerStatus.children.map((c) => c.id)).toEqual(['sheetViewerRetry']);
    });

    test('the vendored library and worker are the patched version, unchanged from the npm package, and documented', () => {
        const dir = path.join(ROOT, 'src/static/vendor/pdfjs', VERSION);
        const lib = fs.readFileSync(path.join(dir, 'pdf.min.mjs'), 'utf8');
        const worker = fs.readFileSync(path.join(dir, 'pdf.worker.min.mjs'), 'utf8');
        expect(lib).toContain(`"${VERSION}"`);
        expect(worker).toContain(`"${VERSION}"`);
        expect(fs.existsSync(path.join(ROOT, 'src/static/vendor/pdfjs/3.11.174'))).toBe(false);
        const readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
        expect(readme).toContain('CVE-2024-4367');
        expect(readme).toContain('isEvalSupported');
        expect(fs.readFileSync(path.join(dir, 'LICENSE'), 'utf8')).toContain('Apache License');
    });
});
