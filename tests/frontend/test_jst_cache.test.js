const fs = require('node:fs');
const vm = require('node:vm');
const { IDBFactory } = require('fake-indexeddb');

function sandbox() {
    const ctx = { indexedDB: new IDBFactory(), setTimeout, localStorage: { getItem: () => 'device' } };
    ctx.window = ctx;
    ctx.portalRuntimeContext = { appState: { currentUserMemberId: 1, currentUserPermission: '一般' } };
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync('src/static/js/utils/cache.js', 'utf8'), ctx);
    return ctx;
}

test('old representation has no payload/ETag, current data is partitioned by account', async () => {
    const ctx = sandbox(); const cache = ctx.portalCacheState.dbCache;
    await cache.init();
    const key = `${ctx.portalCacheIdentity()}:/api/events`;
    await new Promise((resolve, reject) => {
        const tx = cache.db.transaction('bootstrap_cache', 'readwrite');
        tx.objectStore('bootstrap_cache').put({ key, data: ['old'], etag: 'utc', timestamp: Date.now() });
        tx.oncomplete = resolve; tx.onerror = reject;
    });
    expect(await cache.getEntry('/api/events')).toMatchObject({ invalid: true, data: null, etag: null });
    await cache.set('/api/events', ['jst'], 'jst-tag');
    expect(await cache.get('/api/events')).toEqual(['jst']);
    ctx.portalRuntimeContext.appState.currentUserMemberId = 2;
    expect(await cache.getEntry('/api/events')).toBeNull();
    ctx.portalRuntimeContext.appState.currentUserMemberId = 1;
    expect(await cache.get('/api/events')).toEqual(['jst']);
    ctx.PORTAL_DATETIME_REPRESENTATION = 'next-format';
    expect(await cache.getEntry('/api/events')).toBeNull();
    cache.db.close();
});

test('a GET started before a mutation cannot restore the old cache', async () => {
    let finish;
    const response = new Promise((resolve) => { finish = resolve; });
    const ctx = {
        console, setTimeout, clearTimeout, AbortController,
        localStorage: { getItem: () => 'device' },
        showAlert() {}, fetch: () => response,
    };
    ctx.window = ctx;
    ctx.portalRuntimeContext = { appState: {}, PORTAL_DEVICE_ID_KEY: 'device', inFlightGetRequests: new Map(),
        dbCache: { getEntry: async () => null, set: vi.fn(), delete: async () => {} } };
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync('src/static/js/modules/common_helpers/api_runtime.js', 'utf8'), ctx);
    const pending = ctx.request('/api/events');
    await Promise.resolve(); await Promise.resolve();
    await ctx.invalidateCacheForMutation('/api/events');
    finish({ status: 200, ok: true, headers: { get: (k) => k === 'content-type' ? 'application/json' : 'old' }, json: async () => ['stale'] });
    await expect(pending).rejects.toThrow('表示情報が更新されました');
    expect(ctx.portalRuntimeContext.dbCache.set).not.toHaveBeenCalled();
});
