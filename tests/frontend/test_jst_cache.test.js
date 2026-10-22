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

test('validation timestamps round-trip through IndexedDB, including older entries', async () => {
    const ctx = sandbox();
    const cache = ctx.portalCacheState.dbCache;
    await cache.init();
    const oldTime = 1000;
    const key = `${ctx.portalCacheIdentity()}:/api/events`;
    await new Promise((resolve, reject) => {
        const tx = cache.db.transaction('bootstrap_cache', 'readwrite');
        tx.objectStore('bootstrap_cache').put({ key, data: [], etag: 'old',
            representation: ctx.PORTAL_DATETIME_REPRESENTATION, timestamp: oldTime });
        tx.oncomplete = resolve; tx.onerror = reject;
    });
    expect((await cache.getEntry('/api/events')).validatedAt).toBe(oldTime);
    await cache.set('/api/events', [], 'validated');
    const entry = await cache.getEntry('/api/events');
    expect(entry.data).toEqual([]);
    expect(entry.etag).toBe('validated');
    expect(entry.validatedAt).toBeGreaterThan(oldTime);
    expect(entry.timestamp).toBe(entry.validatedAt);
    cache.db.close();
});

test('failed deletion blocks only the invalidated account/key until a fresh write commits', async () => {
    const ctx = sandbox(); const cache = ctx.portalCacheState.dbCache;
    await cache.init();
    await cache.set('/api/events', ['old'], 'old-tag');
    await cache.set('/api/members', ['unrelated'], 'member-tag');
    cache.db.close();
    await expect(cache.delete('/api/events')).rejects.toThrow();
    await cache.init();
    // The failed delete really left a record on disk; it must not be reused.
    const stored = await new Promise((resolve) => {
        const request = cache.db.transaction('bootstrap_cache').objectStore('bootstrap_cache').get(`${ctx.portalCacheIdentity()}:/api/events`);
        request.onsuccess = () => resolve(request.result);
    });
    expect(stored.data).toEqual(['old']);
    expect(await cache.getEntry('/api/events')).toBeNull();
    expect(cache.getETag('/api/events')).toBeUndefined();
    expect(await cache.get('/api/members')).toEqual(['unrelated']);
    ctx.portalRuntimeContext.appState.currentUserMemberId = 2;
    await cache.set('/api/events', ['other-account'], 'other-tag');
    expect(await cache.get('/api/events')).toEqual(['other-account']);
    ctx.portalRuntimeContext.appState.currentUserMemberId = 1;
    expect(await cache.get('/api/events')).toBeNull();
    await Promise.all([
        cache.set('/api/events', ['intermediate'], 'intermediate-tag'),
        cache.set('/api/events', ['fresh'], 'fresh-tag'),
    ]);
    expect(await cache.get('/api/events')).toEqual(['fresh']);
    expect(cache.getETag('/api/events')).toBe('fresh-tag');
    cache.db.close();
});

test('an older cache write completing after invalidation cannot unblock the old payload', async () => {
    const ctx = sandbox(); const cache = ctx.portalCacheState.dbCache;
    await cache.init();
    const oldWrite = cache.set('/api/events', ['old'], 'old-tag');
    cache.db.close(); // Pending transaction may finish, but new deletes reject.
    await expect(cache.delete('/api/events')).rejects.toThrow();
    await oldWrite;
    await cache.init();
    expect(await cache.get('/api/events')).toBeNull();
    expect(cache.getETag('/api/events')).toBeUndefined();
    await cache.set('/api/events', ['fresh'], 'fresh-tag');
    expect(await cache.get('/api/events')).toEqual(['fresh']);
    cache.db.close();
});

test('a GET whose cache write overlaps a mutation does not return its old response', async () => {
    let finishWrite;
    let enteredWrite;
    const entered = new Promise((resolve) => { enteredWrite = resolve; });
    const ctx = { console, setTimeout, clearTimeout, AbortController, localStorage: { getItem: () => 'device' },
        showAlert() {}, fetch: async () => new Response('["old"]', { headers: { 'Content-Type': 'application/json', ETag: 'old' } }) };
    ctx.window = ctx;
    ctx.portalRuntimeContext = { appState: {}, PORTAL_DEVICE_ID_KEY: 'device', inFlightGetRequests: new Map(),
        dbCache: { getEntry: async () => null, delete: async () => {},
            set: () => { enteredWrite(); return new Promise((resolve) => { finishWrite = resolve; }); } } };
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync('src/static/js/modules/common_helpers/api_runtime.js', 'utf8'), ctx);
    const pending = ctx.request('/api/events');
    await entered;
    await ctx.invalidateCacheForMutation('/api/events');
    finishWrite();
    await expect(pending).rejects.toThrow('表示情報が更新されました');
});
