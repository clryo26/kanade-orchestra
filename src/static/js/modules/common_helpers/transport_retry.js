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

        for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
                const response = await originalFetchWithTimeout(url, requestOptions, timeoutMs);
                if (!retryableStatuses.has(response.status) || attempt === 2) {
                    return response;
                }
            } catch (error) {
                const externallyAborted = Boolean(requestOptions.signal && requestOptions.signal.aborted);
                const isTimeout = Boolean(error && error.name === 'PortalTimeoutError');
                const isAbort = Boolean(error && error.name === 'AbortError');
                // Retry transient connection failures, but keep explicit timeouts
                // and caller aborts deterministic so a slow server is not doubled.
                if (isTimeout || isAbort || externallyAborted || attempt === 2) {
                    throw error;
                }
            }

            await new Promise((resolve) => window.setTimeout(resolve, retryDelayMs[attempt]));
        }

        throw new Error('GET retry loop exited unexpectedly');
    };
})();
