// Method A: 本番 api_runtime.js を直接読み込んで評価する。
// 本番ファイルは変更せず、テスト用エクスポート取得コードを評価時だけ末尾へ追加する。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const API_RUNTIME_PATH = path.resolve(
    __dirname,
    '../../src/static/js/modules/common_helpers/api_runtime.js'
);

// this.__apiRuntimeTestExports = { ... } で sandbox へ書き出す
const EXPORT_INJECTION = `
this.__apiRuntimeTestExports = {
    PortalTimeoutError,
    fetchWithTimeout,
    _resolveTimeoutMs,
    PORTAL_TIMEOUT_AUTH,
    PORTAL_TIMEOUT_BOOTSTRAP_LITE,
    PORTAL_TIMEOUT_BOOTSTRAP_CORE,
    PORTAL_TIMEOUT_GET,
    PORTAL_TIMEOUT_MUTATION,
    request,
};`;

function createApiRuntimeSandbox() {
    const ctx = {
        window: null,
        globalThis: null,
        console,
        AbortController,
        DOMException,
        setTimeout,
        clearTimeout,
        fetch: null,
        showAlert: () => {},
        showPortalLogin: () => {},
        localStorage: {
            getItem: () => null,
            setItem: () => {},
            removeItem: () => {},
        },
    };
    ctx.window = ctx;
    ctx.globalThis = ctx;
    ctx.portalRuntimeContext = {
        appState: {},
        PORTAL_DEVICE_ID_KEY: 'kanadePortalDeviceId',
        PORTAL_AUTH_KEY: 'kanadePortalAuthenticated',
        inFlightGetRequests: new Map(),
        dbCache: {
            getEntry: () => Promise.resolve(null),
            get: () => Promise.resolve(null),
            set: () => Promise.resolve(),
            delete: () => Promise.resolve(),
            getETag: () => null,
        },
    };
    const source = fs.readFileSync(API_RUNTIME_PATH, 'utf8');
    vm.runInNewContext(source + EXPORT_INJECTION, ctx);
    return ctx;
}

let sandbox;
let PortalTimeoutError, fetchWithTimeout, _resolveTimeoutMs;
let PORTAL_TIMEOUT_AUTH, PORTAL_TIMEOUT_BOOTSTRAP_LITE, PORTAL_TIMEOUT_BOOTSTRAP_CORE;
let PORTAL_TIMEOUT_GET, PORTAL_TIMEOUT_MUTATION;
let request;

beforeAll(() => {
    sandbox = createApiRuntimeSandbox();
    const exp = sandbox.__apiRuntimeTestExports;
    PortalTimeoutError = exp.PortalTimeoutError;
    fetchWithTimeout = exp.fetchWithTimeout;
    _resolveTimeoutMs = exp._resolveTimeoutMs;
    PORTAL_TIMEOUT_AUTH = exp.PORTAL_TIMEOUT_AUTH;
    PORTAL_TIMEOUT_BOOTSTRAP_LITE = exp.PORTAL_TIMEOUT_BOOTSTRAP_LITE;
    PORTAL_TIMEOUT_BOOTSTRAP_CORE = exp.PORTAL_TIMEOUT_BOOTSTRAP_CORE;
    PORTAL_TIMEOUT_GET = exp.PORTAL_TIMEOUT_GET;
    PORTAL_TIMEOUT_MUTATION = exp.PORTAL_TIMEOUT_MUTATION;
    request = exp.request;
});

beforeEach(() => {
    sandbox.fetch = null;
    sandbox.showAlert = vi.fn();
    sandbox.portalRuntimeContext.inFlightGetRequests.clear();
    sandbox.portalRuntimeContext.dbCache.getEntry = vi.fn().mockResolvedValue(null);
    sandbox.portalRuntimeContext.dbCache.set = vi.fn().mockResolvedValue(undefined);
    sandbox.portalRuntimeContext.dbCache.delete = vi.fn().mockResolvedValue(undefined);
});

// abort信号を監視してAbortErrorをrejectするモックfetch
function abortAwareMock() {
    return vi.fn().mockImplementation((_url, opts) => new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
        });
    }));
}

