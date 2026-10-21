// Safe GET-only transient retry wrapper.
// Loaded immediately after api_runtime.js so existing callers keep using fetchWithTimeout.
(function () {
    const originalFetchWithTimeout = window.fetchWithTimeout;
    if (typeof originalFetchWithTimeout !== 'function') return;

    const retryableStatuses = new Set([408, 429, 502, 503, 504]);
    const retryDelayMs = [250, 750];

    window.fetchWithTimeout = async function (url, options, timeoutMs) {
        const requestOptions = options || {};
        const method = String(requestOptions.method || 'GET').toUpperCase();

        if (method !== 'GET') {
            return originalFetchWithTimeout(url, requestOptions, timeoutMs);
        }

        const budget = requestOptions._retryContext || { transientRetries: 0, unknown503Retries: 0 };
        for (;;) {
            let delayMs = retryDelayMs[budget.transientRetries];
            try {
                const response = await originalFetchWithTimeout(url, requestOptions, timeoutMs);
                if (!retryableStatuses.has(response.status) || budget.transientRetries >= 2) {
                    return response;
                }
                if (response.status === 503) {
                    // Classification must not consume the response the caller reads.
                    let body = null;
                    try { body = await response.clone().json(); } catch (_) { /* HTML/empty/legacy mocks */ }
                    const code = body?.detail?.code;
                    if (['read_capacity_exceeded', 'save_busy', 'maintenance', 'version_clock_anomaly'].includes(code)) return response;
                    // Preserve both existing maintenance apps' generic string bodies.
                    const detail = typeof body?.detail === 'string' ? body.detail : '';
                    const retryAfter = response.headers?.get('Retry-After');
                    if ((detail === 'Service temporarily unavailable' && retryAfter === '60'
                        && response.headers?.get('Cache-Control') === 'no-store')
                        || (detail === 'メンテナンス中です。しばらくしてから再度お試しください' && retryAfter === '300')) return response;
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
                }
            } catch (error) {
                const externallyAborted = Boolean(requestOptions.signal && requestOptions.signal.aborted);
                const isTimeout = Boolean(error && error.name === 'PortalTimeoutError');
                const isAbort = Boolean(error && error.name === 'AbortError');
                // Retry transient connection failures, but keep explicit timeouts
                // and caller aborts deterministic so a slow server is not doubled.
                if (isTimeout || isAbort || externallyAborted || budget.transientRetries >= 2) {
                    throw error;
                }
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
