// Safe GET-only transient retry wrapper.
// Loaded immediately after api_runtime.js so existing callers keep using fetchWithTimeout.
(function () {
    const originalFetchWithTimeout = window.fetchWithTimeout;
    if (typeof originalFetchWithTimeout !== 'function') return;

    const retryableStatuses = new Set([408, 429, 502, 503, 504]);
    const retryDelayMs = [250, 750];
    const waits = new Map();
    const activeAttempts = new Set();
    const manualIntervalMs = 10000;
    const identity = () => `${typeof portalCacheIdentity === 'function' ? portalCacheIdentity() : ''}:${window.portalRuntimeContext?.appState?.portalAuthTransition || 0}`;
    let waitIdentity = identity();
    window.resetPortalRequestWaits = function () { waits.clear(); waitIdentity = identity(); };
    // Use the mutation cache targets, including every force/header variant.
    window.clearPortalRequestWaitsForKeys = function (keys) {
        const targets = new Set(keys);
        for (const [key, entry] of waits) {
            if (targets.has(entry.url.split('?')[0])) waits.delete(key);
        }
        // A read started before the save must not restore the cleared wait.
        for (const attempt of activeAttempts) {
            if (targets.has(attempt.url.split('?')[0])) attempt.invalidated = true;
        }
    };
    function waitKey(url, options) {
        const current = identity();
        if (waitIdentity !== current) window.resetPortalRequestWaits();
        const now = Date.now();
        for (const [key, entry] of waits) {
            if (now >= Math.max(entry.manualUntil, entry.automaticUntil)) waits.delete(key);
        }
        const device = window.localStorage?.getItem(window.portalRuntimeContext?.PORTAL_DEVICE_ID_KEY) || '';
        const entries = typeof portalRequestHeaderEntries === 'function' ? portalRequestHeaderEntries(options.headers) : Object.entries(options.headers || {});
        const headers = entries.map(([name, value]) => [String(name).toLowerCase(), String(value)])
            .filter(([name, value]) => name !== 'if-none-match' && !(name === 'x-device-id' && value === device))
            .sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv));
        return JSON.stringify([current, String(url), Boolean(options._forceRevalidate), options.credentials || 'same-origin', headers]);
    }
    function waitInfo(entry, options) {
        if (!entry) return null;
        const automatic = options._requestOrigin === 'automatic';
        const remainingMs = Math.max(0, (automatic ? entry.automaticUntil : entry.manualUntil) - Date.now());
        const prefix = entry.maintenance ? 'メンテナンス中です。' : '現在、取得を待機しています。';
        return { blocked: remainingMs > 0, remainingMs,
            // Permanent version anomalies retain the administrator instruction;
            // suppressing clicks must not imply that waiting will resolve them.
            message: entry.message || `${prefix}あと${Math.ceil(remainingMs / 1000)}秒後に再試行できます。` };
    }
    // UI entry points can inspect the same policy before replacing content
    // with a loading placeholder. This does not send or cache application data.
    window.portalRetryWaitInfo = function (url, options = {}) {
        return waitInfo(waits.get(waitKey(url, options)), options);
    };

    window.fetchWithTimeout = async function (url, options, timeoutMs) {
        const requestOptions = options || {};
        const method = String(requestOptions.method || 'GET').toUpperCase();

        if (method !== 'GET') {
            return originalFetchWithTimeout(url, requestOptions, timeoutMs);
        }
        if (requestOptions.signal?.aborted) throw requestOptions.signal.reason || new DOMException('Aborted', 'AbortError');

        const budget = requestOptions._retryContext || { transientRetries: 0, unknown503Retries: 0 };
        const context = identity();
        const key = waitKey(url, requestOptions);
        let ownedEntry = waits.get(key);
        const waiting = waitInfo(ownedEntry, requestOptions);
        if (ownedEntry?.budget !== budget && waiting?.blocked) {
            const response = ownedEntry.response.clone();
            response.portalRetryWait = { ...waiting, suppressed: true };
            if (requestOptions._requestOrigin !== 'automatic' && typeof window.showAlert === 'function') {
                window.showAlert(waiting.message, 'warning');
                response.portalRetryWait.noticeShown = true;
            }
            return response;
        }
        // Reserve a manual probe before awaiting network IO so click bursts
        // cannot each send while the first eligible probe is in flight.
        if (ownedEntry && ownedEntry.budget !== budget && requestOptions._requestOrigin !== 'automatic') {
            ownedEntry.manualUntil = Date.now() + manualIntervalMs;
        }
        for (;;) {
            let delayMs = retryDelayMs[budget.transientRetries];
            const attempt = { url: String(url), invalidated: false };
            activeAttempts.add(attempt);
            try {
                const response = await originalFetchWithTimeout(url, requestOptions, timeoutMs);
                if (response.ok || response.status === 304) {
                    if (waits.get(key) === ownedEntry) waits.delete(key);
                }
                if (!retryableStatuses.has(response.status)) {
                    return response;
                }
                if (response.status === 503) {
                    // Classification must not consume the response the caller reads.
                    let body = null;
                    try { body = await response.clone().json(); } catch (_) { /* HTML/empty/legacy mocks */ }
                    const code = body?.detail?.code;
                    // Preserve both existing maintenance apps' generic string bodies.
                    const detail = typeof body?.detail === 'string' ? body.detail : '';
                    const retryAfter = response.headers?.get('Retry-After');
                    const maintenance = code === 'maintenance' || (detail === 'Service temporarily unavailable' && retryAfter === '60'
                        && response.headers?.get('Cache-Control') === 'no-store')
                        || (detail === 'メンテナンス中です。しばらくしてから再度お試しください' && retryAfter === '300');
                    const duration = retryAfter && /^\d+$/.test(retryAfter.trim()) ? Number(retryAfter) * 1000 : 0;
                    // Manual probes are spaced for every 503. Only a valid
                    // Retry-After establishes a server-directed automatic wait.
                    const automaticDuration = duration > 0 && Number.isSafeInteger(Date.now() + duration) ? duration : 0;
                    if (!attempt.invalidated && identity() === context && typeof response.clone === 'function') {
                        ownedEntry = { response: response.clone(), budget, maintenance, url: String(url),
                            message: code === 'version_clock_anomaly' ? body?.detail?.message : null,
                            automaticUntil: Date.now() + automaticDuration, manualUntil: Date.now() + manualIntervalMs };
                        waits.set(key, ownedEntry);
                        response.portalRetryWait = { ...waitInfo(ownedEntry, requestOptions), suppressed: false };
                    }
                    if (['read_capacity_exceeded', 'save_busy', 'maintenance', 'version_clock_anomaly'].includes(code) || maintenance) return response;
                    if (budget.transientRetries >= 2) return response;
                    if (budget.unknown503Retries >= 1) return response;
                    delayMs = 500 + Math.floor(Math.random() * 1001);
                    if (retryAfter && /^\d+$/.test(retryAfter.trim())) {
                        const wait = Number(retryAfter) * 1000;
                        // Do not hold the UI for a long gateway Retry-After.
                        // Returning the response respects it without sending early.
                        if (!Number.isFinite(wait) || wait > 1500) return response;
                        delayMs = Math.max(delayMs, wait);
                    }
                    budget.unknown503Retries += 1;
                } else if (budget.transientRetries >= 2) return response;
            } catch (error) {
                const externallyAborted = Boolean(requestOptions.signal && requestOptions.signal.aborted);
                const isTimeout = Boolean(error && error.name === 'PortalTimeoutError');
                const isAbort = Boolean(error && error.name === 'AbortError');
                // Retry transient connection failures, but keep explicit timeouts
                // and caller aborts deterministic so a slow server is not doubled.
                if (isTimeout || isAbort || externallyAborted || budget.transientRetries >= 2) {
                    throw error;
                }
            } finally {
                activeAttempts.delete(attempt);
            }

            budget.transientRetries += 1;
            await new Promise((resolve, reject) => {
                const signal = requestOptions.signal;
                let timer;
                const cleanup = () => { if (signal) signal.removeEventListener('abort', abort); };
                const abort = () => {
                    window.clearTimeout(timer);
                    cleanup();
                    reject(signal.reason || new DOMException('Aborted', 'AbortError'));
                };
                if (signal?.aborted) { abort(); return; }
                timer = window.setTimeout(() => { cleanup(); resolve(); }, delayMs);
                if (signal) signal.addEventListener('abort', abort, { once: true });
            });
        }
    };
})();