describe('PortalTimeoutError (本番 api_runtime.js)', () => {
    test('nameとtimeoutMsが設定される', () => {
        const err = new PortalTimeoutError('timeout msg', 10000);
        expect(err.name).toBe('PortalTimeoutError');
        expect(err.timeoutMs).toBe(10000);
        expect(err.message).toBe('timeout msg');
    });

    test('instanceof PortalTimeoutError が true', () => {
        const err = new PortalTimeoutError('x', 5000);
        expect(err instanceof PortalTimeoutError).toBe(true);
    });
});

describe('_resolveTimeoutMs (本番 api_runtime.js)', () => {
    test('認証APIはPORTAL_TIMEOUT_AUTH = 10秒', () => {
        expect(_resolveTimeoutMs('/api/auth/devices/abc123', 'GET')).toBe(PORTAL_TIMEOUT_AUTH);
        expect(PORTAL_TIMEOUT_AUTH).toBe(10000);
    });

    test('/api/bootstrap-lite はPORTAL_TIMEOUT_BOOTSTRAP_LITE = 12秒', () => {
        expect(_resolveTimeoutMs('/api/bootstrap-lite', 'GET')).toBe(PORTAL_TIMEOUT_BOOTSTRAP_LITE);
        expect(PORTAL_TIMEOUT_BOOTSTRAP_LITE).toBe(12000);
    });

    test('/api/bootstrap-core はPORTAL_TIMEOUT_BOOTSTRAP_CORE = 20秒', () => {
        expect(_resolveTimeoutMs('/api/bootstrap-core', 'GET')).toBe(PORTAL_TIMEOUT_BOOTSTRAP_CORE);
        expect(PORTAL_TIMEOUT_BOOTSTRAP_CORE).toBe(20000);
    });

    test('通常GETはPORTAL_TIMEOUT_GET = 15秒', () => {
        expect(_resolveTimeoutMs('/api/performances', 'GET')).toBe(PORTAL_TIMEOUT_GET);
        expect(PORTAL_TIMEOUT_GET).toBe(15000);
    });

    test('更新系APIはPORTAL_TIMEOUT_MUTATION = 20秒', () => {
        expect(_resolveTimeoutMs('/api/extra/performances', 'POST')).toBe(PORTAL_TIMEOUT_MUTATION);
        expect(_resolveTimeoutMs('/api/extra/members/1', 'DELETE')).toBe(PORTAL_TIMEOUT_MUTATION);
        expect(PORTAL_TIMEOUT_MUTATION).toBe(20000);
    });

    test('クエリ文字列付きbootstrap-liteも正しく判定する', () => {
        expect(_resolveTimeoutMs('/api/bootstrap-lite?v=1', 'GET')).toBe(PORTAL_TIMEOUT_BOOTSTRAP_LITE);
    });
});

