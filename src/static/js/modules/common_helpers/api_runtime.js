// Request/cache helpers split from common_helpers.js.
// Keep global names for compatibility with legacy non-module loading.

var appState = window.portalRuntimeContext.appState;

function mutationRelatedCacheKeys(url) {
    const keys = new Set(['/api/bootstrap-lite', '/api/bootstrap-core', '/api/bootstrap']);
    if (url.startsWith('/api/extra/')) {
        keys.add(url.split('?')[0]);
        if (url.includes('/sheet_library') || url.includes('/date_adjust') || url.includes('/practice_instruction')) keys.add('/api/sheets');
        return [...keys];
    }
    if (url.startsWith('/api/sheets')) {
        keys.add('/api/sheets');
        keys.add('/api/extra/sheet_library');
        return [...keys];
    }
    if (url.startsWith('/api/recordings') || url.startsWith('/api/convert') || url.startsWith('/api/drive/')) {
        keys.add('/api/recordings');
        keys.add('/api/drive/files');
        return [...keys];
    }
    const firstPath = url.split('?')[0].replace(/\/[0-9]+$/, '');
    keys.add(firstPath);
    return [...keys];
}

async function invalidateCacheForMutation(url) {
    const keys = mutationRelatedCacheKeys(url);
    await Promise.all(keys.map((key) => window.portalRuntimeContext.dbCache.delete(key)));
}

async function request(url, options = {}) {
    const method = options.method || 'GET';
    const cacheKey = url;
    const deviceId = localStorage.getItem(window.portalRuntimeContext.PORTAL_DEVICE_ID_KEY) || '';
    const baseHeaders = { ...(options.headers || {}), ...(deviceId ? { 'X-Device-Id': deviceId } : {}) };
    if (method === 'GET') {
        if (window.portalRuntimeContext.inFlightGetRequests.has(cacheKey)) return window.portalRuntimeContext.inFlightGetRequests.get(cacheKey);
        const pending = (async () => {
            const cached = await window.portalRuntimeContext.dbCache.get(cacheKey);
            const etag = window.portalRuntimeContext.dbCache.getETag(cacheKey);
            const headers = { ...baseHeaders };
            if (etag) headers['If-None-Match'] = etag;
            const response = await fetch(url, { ...options, method, headers });
            if (response.status === 304 && cached) return cached;
            if (!response.ok) {
                const contentType = response.headers.get('content-type') || '';
                const data = contentType.includes('application/json') ? await response.json() : await response.text();
                const message = typeof data === 'object' && data.detail ? data.detail : '通信に失敗しました';
                showAlert(message, 'danger');
                throw new Error(message);
            }
            const contentType = response.headers.get('content-type') || '';
            const data = contentType.includes('application/json') ? await response.json() : await response.text();
            const newETag = response.headers.get('ETag');
            if (newETag) await window.portalRuntimeContext.dbCache.set(cacheKey, data, newETag);
            return data;
        })();
        window.portalRuntimeContext.inFlightGetRequests.set(cacheKey, pending);
        try { return await pending; } finally { window.portalRuntimeContext.inFlightGetRequests.delete(cacheKey); }
    }
    const response = await fetch(url, { ...options, headers: baseHeaders });
    const contentType = response.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await response.json() : await response.text();
    if (!response.ok) {
        const message = typeof data === 'object' && data.detail ? data.detail : '通信に失敗しました';
        showAlert(message, 'danger');
        throw new Error(message);
    }
    await invalidateCacheForMutation(url);
    return data;
}