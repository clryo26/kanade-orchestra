// Safe GET-only transient retry wrapper.
// Loaded immediately after api_runtime.js so existing callers keep using fetchWithTimeout.
(function () {
    const originalFetchWithTimeout = window.fetchWithTimeout;
    if (typeof originalFetchWithTimeout !== 'function') return;

    const retryableStatuses = new Set([408, 429, 502, 503, 504]);
    const retryDelayMs = 250;

    window.fetchWithTimeout = async function (url, options, timeoutMs) {
        const requestOptions = options || {};
        const method = String(requestOptions.method || 'GET').toUpperCase();

        if (method !== 'GET') {
            return originalFetchWithTimeout(url, requestOptions, timeoutMs);
        }

        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                const response = await originalFetchWithTimeout(url, requestOptions, timeoutMs);
                if (!retryableStatuses.has(response.status) || attempt === 1) {
                    return response;
                }
            } catch (error) {
                const externallyAborted = Boolean(requestOptions.signal && requestOptions.signal.aborted);
                const isTimeout = Boolean(error && error.name === 'PortalTimeoutError');
                const isAbort = Boolean(error && error.name === 'AbortError');
                if (isTimeout || isAbort || externallyAborted || attempt === 1) {
                    throw error;
                }
            }

            await new Promise((resolve) => window.setTimeout(resolve, retryDelayMs));
        }

        throw new Error('GET retry loop exited unexpectedly');
    };
})();