describe('fetchWithTimeout (本番 api_runtime.js)', () => {
    test('タイムアウト前の正常応答はレスポンスを返す', async () => {
        const mockResponse = { ok: true, status: 200 };
        sandbox.fetch = vi.fn().mockResolvedValue(mockResponse);
        const result = await fetchWithTimeout('/api/test', {}, 5000);
        expect(result).toBe(mockResponse);
    });

    test('タイムアウト時にPortalTimeoutErrorをthrowする', async () => {
        sandbox.fetch = abortAwareMock();
        await expect(fetchWithTimeout('/api/test', {}, 1)).rejects.toSatisfy(
            (e) => e instanceof PortalTimeoutError
        );
    });

    test('タイムアウトエラーのnameはPortalTimeoutError', async () => {
        sandbox.fetch = abortAwareMock();
        const err = await fetchWithTimeout('/api/test', {}, 1).catch((e) => e);
        expect(err.name).toBe('PortalTimeoutError');
    });

    test('タイムアウトエラーにtimeoutMsが設定される', async () => {
        sandbox.fetch = abortAwareMock();
        const err = await fetchWithTimeout('/api/test', {}, 1).catch((e) => e);
        expect(err.timeoutMs).toBe(1);
    });

    test('呼出元signalのabortを伝播する', async () => {
        const controller = new AbortController();
        sandbox.fetch = abortAwareMock();
        const promise = fetchWithTimeout('/api/test', { signal: controller.signal }, 10000);
        controller.abort();
        await expect(promise).rejects.toThrow();
    });

    test('外部abortはPortalTimeoutErrorへ誤変換しない', async () => {
        const controller = new AbortController();
        sandbox.fetch = abortAwareMock();
        const promise = fetchWithTimeout('/api/test', { signal: controller.signal }, 10000);
        controller.abort();
        const err = await promise.catch((e) => e);
        expect(err instanceof PortalTimeoutError).toBe(false);
    });

    test('タイマーは成功時に解除される', async () => {
        sandbox.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
        const clearSpy = vi.spyOn(sandbox, 'clearTimeout');
        await fetchWithTimeout('/api/test', {}, 5000);
        expect(clearSpy).toHaveBeenCalled();
        clearSpy.mockRestore();
    });

    test('タイムアウト時にもタイマーを解除する', async () => {
        sandbox.fetch = abortAwareMock();
        const clearSpy = vi.spyOn(sandbox, 'clearTimeout');
        await fetchWithTimeout('/api/test', {}, 1).catch(() => {});
        expect(clearSpy).toHaveBeenCalled();
        clearSpy.mockRestore();
    });

    test('失敗時にもタイマーを解除する', async () => {
        sandbox.fetch = vi.fn().mockRejectedValue(new TypeError('network error'));
        const clearSpy = vi.spyOn(sandbox, 'clearTimeout');
        await fetchWithTimeout('/api/test', {}, 5000).catch(() => {});
        expect(clearSpy).toHaveBeenCalled();
        clearSpy.mockRestore();
    });

    test('headers・body・methodをfetchへ引き継ぐ', async () => {
        let capturedOpts;
        sandbox.fetch = vi.fn().mockImplementation((_url, opts) => {
            capturedOpts = opts;
            return Promise.resolve({ ok: true, status: 200 });
        });
        await fetchWithTimeout(
            '/api/test',
            { method: 'POST', headers: { 'X-Test': '1' }, body: 'data' },
            5000
        );
        expect(capturedOpts.method).toBe('POST');
        expect(capturedOpts.headers['X-Test']).toBe('1');
        expect(capturedOpts.body).toBe('data');
    });

    test('_skipAuthRecoveryはfetch()に渡されない', async () => {
        let capturedOpts;
        sandbox.fetch = vi.fn().mockImplementation((_url, opts) => {
            capturedOpts = opts;
            return Promise.resolve({ ok: true, status: 200 });
        });
        await fetchWithTimeout('/api/test', { _skipAuthRecovery: true }, 5000);
        expect(capturedOpts).not.toHaveProperty('_skipAuthRecovery');
    });

    test('既にabort済みの外部signalで即座にthrowする', async () => {
        const controller = new AbortController();
        controller.abort();
        sandbox.fetch = vi.fn().mockImplementation((_url, opts) => new Promise((_resolve, reject) => {
            if (opts.signal && opts.signal.aborted) {
                reject(new DOMException('aborted', 'AbortError'));
            }
        }));
        await expect(
            fetchWithTimeout('/api/test', { signal: controller.signal }, 5000)
        ).rejects.toThrow();
    });
});

