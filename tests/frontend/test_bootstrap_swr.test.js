const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(
    path.resolve(__dirname, '../../src/static/js/modules/bootstrap_loader.js'),
    'utf8'
);

function createDeferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function createSandbox({
    cachedEntry = null,
    requestImpl = async () => ({ performances: [{ id: 'latest' }] }),
    portalAuthVerified = true,
} = {}) {
    const dbCache = {
        getEntry: vi.fn().mockResolvedValue(cachedEntry),
        delete: vi.fn().mockResolvedValue(undefined),
    };

    const sandbox = {
        window: null,
        globalThis: null,
        document: {
            addEventListener: vi.fn(),
        },
        requestIdleCallback: vi.fn((callback) => callback()),
        console: {
            warn: vi.fn(),
            error: vi.fn(),
            log: vi.fn(),
        },
        setLoadingBar: vi.fn(),
        clearLoadingBar: vi.fn(),
        request: vi.fn(requestImpl),
        requestJson: vi.fn(),
        confirm: vi.fn(() => true),
    };

    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;

    sandbox.portalRuntimeContext = {
        appState: {
            portalAuthVerified,
            lastEssentialDataLoadedAt: 0,
        },
        getById: vi.fn(() => null),
        dbCache,
    };

    sandbox.portalStartup = {
        mark: vi.fn(),
        ready: vi.fn(),
    };

    vm.runInNewContext(SOURCE, sandbox);

    sandbox.applyBootstrapData = vi.fn();
    sandbox.renderEssentialViews = vi.fn();

    return {
        sandbox,
        dbCache,
    };
}

