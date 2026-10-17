const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup(fetch) {
    const state = { currentUserMemberId: 1, currentUserPermission: '一般' };
    const cache = {
        getEntry: vi.fn(async () => ({ data: [{ id: 'stale' }], etag: 'old', timestamp: Date.now() })),
        set: vi.fn(), delete: vi.fn()
    };
    const sandbox = {
        fetch, AbortController, DOMException, setTimeout, clearTimeout, console,
        localStorage: { getItem: () => 'device' }, showAlert: vi.fn(),
        portalRuntimeContext: { appState: state, PORTAL_DEVICE_ID_KEY: 'device', dbCache: cache, inFlightGetRequests: new Map() }
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../src/static/js/modules/common_helpers/api_runtime.js'), 'utf8'), sandbox);
    return { sandbox, cache };
}

test('promotion refresh bypasses cached data and does not hide network failure', async () => {
    const fetch = vi.fn(async () => { throw new Error('offline'); });
    const { sandbox, cache } = setup(fetch);
    await expect(sandbox.request('/api/extra/promotions')).rejects.toThrow('offline');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(cache.getEntry).not.toHaveBeenCalled();
    expect(cache.set).not.toHaveBeenCalled();
});

test('operation polling exposes 202 and Retry-After without caching', async () => {
    const fetch = vi.fn(async () => ({ status: 202, ok: true, headers: { get: () => '2' }, json: async () => ({ state: 'processing' }) }));
    const { sandbox, cache } = setup(fetch);
    const response = await sandbox.request('/api/promotions/operations/key', { _structuredResult: true });
    expect(response.status).toBe(202);
    expect(response.retryAfter).toBe('2');
    expect(cache.getEntry).not.toHaveBeenCalled();
});

test('a response from a previous member is rejected', async () => {
    let resolve;
    const { sandbox } = setup(() => new Promise((done) => { resolve = done; }));
    const pending = sandbox.request('/api/extra/promotions');
    await new Promise((done) => setTimeout(done, 0));
    sandbox.portalRuntimeContext.appState.currentUserMemberId = 2;
    resolve({ status: 200, ok: true, headers: { get: () => null }, json: async () => [] });
    await expect(pending).rejects.toThrow('認証情報が変わりました');
});