describe('request cache ETag restore', () => {
    function jsonResponse(data, etag = null) {
        return {
            ok: true,
            status: 200,
            headers: {
                get: (name) => {
                    if (name === 'content-type') return 'application/json';
                    if (name === 'ETag') return etag;
                    return null;
                },
            },
            json: async () => data,
        };
    }

    test('fresh cache-first list data returns without a network request', async () => {
        const cachedData = [{ id: 1 }];
        sandbox.portalRuntimeContext.dbCache.getEntry = vi.fn().mockResolvedValue({
            data: cachedData,
            etag: '"performances-etag-v1"',
            timestamp: Date.now(),
        });
        sandbox.fetch = vi.fn();

        await expect(request('/api/performances')).resolves.toEqual(cachedData);
        expect(sandbox.fetch).not.toHaveBeenCalled();
    });

    test('expired cache revalidates with its ETag', async () => {
        sandbox.portalRuntimeContext.dbCache.getEntry = vi.fn().mockResolvedValue({
            data: [{ id: 1 }],
            etag: '"performances-etag-v1"',
            timestamp: Date.now() - 10001,
        });
        let capturedOptions;
        sandbox.fetch = vi.fn().mockImplementation((_url, options) => {
            capturedOptions = options;
            return Promise.resolve(jsonResponse([{ id: 2 }]));
        });

        await expect(request('/api/performances')).resolves.toEqual([{ id: 2 }]);
        expect(capturedOptions.headers['If-None-Match']).toBe('"performances-etag-v1"');
    });

    test('legacy cache entries without a timestamp revalidate over the network', async () => {
        sandbox.portalRuntimeContext.dbCache.getEntry = vi.fn().mockResolvedValue({
            data: [{ id: 1 }],
            etag: '"performances-etag-v1"',
        });
        sandbox.fetch = vi.fn().mockResolvedValue(jsonResponse([{ id: 2 }]));

        await expect(request('/api/performances')).resolves.toEqual([{ id: 2 }]);
        expect(sandbox.fetch).toHaveBeenCalledTimes(1);
    });

    test('force revalidation bypasses a fresh cache entry and keeps internal options out of fetch', async () => {
        const cachedData = [{ id: 1 }];
        sandbox.portalRuntimeContext.dbCache.getEntry = vi.fn().mockResolvedValue({
            data: cachedData,
            etag: '"performances-etag-v1"',
            timestamp: Date.now(),
        });
        let capturedOptions;
        sandbox.fetch = vi.fn().mockImplementation((_url, options) => {
            capturedOptions = options;
            return Promise.resolve(jsonResponse([{ id: 2 }]));
        });

        await expect(request('/api/performances', { _forceRevalidate: true }))
            .resolves.toEqual([{ id: 2 }]);
        expect(sandbox.fetch).toHaveBeenCalledTimes(1);
        expect(capturedOptions).not.toHaveProperty('_forceRevalidate');
    });

    test('auth and system endpoints always revalidate even with a fresh cache entry', async () => {
        const freshEntry = {
            data: { ok: 'cached' },
            etag: '"sensitive-etag-v1"',
            timestamp: Date.now(),
        };
        sandbox.portalRuntimeContext.dbCache.getEntry = vi.fn().mockResolvedValue(freshEntry);
        sandbox.fetch = vi.fn().mockResolvedValue(jsonResponse({ ok: 'network' }));

        await expect(request('/api/auth/devices')).resolves.toEqual({ ok: 'network' });
        await expect(request('/api/system/readiness-summary')).resolves.toEqual({ ok: 'network' });
        expect(sandbox.fetch).toHaveBeenCalledTimes(2);
    });

    test('mutation invalidation prevents a previously fresh list entry from being reused', async () => {
        const freshEntry = {
            data: [{ id: 1 }],
            etag: '"performances-etag-v1"',
            timestamp: Date.now(),
        };
        const cacheEntries = new Map([['/api/performances', freshEntry]]);
        sandbox.portalRuntimeContext.dbCache.getEntry = vi.fn((key) => (
            Promise.resolve(cacheEntries.get(key) || null)
        ));
        sandbox.portalRuntimeContext.dbCache.delete = vi.fn((key) => {
            cacheEntries.delete(key);
            return Promise.resolve();
        });
        sandbox.fetch = vi.fn()
            .mockResolvedValueOnce(jsonResponse({ ok: true }))
            .mockResolvedValueOnce(jsonResponse([{ id: 2 }]));

        await request('/api/performances/1', { method: 'PUT', body: '{}' });
        expect(sandbox.portalRuntimeContext.dbCache.delete)
            .toHaveBeenCalledWith('/api/performances');

        await expect(request('/api/performances')).resolves.toEqual([{ id: 2 }]);
        expect(sandbox.fetch).toHaveBeenCalledTimes(2);
    });

    test('IndexedDB entry ETag is sent and 304 returns cached data', async () => {
        const cachedData = { performances: [{ id: 1 }] };

        sandbox.portalRuntimeContext.dbCache.getEntry = vi.fn().mockResolvedValue({
            data: cachedData,
            etag: '"bootstrap-etag-v1"',
            timestamp: 123456789,
        });

        let capturedOptions;
        sandbox.fetch = vi.fn().mockImplementation((_url, options) => {
            capturedOptions = options;
            return Promise.resolve({
                ok: false,
                status: 304,
                headers: {
                    get: () => null,
                },
            });
        });

        const result = await request('/api/bootstrap-lite');

        expect(capturedOptions.headers['If-None-Match']).toBe('"bootstrap-etag-v1"');
        expect(result).toEqual(cachedData);
        expect(sandbox.portalRuntimeContext.dbCache.getEntry)
            .toHaveBeenCalledWith('/api/bootstrap-lite');
    });
});

