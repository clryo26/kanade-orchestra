function portalCacheBust(url) {
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}_=${Date.now()}`;
}

// Only the portal response cache is versioned; tuner/metronome offline stores
// are separate databases and must never be cleared by a representation upgrade.
window.PORTAL_DATETIME_REPRESENTATION = 'jst-us-1';
window.portalResponseEpoch = 0;
function portalCacheIdentity() {
    const state = window.portalRuntimeContext?.appState || {};
    const device = localStorage.getItem(window.portalRuntimeContext?.PORTAL_DEVICE_ID_KEY || 'kanadePortalDeviceId') || '';
    return JSON.stringify([window.PORTAL_DATETIME_REPRESENTATION, device,
        state.currentUserMemberId ?? '', state.currentUserPermission || '', state.portalAuthGeneration || '']);
}

class IndexedDBCache {
    constructor() {
        this.db = null;
        this.etags = new Map();
        // A failed disk deletion must not make an invalidated response usable
        // again in this page. Tokens distinguish older writes from fresh ones.
        this.invalidatedKeys = new Map();
    }

    async init() {
        const timeout = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('IndexedDB init timeout')), 3000)
        );
        const open = new Promise((resolve, reject) => {
            const request = indexedDB.open('OrchestraAppCache', 1);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                this.db = request.result;
                resolve();
            };
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains('bootstrap_cache')) {
                    db.createObjectStore('bootstrap_cache', { keyPath: 'key' });
                }
            };
        });
        return Promise.race([open, timeout]);
    }

    async getEntry(key) {
        if (!this.db) return null;
        const identity = portalCacheIdentity();
        key = `${identity}:${key}`;
        if (this.invalidatedKeys.has(key)) return null;
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['bootstrap_cache'], 'readonly');
            const store = transaction.objectStore('bootstrap_cache');
            const request = store.get(key);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                const entry = request.result;
                if (identity !== portalCacheIdentity() || this.invalidatedKeys.has(key)) { resolve(null); return; }
                if (!entry) {
                    resolve(null);
                    return;
                }
                if (
                    typeof entry !== 'object' ||
                    !Object.prototype.hasOwnProperty.call(entry, 'data') ||
                    entry.representation !== window.PORTAL_DATETIME_REPRESENTATION
                ) {
                    resolve({
                        data: null,
                        etag: null,
                        timestamp: null,
                        invalid: true,
                    });
                    return;
                }
                resolve({
                    data: entry.data,
                    etag: entry.etag ?? null,
                    timestamp: entry.timestamp ?? null,
                    validatedAt: entry.validatedAt ?? entry.timestamp ?? null,
                });
            };
        });
    }

    async get(key) {
        const entry = await this.getEntry(key);
        return entry?.data ?? null;
    }

    async set(key, data, etag = null) {
        if (!this.db) return;
        key = `${portalCacheIdentity()}:${key}`;
        const invalidation = this.invalidatedKeys.get(key);
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['bootstrap_cache'], 'readwrite');
            const store = transaction.objectStore('bootstrap_cache');
            const validatedAt = Date.now();
            const request = store.put({ key, data, etag, representation: window.PORTAL_DATETIME_REPRESENTATION, timestamp: validatedAt, validatedAt });
            request.onerror = () => reject(request.error);
            transaction.onabort = () => reject(transaction.error || new Error('Cache write aborted'));
            transaction.onerror = () => reject(transaction.error);
            transaction.oncomplete = () => {
                if (this.invalidatedKeys.get(key) === invalidation) {
                    this.invalidatedKeys.delete(key);
                }
                if (!this.invalidatedKeys.has(key)) {
                    if (etag) this.etags.set(key, etag);
                    else this.etags.delete(key);
                }
                resolve();
            };
        });
    }

    async clear() {
        if (!this.db) return;
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['bootstrap_cache'], 'readwrite');
            const store = transaction.objectStore('bootstrap_cache');
            const request = store.clear();
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                this.etags.clear();
                resolve();
            };
        });
    }

    async delete(key) {
        key = `${portalCacheIdentity()}:${key}`;
        this.invalidatedKeys.set(key, {});
        this.etags.delete(key);
        if (!this.db) return;
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['bootstrap_cache'], 'readwrite');
            const store = transaction.objectStore('bootstrap_cache');
            const request = store.delete(key);
            request.onerror = () => reject(request.error);
            transaction.onabort = () => reject(transaction.error || new Error('Cache deletion aborted'));
            transaction.onerror = () => reject(transaction.error);
            transaction.oncomplete = () => resolve();
        });
    }

    getETag(key) {
        key = `${portalCacheIdentity()}:${key}`;
        return this.invalidatedKeys.has(key) ? undefined : this.etags.get(key);
    }
}

window.IndexedDBCache = IndexedDBCache;
window.portalCacheState = {
    dbCache: new IndexedDBCache(),
    inFlightGetRequests: new Map(),
};
