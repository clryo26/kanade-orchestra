// Registering several PDFs (scores/upload_batch.js): fixed operation IDs,
// resume after a lost answer or a reload, and cancel (logic level).
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const dir = path.resolve(__dirname, '../../src/static/js/modules/scores');
const read = (name) => fs.readFileSync(path.join(dir, name), 'utf8');

class FakeFile {
    constructor(name, text) {
        this.name = name;
        this.type = 'application/pdf';
        this.data = new TextEncoder().encode(text);
        this.size = this.data.length;
        this.lastModified = 1;
    }
    async arrayBuffer() { return this.data.buffer.slice(0); }
}

function makeBatch({ answer }) {
    const store = new Map();
    const sent = [];
    const statuses = [];
    const elements = {
        sheetPerformanceSelect: { value: '1' },
        sheetPieceSelect: { value: 'Sym' },
        sheetFileInput: { files: [], value: '' },
        sheetUploadResume: { innerHTML: '', hidden: true, querySelector: () => ({ textContent: '', appendChild() {}, addEventListener() {}, files: [] }) },
    };
    const appState = { portalAuthVerified: true, currentUserMemberId: null, currentUserPermission: 'システム管理者', performances: [{ id: 1, title: 'Concert' }] };
    const sandbox = {
        console, Promise, JSON, Math, Array, String, Object, Uint8Array, TextEncoder, FormData: class { constructor() { this.fields = {}; } append(k, v) { this.fields[k] = v; } },
        crypto: webcrypto,
        setTimeout: (fn) => { fn(); return 1; },
        localStorage: { getItem: (k) => (k === 'device' ? 'dev-1' : store.get(k) ?? null), setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) },
        document: { getElementById: (id) => elements[id] || null, createElement: () => ({}) },
        window: {
            portalRuntimeContext: { appState, PORTAL_DEVICE_ID_KEY: 'device', getById: (id) => elements[id] || null },
            localStorage: null, crypto: webcrypto, confirm: () => true,
        },
        showAlert: () => {},
        setOperationStatus: (_id, text) => statuses.push(text),
        refreshSheetLibrary: async () => ({ ok: true }),
        withButtonStatus: (_b, _l, fn) => fn(),
        fetchWithTimeout: async (url, init) => {
            const key = init.headers['Idempotency-Key'];
            sent.push({ url, method: init.method, key, name: init.body.fields.file.name });
            const r = await answer({ key, name: init.body.fields.file.name, count: sent.length });
            if (r instanceof Error) throw r;
            return { status: r.status, headers: { get: () => 'application/json' }, json: async () => r.body };
        },
    };
    sandbox.window.localStorage = sandbox.localStorage;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(read('sheet_api.js'), sandbox);
    vm.runInContext(read('upload_batch.js'), sandbox);
    return { sandbox, sent, store, statuses, elements };
}

const done = (name, id) => ({ status: 200, body: { file: { id, name }, list_version: id } });

describe('sheet upload batch', () => {
    test('each file keeps one operation ID; after a lost answer the resume resends the same ID', async () => {
        const seen = new Map();
        let lose = true;
        const { sandbox, sent, elements } = makeBatch({
            answer: async ({ key, name }) => {
                if (name === 'b.pdf' && lose) { lose = false; seen.set(key, 'b'); return new Error('connection lost'); }
                return done(name, sent.length);
            },
        });
        const a = new FakeFile('a.pdf', '%PDF-a');
        const b = new FakeFile('b.pdf', '%PDF-b');
        const c = new FakeFile('c.pdf', '%PDF-c');
        elements.sheetFileInput.files = [a, b, c];
        await sandbox.uploadSheets();
        expect(sent.map((s) => s.name)).toEqual(['a.pdf', 'b.pdf']); // stopped at the unknown result
        const batch = sandbox.portalSheetUpload.load();
        expect(batch.items.map((i) => i.state)).toEqual(['done', 'unknown', 'pending']);
        expect(batch.items.every((i) => /^[0-9a-f-]{36}$/.test(i.operationId))).toBe(true);
        const bKey = batch.items[1].operationId;
        // After a reload: the files are selected again and checked.
        await sandbox.portalSheetUpload.resumeWith([b, c]);
        expect(sent.slice(2).map((s) => [s.name, s.key])).toEqual([['b.pdf', bKey], ['c.pdf', batch.items[2].operationId]]);
        expect(sandbox.portalSheetUpload.load()).toBeNull(); // finished: nothing left to resume
        expect(sent.every((s) => s.method === 'POST')).toBe(true); // nothing was ever deleted
    });

    test('a reselected file with different content is not used for the stored ID', async () => {
        const { sandbox, sent, elements } = makeBatch({ answer: async () => new Error('offline') });
        elements.sheetFileInput.files = [new FakeFile('a.pdf', '%PDF-original')];
        await sandbox.uploadSheets();
        const before = sent.length;
        await sandbox.portalSheetUpload.resumeWith([new FakeFile('a.pdf', '%PDF-0ther!!')]); // same name and size
        expect(sent.length).toBe(before);
        expect(sandbox.portalSheetUpload.load().items[0].state).toBe('unknown');
    });

    test('cancel stops the files not sent yet and keeps the registered ones', async () => {
        let sandboxRef;
        const { sandbox, sent, elements, statuses } = makeBatch({
            answer: async ({ name }) => {
                if (name === 'a.pdf') sandboxRef.cancelSheetUpload();
                return done(name, 1);
            },
        });
        sandboxRef = sandbox;
        elements.sheetFileInput.files = [new FakeFile('a.pdf', '%PDF-a'), new FakeFile('b.pdf', '%PDF-b')];
        await sandbox.uploadSheets();
        expect(sent.map((s) => s.name)).toEqual(['a.pdf']);
        expect(statuses.at(-1)).toContain('中止しました');
        expect(statuses.at(-1)).toContain('登録済みの楽譜は残っています');
        expect(sandbox.portalSheetUpload.load().items.map((i) => i.state)).toEqual(['done', 'pending']);
    });

    test('a refused file (not a PDF) is reported and the others continue', async () => {
        const { sandbox, sent, elements, statuses } = makeBatch({
            answer: async ({ name }) => (name === 'bad.pdf'
                ? { status: 415, body: { detail: { code: 'sheet_not_pdf', message: 'PDFファイルとして読み取れません' } } }
                : done(name, 1)),
        });
        elements.sheetFileInput.files = [new FakeFile('bad.pdf', 'nope'), new FakeFile('ok.pdf', '%PDF-ok')];
        await sandbox.uploadSheets();
        expect(sent.map((s) => s.name)).toEqual(['bad.pdf', 'ok.pdf']);
        expect(statuses.at(-1)).toContain('bad.pdf（PDFファイルとして読み取れません）');
        expect(sandbox.portalSheetUpload.load()).toBeNull();
    });
});
