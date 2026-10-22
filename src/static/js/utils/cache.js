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
        this.touchingKeys = new Set();
        this.cleanupPending = null;
        this.cleanupScheduled = false;
        this.cleanupAgain = false;
        this.writeSequence = 0;
        this.writerId = `${Date.now()}-${Math.random()}`;
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
                // Best-effort metadata only; never put this previously read body
                // back after a mutation or a newer GET has replaced it.
                const accessed = entry.lastAccessAt;
                if (!Number.isFinite(accessed) || accessed <= 0 || accessed > Date.now() || Date.now() - accessed >= 3600000) {
                    this.touchAccess(key).catch(() => {});
                }
            };
        });
    }

    async get(key) {
        const entry = await this.getEntry(key);
        return entry?.data ?? null;
    }

    async set(key, data, etag = null) {
        if (!this.db) return;
        const approximateBytes = this.approximateSize(data);
        if (approximateBytes > 20 * 1024 * 1024) {
            // Return the network result, but block reuse of any older disk copy.
            await this.delete(key).catch(() => {});
            return;
        }
        key = `${portalCacheIdentity()}:${key}`;
        const invalidation = this.invalidatedKeys.get(key);
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['bootstrap_cache'], 'readwrite');
            const store = transaction.objectStore('bootstrap_cache');
            const validatedAt = Date.now();
            const request = store.put({ key, data, etag, representation: window.PORTAL_DATETIME_REPRESENTATION,
                timestamp: validatedAt, validatedAt, lastAccessAt: validatedAt, approximateBytes,
                writeToken: `${this.writerId}:${++this.writeSequence}` });
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
                this.scheduleCleanup();
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

    approximateSize(data) {
        // Conservative UTF-16 JSON estimate, not the browser's physical quota.
        try { return JSON.stringify(data).length * 2; } catch { return 0; }
    }

    accessTime(entry, now) {
        const valid = value => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= now;
        return valid(entry.lastAccessAt) ? entry.lastAccessAt : valid(entry.timestamp) ? entry.timestamp : 0;
    }

    async touchAccess(key) {
        if (!this.db || this.touchingKeys.has(key) || this.invalidatedKeys.has(key)) return;
        this.touchingKeys.add(key);
        try {
            await new Promise((resolve, reject) => {
                const tx = this.db.transaction(['bootstrap_cache'], 'readwrite');
                const store = tx.objectStore('bootstrap_cache');
                const read = store.get(key);
                read.onsuccess = () => {
                    const current = read.result;
                    const now = Date.now();
                    if (!current || this.invalidatedKeys.has(key) || current.representation !== window.PORTAL_DATETIME_REPRESENTATION) return;
                    if (Number.isFinite(current.lastAccessAt) && current.lastAccessAt > 0 && current.lastAccessAt <= now
                        && now - current.lastAccessAt < 3600000) return;
                    // Preserve the latest body, ETag and validation time. A read
                    // on a deleted key must never recreate a cache record.
                    store.put({ ...current, lastAccessAt: now });
                };
                tx.oncomplete = resolve;
                tx.onabort = () => reject(tx.error || new Error('Cache access update aborted'));
                tx.onerror = () => reject(tx.error);
            });
        } finally { this.touchingKeys.delete(key); }
    }

    scheduleCleanup() {
        if (!this.db || this.cleanupScheduled) return;
        if (this.cleanupPending) { this.cleanupAgain = true; return; }
        this.cleanupScheduled = true;
        // Start outside startup/render work; cleanup never gates a business save.
        const timer = setTimeout(() => {
            this.cleanupScheduled = false;
            this.cleanup().catch(() => {});
        }, 30000);
        timer?.unref?.();
    }

    recordSignature(entry) {
        return JSON.stringify([entry.writeToken, entry.timestamp, entry.validatedAt,
            entry.lastAccessAt, entry.etag, entry.approximateBytes, entry.representation]);
    }

    async scanCleanupRecords() {
        const records = [];
        let lastKey, more = true;
        while (more) {
            more = false;
            await new Promise((resolve, reject) => {
                const tx = this.db.transaction(['bootstrap_cache'], 'readonly');
                const store = tx.objectStore('bootstrap_cache');
                const range = lastKey !== undefined && typeof IDBKeyRange !== 'undefined'
                    ? IDBKeyRange.lowerBound(lastKey, true) : undefined;
                let count = 0;
                const cursor = store.openCursor(range);
                cursor.onsuccess = () => {
                    const item = cursor.result;
                    if (!item) return;
                    if (lastKey !== undefined && item.key <= lastKey) { item.continue(); return; }
                    const entry = item.value || {};
                    const now = Date.now();
                    const bytes = Number.isFinite(entry.approximateBytes) && entry.approximateBytes >= 0
                        ? entry.approximateBytes : this.approximateSize(entry.data);
                    let obsolete = !Object.prototype.hasOwnProperty.call(entry, 'data')
                        || entry.representation !== window.PORTAL_DATETIME_REPRESENTATION;
                    try {
                        const split = String(item.key).indexOf(']:');
                        const identity = JSON.parse(String(item.key).slice(0, split + 1));
                        obsolete ||= !Array.isArray(identity) || identity.length !== 5
                            || JSON.stringify(identity) !== portalCacheIdentity();
                    } catch { obsolete = true; }
                    records.push({ key: item.key, time: this.accessTime(entry, now), bytes,
                        obsolete, signature: this.recordSignature(entry) });
                    lastKey = item.key;
                    if (++count < 50) item.continue();
                    else more = true;
                };
                tx.oncomplete = resolve;
                tx.onabort = () => reject(tx.error || new Error('Cache scan aborted'));
                tx.onerror = () => reject(tx.error);
            });
        }
        return records;
    }

    cleanup() {
        if (!this.db) return Promise.resolve({ deleted: 0 });
        if (this.cleanupPending) return this.cleanupPending;
        this.cleanupPending = this.cleanupRecords().finally(() => {
            this.cleanupPending = null;
            if (this.cleanupAgain) { this.cleanupAgain = false; this.scheduleCleanup(); }
        });
        return this.cleanupPending;
    }

    async cleanupRecords() {
        const now = Date.now();
        const records = await this.scanCleanupRecords();
        let count = records.length, bytes = records.reduce((sum, item) => sum + item.bytes, 0), deleted = 0;
        const expired = item => item.obsolete || (item.time > 0 && now - item.time >= 7 * 86400000);
        records.sort((a, b) => Number(expired(b)) - Number(expired(a)) || a.time - b.time);
        for (let offset = 0; offset < records.length; offset += 25) {
            const removed = [];
            await new Promise((resolve, reject) => {
                const tx = this.db.transaction(['bootstrap_cache'], 'readwrite');
                const store = tx.objectStore('bootstrap_cache');
                for (const item of records.slice(offset, offset + 25)) {
                    const read = store.get(item.key);
                    read.onsuccess = () => {
                        const current = read.result;
                        if (!current) { count--; bytes -= item.bytes; return; }
                        // A candidate is only a snapshot. Never remove a record
                        // replaced/touched since the scan, including another tab.
                        if (this.recordSignature(current) !== item.signature) return;
                        if (!expired(item) && count <= 200 && bytes <= 20 * 1024 * 1024) return;
                        store.delete(item.key);
                        removed.push(item.key);
                        count--; bytes -= item.bytes;
                    };
                }
                tx.oncomplete = resolve;
                tx.onabort = () => reject(tx.error || new Error('Cache cleanup aborted'));
                tx.onerror = () => reject(tx.error);
            });
            for (const key of removed) this.etags.delete(key);
            deleted += removed.length;
        }
        return { scanned: records.length, deleted, remaining: count, approximateBytes: bytes };
    }
}

window.IndexedDBCache = IndexedDBCache;
window.portalCacheState = {
    dbCache: new IndexedDBCache(),
    inFlightGetRequests: new Map(),
};
