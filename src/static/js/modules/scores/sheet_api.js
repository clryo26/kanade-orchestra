// Sheet library network helper (docs/SHEET_LIBRARY_RELIABILITY_DESIGN.md).
//
// Unlike request(), this never answers from the IndexedDB copy and never
// shares an in-flight GET between callers: a failed or old response must not
// look like a successful refresh. Every call names the account it was sent for,
// so a response that arrives after logout or an account switch is dropped.
(function (root) {
    'use strict';

    var ctx = function () { return window.portalRuntimeContext; };
    var state = function () { return ctx().appState; };

    function deviceId() {
        try {
            return window.localStorage.getItem(ctx().PORTAL_DEVICE_ID_KEY) || '';
        } catch (_) {
            return '';
        }
    }

    // Identity of the signed-in account on this device.
    function accountKey() {
        var s = state();
        return [deviceId(), s.currentUserMemberId == null ? '' : String(s.currentUserMemberId), s.currentUserPermission || '',
            s.portalAuthVerified ? '1' : '0'].join(':');
    }

    function newOperationId() {
        if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
        var bytes = new Uint8Array(16);
        window.crypto.getRandomValues(bytes);
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        var hex = Array.prototype.map.call(bytes, function (b) { return (b + 256).toString(16).slice(1); }).join('');
        return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
    }

    function SheetApiError(message, info) {
        var error = new Error(message);
        error.name = 'SheetApiError';
        Object.assign(error, info || {});
        return error;
    }

    function detailMessage(data, fallback) {
        var detail = data && data.detail;
        if (detail && typeof detail === 'object' && detail.message) return String(detail.message);
        if (typeof detail === 'string' && detail) return detail;
        return fallback;
    }

    // Returns { status, data, headers }. Throws SheetApiError for network,
    // timeout, abort and account changes (kind: network | timeout | aborted |
    // account). HTTP errors are returned, not thrown, so callers decide.
    async function call(url, options) {
        var o = options || {};
        var sentFor = accountKey();
        var headers = Object.assign({}, o.headers || {});
        var id = deviceId();
        if (id) headers['X-Device-Id'] = id;
        var init = { method: o.method || 'GET', headers: headers, cache: 'no-store', signal: o.signal };
        // Preserve the transient budget across this helper's own 401 resend.
        init._retryContext = { transientRetries: 0, unknown503Retries: 0 };
        if (o.json !== undefined) {
            headers['Content-Type'] = 'application/json';
            init.body = JSON.stringify(o.json);
        } else if (o.body !== undefined) {
            init.body = o.body;
        }
        var timeout = o.timeoutMs || (init.method === 'GET' ? (typeof PORTAL_TIMEOUT_GET !== 'undefined' ? PORTAL_TIMEOUT_GET : 15000) : (typeof PORTAL_TIMEOUT_MUTATION !== 'undefined' ? PORTAL_TIMEOUT_MUTATION : 20000)) || 20000;
        var response;
        try {
            response = await fetchWithTimeout(url, init, timeout);
            if (response.status === 401 && !o.noRecovery && typeof tryRecoverPortalSession === 'function'
                && await tryRecoverPortalSession(id)) {
                response = await fetchWithTimeout(url, init, timeout);
            }
        } catch (error) {
            if (o.signal && o.signal.aborted) throw SheetApiError('中止しました', { kind: 'aborted' });
            var timedOut = typeof PortalTimeoutError !== 'undefined' && error instanceof PortalTimeoutError;
            throw SheetApiError(timedOut ? '通信がタイムアウトしました' : '通信できませんでした', { kind: timedOut ? 'timeout' : 'network' });
        }
        if (accountKey() !== sentFor) throw SheetApiError('ログイン状態が変わったため、結果を使いません', { kind: 'account' });
        var type = response.headers.get('content-type') || '';
        var data = null;
        if (o.raw) return { status: response.status, response: response, headers: response.headers };
        try {
            data = type.indexOf('application/json') >= 0 ? await response.json() : await response.text();
        } catch (_) {
            data = null;
        }
        if (accountKey() !== sentFor) throw SheetApiError('ログイン状態が変わったため、結果を使いません', { kind: 'account' });
        return { status: response.status, data: data, headers: response.headers };
    }

    root.portalSheetApi = {
        call: call,
        accountKey: accountKey,
        deviceId: deviceId,
        newOperationId: newOperationId,
        detailMessage: detailMessage,
        SheetApiError: SheetApiError,
    };
})(typeof globalThis !== 'undefined' ? globalThis : window);