describe('request cache fallback control', () => {
    test('_allowCacheFallback is not passed to fetch', async () => {
        let capturedOptions;
        sandbox.fetch = vi.fn().mockImplementation((_url, options) => {
            capturedOptions = options;
            return Promise.resolve({
                ok: true,
                status: 200,
                headers: {
                    get: (name) => name === 'content-type' ? 'application/json' : null,
                },
                json: async () => ({ ok: true }),
            });
        });

        await request('/api/test', { _allowCacheFallback: false });

        expect(capturedOptions).not.toHaveProperty('_allowCacheFallback');
    });

    test('network failure throws when cache fallback is disabled', async () => {
        sandbox.portalRuntimeContext.dbCache.getEntry = vi.fn().mockResolvedValue({
            data: { cached: true },
            etag: '"etag-v1"',
            timestamp: 123,
        });
        sandbox.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

        await expect(
            request('/api/bootstrap-lite', { _allowCacheFallback: false })
        ).rejects.toThrow();
    });

    test('concurrent GET requests share the same in-flight promise and retry after failure', async () => {
        let resolveCacheEntry;
        const cacheEntryPromise = new Promise((resolve) => {
            resolveCacheEntry = resolve;
        });
        sandbox.portalRuntimeContext.dbCache.getEntry = vi.fn().mockReturnValue(cacheEntryPromise);

        let resolveFetch;
        const sharedPromise = new Promise((resolve) => {
            resolveFetch = resolve;
        });
        let resolveFetchStart;
        const fetchStarted = new Promise((resolve) => {
            resolveFetchStart = resolve;
        });
        let fetchCallCount = 0;
        sandbox.fetch = vi.fn().mockImplementation(() => {
            fetchCallCount += 1;
            resolveFetchStart();
            return sharedPromise;
        });

        const first = request('/api/bootstrap-core');
        const second = request('/api/bootstrap-core');

        resolveCacheEntry(null);
        await fetchStarted;

        expect(fetchCallCount).toBe(1);

        resolveFetch({
            ok: true,
            status: 200,
            headers: {
                get: (name) => (name === 'content-type' ? 'application/json' : null),
            },
            json: async () => ({ ok: true }),
        });

        await expect(first).resolves.toEqual({ ok: true });
        await expect(second).resolves.toEqual({ ok: true });
        expect(sandbox.portalRuntimeContext.inFlightGetRequests.size).toBe(0);
    });

    test('failed GET clears in-flight state so the next call retries', async () => {
        sandbox.portalRuntimeContext.dbCache.getEntry = vi.fn().mockResolvedValue(null);
        sandbox.fetch = vi.fn()
            .mockRejectedValueOnce(new TypeError('temporary failure'))
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                headers: {
                    get: (name) => (name === 'content-type' ? 'application/json' : null),
                },
                json: async () => ({ ok: true }),
            });

        await expect(request('/api/bootstrap-core')).rejects.toThrow();
        await expect(request('/api/bootstrap-core')).resolves.toEqual({ ok: true });
        expect(sandbox.fetch).toHaveBeenCalledTimes(2);
    });
});
