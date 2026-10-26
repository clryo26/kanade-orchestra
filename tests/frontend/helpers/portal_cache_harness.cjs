const fs = require('node:fs');
const vm = require('node:vm');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
function createCacheHarness(source = fs.readFileSync('src/static/js/utils/cache.js', 'utf8')) {
    const ctx = { indexedDB: new IDBFactory(), IDBKeyRange, Date, setTimeout, clearTimeout,
        localStorage: { getItem: () => 'device' } };
    ctx.window = ctx;
    ctx.portalRuntimeContext = { appState: { currentUserMemberId: 1, currentUserPermission: 'general', portalAuthGeneration: 'one' } };
    vm.createContext(ctx); vm.runInContext(source, ctx);
    const cache = ctx.portalCacheState.dbCache;
    const fullKey = key => `${ctx.portalCacheIdentity()}:${key}`;
    const store = async (mode, work) => new Promise((resolve, reject) => {
        const tx = cache.db.transaction(['bootstrap_cache'], mode);
        work(tx.objectStore('bootstrap_cache'), tx);
        tx.oncomplete = resolve; tx.onabort = () => reject(tx.error || new Error('abort')); tx.onerror = () => reject(tx.error);
    });
    const read = async key => { let result; await store('readonly', s => { s.get(fullKey(key)).onsuccess = e => { result = e.target.result; }; }); return result; };
    const records = async () => { let result; await store('readonly', s => { s.getAll().onsuccess = e => { result = e.target.result; }; }); return result; };
    const seed = async entries => store('readwrite', s => entries.forEach(e => s.put({
        representation: ctx.PORTAL_DATETIME_REPRESENTATION, data: [], timestamp: Date.now(), ...e, key: fullKey(e.key),
    })));
    return { ctx, cache, fullKey, store, read, records, seed };
}
module.exports = { createCacheHarness };
