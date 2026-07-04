function portalCacheBust(url) {
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}_=${Date.now()}`;
}

class IndexedDBCache {
    constructor() {
        this.db = null;
        this.etags = new Map();
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

    async get(key) {
        if (!this.db) return null;
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['bootstrap_cache'], 'readonly');
            const store = transaction.objectStore('bootstrap_cache');
            const request = store.get(key);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result?.data ?? null);
        });
    }

    async set(key, data, etag = null) {
        if (!this.db) return;
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['bootstrap_cache'], 'readwrite');
            const store = transaction.objectStore('bootstrap_cache');
            const request = store.put({ key, data, etag, timestamp: Date.now() });
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                if (etag) this.etags.set(key, etag);
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
        if (!this.db) return;
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['bootstrap_cache'], 'readwrite');
            const store = transaction.objectStore('bootstrap_cache');
            const request = store.delete(key);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                this.etags.delete(key);
                resolve();
            };
        });
    }

    getETag(key) {
        return this.etags.get(key);
    }
}

window.IndexedDBCache = IndexedDBCache;
window.portalCacheState = {
    dbCache: new IndexedDBCache(),
    inFlightGetRequests: new Map(),
};
