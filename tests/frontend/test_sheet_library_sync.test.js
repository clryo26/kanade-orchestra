// Sheet library synchronization (scores/sheet_api.js + scores/sync.js) with a
// fake network and fake timers. The list is checked only when a library tab is
// opened (no periodic or return checks). Real browser behaviour is in
// tests/e2e/sheet_library_reliability.spec.js; a real iPhone is not.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const dir = path.resolve(__dirname, '../../src/static/js/modules/scores');
const read = (name) => fs.readFileSync(path.join(dir, name), 'utf8');

function el(id) {
    return {
        id, hidden: false, offsetParent: {}, dataset: {}, innerHTML: '',
        querySelector: () => ({ textContent: '' }),
        querySelectorAll: () => [],
        addEventListener() {},
    };
}

function makeSync({ responses }) {
    const elements = { memberSheetTab: el('memberSheetTab'), memberSheetSync: el('memberSheetSync'), memberSheetInfo: el('memberSheetInfo') };
    elements.sheetAdminTab = Object.assign(el('sheetAdminTab'), { hidden: true, offsetParent: null });
    const appState = { portalAuthVerified: true, currentUserMemberId: 7, currentUserPermission: '一般', sheetLibrary: [], cloudRunRevision: 'rev-1' };
    const calls = [];
    const timers = [];
    const listeners = {};
    const renders = [];
    const sandbox = {
        console, Promise, Date, JSON, Math, Set, Number, Array, String, Object,
        setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
        clearTimeout: () => {},
        localStorage: { getItem: () => 'dev-1' },
        document: { visibilityState: 'visible', addEventListener: (t, fn) => { listeners[t] = fn; }, getElementById: (id) => elements[id] || null },
        window: {
            portalRuntimeContext: { appState, PORTAL_DEVICE_ID_KEY: 'device', getById: (id) => elements[id] || null },
            localStorage: { getItem: () => 'dev-1' },
            addEventListener: (t, fn) => { listeners[t] = fn; },
            scrollY: 0, scrollTo() {},
        },
        fetchWithTimeout: (url, init) => {
            calls.push({ url, init });
            const next = responses(url, calls.length, init);
            return Promise.resolve(next).then((r) => (r instanceof Error ? Promise.reject(r) : r));
        },
        renderSheetLibraryView: () => renders.push(appState.sheetLibrary.map((f) => f.id)),
        renderSheetAdminList: () => {},
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(read('sheet_api.js'), sandbox);
    vm.runInContext(read('sync.js'), sandbox);
    return { sandbox, appState, calls, timers, listeners, renders, elements };
}

const json = (data, status = 200) => ({
    status, ok: status < 400, headers: { get: (k) => (k === 'content-type' ? 'application/json' : null) }, json: async () => data,
});

describe('sheet library sync', () => {
    test('opening checks the server; an unchanged version does not fetch the list again', async () => {
        const { sandbox, appState, calls } = makeSync({
            responses: (url) => (url === '/api/sheets' ? json({ files: [{ id: 1 }], list_version: 3 }) : json({ list_version: 3, release: 'rev-1' })),
        });
        await sandbox.startSheetLibrarySync();
        expect(calls.map((c) => c.url)).toEqual(['/api/sheets']);
        expect(calls[0].init.cache).toBe('no-store');
        expect(calls[0].init.headers['X-Device-Id']).toBe('dev-1');
        expect(appState.sheetListVersion).toBe(3);
        await sandbox.startSheetLibrarySync(); // opened again
        expect(calls.map((c) => c.url)).toEqual(['/api/sheets', '/api/sheets/version']);
    });

    test('opening again after a change fetches the list; a forced refresh (own change) waits for the list', async () => {
        let version = 3;
        const { sandbox, appState, calls } = makeSync({
            responses: (url) => (url === '/api/sheets' ? json({ files: [{ id: version }], list_version: version }) : json({ list_version: version })),
        });
        await sandbox.startSheetLibrarySync();
        version = 4;
        await sandbox.startSheetLibrarySync();
        expect(appState.sheetLibrary).toEqual([{ id: 4 }]);
        const before = calls.length;
        const result = await sandbox.refreshSheetLibrary({ force: true, reason: 'delete' });
        expect(result).toMatchObject({ ok: true });
        expect(calls.slice(before).map((c) => c.url)).toEqual(['/api/sheets']); // forced: the list, not only the version
    });

    test('a slow older response never replaces a newer list', async () => {
        let resolveSlow;
        const { sandbox, appState } = makeSync({
            responses: (url, n) => {
                if (n === 1) return new Promise((resolve) => { resolveSlow = () => resolve(json({ files: [{ id: 'old' }], list_version: 5 })); });
                return json({ files: [{ id: 'new' }], list_version: 6 });
            },
        });
        const first = sandbox.refreshSheetLibrary({ force: true });
        const second = sandbox.refreshSheetLibrary({ force: true });
        await second;
        expect(appState.sheetLibrary).toEqual([{ id: 'new' }]);
        resolveSlow();
        await first;
        expect(appState.sheetLibrary).toEqual([{ id: 'new' }]);
        expect(appState.sheetListVersion).toBe(6);
    });

    test('a response for the previous account is dropped (logout / switch)', async () => {
        let release;
        const { sandbox, appState } = makeSync({
            responses: () => new Promise((resolve) => { release = () => resolve(json({ files: [{ id: 'private' }], list_version: 9 })); }),
        });
        const pending = sandbox.refreshSheetLibrary({ force: true });
        await Promise.resolve();
        appState.currentUserMemberId = 8; // another member signed in on this device
        release();
        const result = await pending;
        expect(result).toMatchObject({ ok: false, reason: 'account' });
        expect(appState.sheetLibrary).toEqual([]);
    });

    test('a failure keeps the shown list, is not a success and is shown (without a button)', async () => {
        let fail = false;
        const { sandbox, appState, elements } = makeSync({
            responses: (url) => (fail ? new Error('offline') : json({ files: [{ id: 1 }], list_version: 2 })),
        });
        await sandbox.startSheetLibrarySync();
        fail = true;
        const result = await sandbox.refreshSheetLibrary({ force: true, reason: 'delete' });
        expect(result.ok).toBe(false);
        expect(appState.sheetLibrary).toEqual([{ id: 1 }]);
        expect(elements.memberSheetSync.innerHTML).toContain('sheet-sync-error');
        expect(elements.memberSheetSync.innerHTML).not.toContain('<button');
        expect(sandbox.portalSheetSync.state.lastError).toBe('通信できませんでした');
    });

    test('the list is checked only when the library is opened: no periodic check, no 更新 button', async () => {
        const { sandbox, timers, listeners, calls, elements } = makeSync({ responses: () => json({ files: [], list_version: 1 }) });
        await sandbox.startSheetLibrarySync();
        expect(calls).toHaveLength(1);
        expect(timers).toEqual([]); // nothing scheduled while the tab stays open
        expect(Object.keys(listeners)).toEqual([]); // no re-check on visibility / pageshow / online
        expect(elements.memberSheetSync.innerHTML).toBe(''); // no button, no "last checked" line
    });

    test('a newer server release is shown as a notice, never as a reload', async () => {
        const { sandbox, elements } = makeSync({
            responses: (url) => (url === '/api/sheets' ? json({ files: [], list_version: 1 }) : json({ list_version: 1, release: 'rev-2' })),
        });
        await sandbox.startSheetLibrarySync();
        await sandbox.startSheetLibrarySync(); // opened again: the version check carries the release
        expect(sandbox.portalSheetSync.state.notice).toContain('新しい版');
        expect(elements.memberSheetSync.innerHTML).toContain('sheet-sync-notice');
    });

    test('open sections stay open over an update', () => {
        const { sandbox, elements, appState } = makeSync({ responses: () => json({}) });
        const open = { dataset: { sheetKey: 'p:1' }, open: true };
        const closed = { dataset: { sheetKey: 'p:2' }, open: false };
        const container = elements.memberSheetInfo;
        container.dataset.rendered = '1';
        container.querySelectorAll = () => [open, closed];
        sandbox.renderSheetLibraryView = () => { open.open = false; closed.open = true; }; // a re-render resets them
        sandbox.portalSheetSync.apply({ files: [], list_version: 1 }, 1);
        expect([open.open, closed.open]).toEqual([true, false]);
        expect(appState.sheetListVersion).toBe(1);
    });
});

describe('sheet library sync after a DB restore or sync', () => {
    test('a server version below the shown one is taken as a reset, not ignored forever', async () => {
        let version = 50;
        const { sandbox, appState } = makeSync({
            responses: (url) => (url === '/api/sheets' ? json({ files: [{ id: version }], list_version: version }) : json({ list_version: version })),
        });
        await sandbox.startSheetLibrarySync();
        expect(appState.sheetListVersion).toBe(50);
        version = 3; // the test environment was synchronized from production
        await sandbox.startSheetLibrarySync();
        expect(appState.sheetListVersion).toBe(3);
        expect(appState.sheetLibrary).toEqual([{ id: 3 }]);
    });
});