describe('bootstrap-lite stale-while-revalidate', () => {
    test('cached data is rendered and startup is released before network revalidation completes', async () => {
        const cachedData = {
            performances: [{ id: 'cached' }],
        };
        const latestData = {
            performances: [{ id: 'latest' }],
        };
        const deferred = createDeferred();

        const { sandbox } = createSandbox({
            cachedEntry: {
                data: cachedData,
                etag: '"etag-v1"',
                timestamp: 123,
            },
            requestImpl: () => deferred.promise,
        });

        const loadPromise = sandbox.loadEssentialData({
            useCachedPreview: true,
        });

        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(sandbox.applyBootstrapData).toHaveBeenCalledWith(cachedData);
        expect(sandbox.renderEssentialViews).toHaveBeenCalledTimes(1);
        expect(sandbox.portalStartup.ready).toHaveBeenCalledTimes(1);

        expect(sandbox.request).toHaveBeenCalledWith(
            '/api/bootstrap-lite',
            { _allowCacheFallback: false }
        );

        expect(sandbox.clearLoadingBar).not.toHaveBeenCalled();

        deferred.resolve(latestData);
        await loadPromise;

        expect(sandbox.applyBootstrapData).toHaveBeenLastCalledWith(latestData);
        expect(sandbox.renderEssentialViews).toHaveBeenCalledTimes(2);
        expect(sandbox.clearLoadingBar).toHaveBeenCalledTimes(1);
        expect(sandbox.portalRuntimeContext.appState.lastEssentialDataLoadedAt).toBeGreaterThan(0);
    });

    test('network revalidation failure keeps the cached screen visible', async () => {
        const cachedData = {
            performances: [{ id: 'cached' }],
        };

        const { sandbox } = createSandbox({
            cachedEntry: {
                data: cachedData,
                etag: '"etag-v1"',
                timestamp: 123,
            },
            requestImpl: async () => {
                throw new TypeError('Failed to fetch');
            },
        });

        await sandbox.loadEssentialData({
            useCachedPreview: true,
        });

        expect(sandbox.applyBootstrapData).toHaveBeenCalledTimes(1);
        expect(sandbox.applyBootstrapData).toHaveBeenCalledWith(cachedData);
        expect(sandbox.renderEssentialViews).toHaveBeenCalledTimes(1);
        expect(sandbox.portalStartup.ready).toHaveBeenCalledTimes(1);
        expect(sandbox.clearLoadingBar).not.toHaveBeenCalled();
        expect(sandbox.portalRuntimeContext.appState.lastEssentialDataLoadedAt).toBe(0);

        const lastLoadingCall =
            sandbox.setLoadingBar.mock.calls.at(-1);

        expect(lastLoadingCall[0]).toContain(
            '最新データの取得に失敗'
        );
    });

    test('cached render failure deletes the cache and falls back to network data', async () => {
        const cachedData = {
            performances: [{ id: 'cached' }],
        };
        const latestData = {
            performances: [{ id: 'latest' }],
        };

        const { sandbox, dbCache } = createSandbox({
            cachedEntry: {
                data: cachedData,
                etag: '"etag-v1"',
                timestamp: 123,
            },
            requestImpl: async () => latestData,
        });

        sandbox.renderEssentialViews
            .mockImplementationOnce(() => {
                throw new Error('cached render failed');
            })
            .mockImplementation(() => {});

        await sandbox.loadEssentialData({
            useCachedPreview: true,
        });

        expect(dbCache.delete).toHaveBeenCalledWith('/api/bootstrap-lite');

        expect(sandbox.request).toHaveBeenCalledWith(
            '/api/bootstrap-lite',
            {}
        );

        expect(sandbox.applyBootstrapData).toHaveBeenLastCalledWith(latestData);
        expect(sandbox.portalStartup.ready).not.toHaveBeenCalled();
        expect(sandbox.clearLoadingBar).toHaveBeenCalledTimes(1);
    });

    test('normal essential load does not use cached preview', async () => {
        const cachedData = {
            performances: [{ id: 'cached' }],
        };
        const latestData = {
            performances: [{ id: 'latest' }],
        };

        const { sandbox, dbCache } = createSandbox({
            cachedEntry: {
                data: cachedData,
                etag: '"etag-v1"',
                timestamp: 123,
            },
            requestImpl: async () => latestData,
        });

        await sandbox.loadEssentialData();

        expect(dbCache.getEntry).not.toHaveBeenCalled();

        expect(sandbox.request).toHaveBeenCalledWith(
            '/api/bootstrap-lite',
            {}
        );

        expect(sandbox.applyBootstrapData).toHaveBeenCalledTimes(1);
        expect(sandbox.applyBootstrapData).toHaveBeenCalledWith(latestData);
        expect(sandbox.portalStartup.ready).not.toHaveBeenCalled();
    });

    test('background load does not prefetch deferred collections', async () => {
        const { sandbox } = createSandbox({
            requestImpl: async () => ({ extras: {} }),
        });

        await sandbox.loadFullDataInBackground();

        expect(sandbox.request).toHaveBeenCalledTimes(1);
        expect(sandbox.request).toHaveBeenCalledWith('/api/bootstrap-core', {});
        expect(
            sandbox.request.mock.calls.some(
                ([url]) => String(url || '').startsWith('/api/extra/')
            )
        ).toBe(false);
        expect(
            sandbox.request.mock.calls.some(([url]) => url === '/api/events')
        ).toBe(false);
    });

    test('full bootstrap failure does not fan out into individual API requests', async () => {
        const { sandbox } = createSandbox({
            requestImpl: async () => {
                throw new Error('bootstrap unavailable');
            },
        });

        await expect(sandbox.loadAll({ includeHeavyLists: true }))
            .rejects.toThrow('bootstrap unavailable');

        expect(sandbox.request).toHaveBeenCalledTimes(1);
        expect(sandbox.request).toHaveBeenCalledWith('/api/bootstrap', {});
    });

    test('bootstrap-core failure does not fan out and background loading stays fail-soft', async () => {
        const { sandbox } = createSandbox({
            requestImpl: async () => {
                throw new Error('bootstrap-core unavailable');
            },
        });

        sandbox.loadFullDataInBackground();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(sandbox.request).toHaveBeenCalledTimes(1);
        expect(sandbox.request).toHaveBeenCalledWith('/api/bootstrap-core', {});
        expect(sandbox.console.warn).toHaveBeenCalledWith(
            'Background data load failed',
            expect.any(Error)
        );
        expect(sandbox.portalRuntimeContext.appState.dataLoaded).not.toBe(true);
        expect(sandbox.portalRuntimeContext.appState.fullDataLoading).toBe(false);
    });

    test('cached preview is not used before portal authentication is verified', async () => {
        const latestData = {
            performances: [{ id: 'latest' }],
        };

        const { sandbox, dbCache } = createSandbox({
            cachedEntry: {
                data: {
                    performances: [{ id: 'cached' }],
                },
                etag: '"etag-v1"',
                timestamp: 123,
            },
            portalAuthVerified: false,
            requestImpl: async () => latestData,
        });

        await sandbox.loadEssentialData({
            useCachedPreview: true,
        });

        expect(dbCache.getEntry).not.toHaveBeenCalled();
        expect(sandbox.applyBootstrapData).toHaveBeenCalledTimes(1);
        expect(sandbox.applyBootstrapData).toHaveBeenCalledWith(latestData);
        expect(sandbox.portalStartup.ready).not.toHaveBeenCalled();
    });

    test('invalid cached entry is deleted before falling back to network data', async () => {
        const latestData = {
            performances: [{ id: 'latest' }],
        };

        const { sandbox, dbCache } = createSandbox({
            cachedEntry: {
                data: null,
                etag: null,
                timestamp: null,
                invalid: true,
            },
            requestImpl: async () => latestData,
        });

        await sandbox.loadEssentialData({
            useCachedPreview: true,
        });

        expect(dbCache.delete).toHaveBeenCalledWith('/api/bootstrap-lite');
        expect(sandbox.request).toHaveBeenCalledWith(
            '/api/bootstrap-lite',
            {}
        );
        expect(sandbox.applyBootstrapData).toHaveBeenCalledWith(latestData);
        expect(sandbox.clearLoadingBar).toHaveBeenCalledTimes(1);
    });

    test('latest apply failure deletes invalid cache and restores cached preview', async () => {
        const cachedData = {
            performances: [{ id: 'cached' }],
        };
        const latestData = {
            performances: [{ id: 'latest' }],
        };

        const { sandbox, dbCache } = createSandbox({
            cachedEntry: {
                data: cachedData,
                etag: '"etag-v1"',
                timestamp: 123,
            },
            requestImpl: async () => latestData,
        });

        sandbox.applyBootstrapData
            .mockImplementationOnce(() => {})
            .mockImplementationOnce(() => {
                throw new Error('latest apply failed');
            })
            .mockImplementation(() => {});

        await sandbox.loadEssentialData({
            useCachedPreview: true,
        });

        expect(dbCache.delete).toHaveBeenCalledWith('/api/bootstrap-lite');
        expect(sandbox.applyBootstrapData).toHaveBeenLastCalledWith(cachedData);
        expect(sandbox.renderEssentialViews).toHaveBeenCalledTimes(2);
        expect(sandbox.clearLoadingBar).not.toHaveBeenCalled();
        expect(
            sandbox.portalRuntimeContext.appState.lastEssentialDataLoadedAt
        ).toBe(0);
    });
});
