const { createCacheHarness } = require('./helpers/portal_cache_harness.cjs');
const DAY = 86400000;
const caches = [];
async function harness() { const h = createCacheHarness(); await h.cache.init(); caches.push(h.cache); return h; }
afterEach(() => caches.splice(0).forEach(cache => cache.db.close()));

test('legacy timestamp expiration, unknown times, future access and count limits', async () => {
    const h = await harness(); const now = Date.now();
    await h.seed([
        { key: '/api/expired', timestamp: now - 8 * DAY },
        { key: '/api/valid', timestamp: now, validatedAt: now - 20 * DAY },
        { key: '/api/unknown', timestamp: 'invalid' },
        { key: '/api/future', lastAccessAt: now + DAY, timestamp: now - 8 * DAY },
    ]);
    expect((await h.cache.cleanup()).deleted).toBe(2);
    expect((await h.records()).map(e => e.key)).toEqual([h.fullKey('/api/unknown'), h.fullKey('/api/valid')]);
    await h.seed(Array.from({ length: 205 }, (_, i) => ({ key: `/api/x${String(i).padStart(3, '0')}`, timestamp: now - i * 1000 })));
    expect((await h.cache.cleanup()).remaining).toBe(200);
    expect(await h.read('/api/unknown')).toBeUndefined();
});

test('byte cap and oversized network responses do not leave reusable old payloads', async () => {
    const h = await harness();
    await h.seed([{ key: '/api/a', approximateBytes: 12 * 1024 * 1024 }, { key: '/api/b', approximateBytes: 12 * 1024 * 1024 }]);
    expect((await h.cache.cleanup()).remaining).toBe(1);
    await h.cache.set('/api/large', ['old'], 'old');
    await h.cache.set('/api/large', 'x'.repeat(11 * 1024 * 1024), 'too-big');
    expect(await h.cache.get('/api/large')).toBeNull();
    expect(await h.read('/api/large')).toBeUndefined();
});

test('touch is metadata-only and writes at most hourly, with one initial legacy update', async () => {
    const h = await harness();
    await h.seed([{ key: '/api/events', timestamp: 1000, validatedAt: 2000, etag: 'keep', data: ['keep'] }]);
    await h.cache.touchAccess(h.fullKey('/api/events'));
    const first = await h.read('/api/events');
    expect(first).toMatchObject({ timestamp: 1000, validatedAt: 2000, etag: 'keep', data: ['keep'] });
    await h.cache.touchAccess(h.fullKey('/api/events'));
    expect((await h.read('/api/events')).lastAccessAt).toBe(first.lastAccessAt);
    await h.seed([{ ...first, key: '/api/events', lastAccessAt: Date.now() - 3600001 }]);
    await h.cache.touchAccess(h.fullKey('/api/events'));
    expect((await h.read('/api/events')).lastAccessAt).toBeGreaterThan(first.lastAccessAt - 3600000);
});

test('cleanup rechecks candidates after another writer updates a scanned record', async () => {
    const h = await harness();
    await h.seed([{ key: '/api/events', timestamp: Date.now() - 8 * DAY, data: ['old'] }]);
    const scan = h.cache.scanCleanupRecords.bind(h.cache);
    h.cache.scanCleanupRecords = async () => {
        const candidates = await scan();
        await h.cache.set('/api/events', ['new'], 'new');
        return candidates;
    };
    expect((await h.cache.cleanup()).deleted).toBe(0);
    expect((await h.read('/api/events')).data).toEqual(['new']);
});

test('a touch queued behind deletion cannot resurrect a record or clear invalidation', async () => {
    const h = await harness();
    await h.cache.set('/api/events', ['old'], 'old');
    const deletion = h.cache.delete('/api/events');
    await h.cache.touchAccess(h.fullKey('/api/events')); await deletion;
    expect(await h.read('/api/events')).toBeUndefined();
    expect(h.cache.invalidatedKeys.has(h.fullKey('/api/events'))).toBe(true);
    await h.cache.set('/api/events', ['fresh'], 'fresh');
    const fresh = await h.read('/api/events');
    await h.cache.touchAccess(h.fullKey('/api/events'));
    expect(await h.read('/api/events')).toEqual(fresh);
});

test('legacy malformed keys are disposable but unknown-time valid keys are not aged out', async () => {
    const h = await harness();
    await h.store('readwrite', s => s.put({ key: 'old-unpartitioned', data: ['legacy'] }));
    await h.seed([{ key: '/api/unknown', timestamp: null }]);
    expect((await h.cache.cleanup()).deleted).toBe(1);
    expect(await h.read('/api/unknown')).toBeDefined();
});

test('identity mismatch retires records only after the session is confirmed', async () => {
    const h = await harness(); const now = Date.now();
    const state = h.ctx.portalRuntimeContext.appState;
    // A valid record of this device and member, saved during a verified session.
    await h.seed([{ key: '/api/events', timestamp: now, data: ['kept'] }]);
    const savedKey = h.fullKey('/api/events');
    // Offline start or slow authentication: no member identity yet.
    Object.assign(state, { currentUserMemberId: null, currentUserPermission: '', portalAuthGeneration: '', portalAuthVerified: false });
    expect((await h.cache.cleanup()).deleted).toBe(0);
    expect((await h.records()).map(e => e.key)).toEqual([savedKey]);
    // A confirmed session of another login generation makes the old key unusable.
    Object.assign(state, { currentUserMemberId: 1, currentUserPermission: 'general', portalAuthGeneration: 'two', portalAuthVerified: true });
    expect((await h.cache.cleanup()).deleted).toBe(1);
    expect(await h.records()).toEqual([]);
});

test('a confirmed session keeps its own records', async () => {
    const h = await harness();
    h.ctx.portalRuntimeContext.appState.portalAuthVerified = true;
    await h.seed([{ key: '/api/events', timestamp: Date.now() }]);
    expect((await h.cache.cleanup()).deleted).toBe(0);
    expect(await h.read('/api/events')).toBeDefined();
});

test('cleanup never opens another database or touches localStorage', async () => {
    const h = await harness();
    const open = vi.spyOn(h.ctx.indexedDB, 'open');
    const get = vi.spyOn(h.ctx.localStorage, 'getItem');
    await h.seed([{ key: '/api/old', timestamp: Date.now() - 8 * DAY }]); get.mockClear();
    await h.cache.cleanup();
    expect(open).not.toHaveBeenCalled();
    // Identity checks may read the device key; no storage write/delete is used.
    expect(get.mock.calls.every(([key]) => key === 'kanadePortalDeviceId')).toBe(true);
});

test('request success followed by transaction abort does not commit cleanup or touch', async () => {
    const h = await harness();
    await h.seed([{ key: '/api/events', timestamp: 1000 }]);
    const transaction = h.cache.db.transaction.bind(h.cache.db);
    h.cache.db.transaction = (...args) => {
        const tx = transaction(...args);
        if (args[1] === 'readwrite') {
            const objectStore = tx.objectStore.bind(tx);
            tx.objectStore = name => {
                const store = objectStore(name);
                for (const method of ['put', 'delete']) {
                    const original = store[method].bind(store);
                    store[method] = (...values) => {
                        const request = original(...values);
                        request.addEventListener('success', () => tx.abort(), { once: true });
                        return request;
                    };
                }
                return store;
            };
        }
        return tx;
    };
    await expect(h.cache.touchAccess(h.fullKey('/api/events'))).rejects.toThrow();
    await expect(h.cache.cleanup()).rejects.toThrow();
    h.cache.db.transaction = transaction;
    expect((await h.read('/api/events')).lastAccessAt).toBeUndefined();
});
