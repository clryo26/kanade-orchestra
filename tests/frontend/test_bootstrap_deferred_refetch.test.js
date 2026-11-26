const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.resolve(__dirname,
    '../../src/static/js/modules/bootstrap_loader.js'), 'utf8');
const RESUME_SOURCE = fs.readFileSync(path.resolve(__dirname,
    '../../src/static/js/modules/common_helpers/bootstrap_init.js'), 'utf8');
const fullPayments = [{ member_id: 'one' }, { member_id: 'two' }];
const lite = () => ({ performances: [{ id: 'latest' }], extras: { payments: [fullPayments[0]] } });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function createBootstrapSandbox() {
    const appState = {
        essentialDataLoaded: true, currentUserMemberId: 'one',
        currentUserPermission: '管理者', portalAuthGeneration: 1,
        payments: [], castings: [], events: [], authDevices: [],
    };
    // Per-URL handlers support delayed results, failures and option inspection.
    const handlers = new Map();
    const request = vi.fn((url, options) => {
        if (handlers.has(url)) return handlers.get(url)(options);
        return Promise.resolve(url === '/api/bootstrap-lite' ? lite() : [{ sourceUrl: url }]);
    });
    const sandbox = { console: { warn: vi.fn() }, request,
        document: { addEventListener: vi.fn() },
        portalRuntimeContext: { appState, getById: () => null,
            dbCache: { getEntry: vi.fn(), delete: vi.fn() } },
        portalCacheIdentity: () => [appState.currentUserMemberId,
            appState.currentUserPermission, appState.portalAuthGeneration],
    };
    for (const name of ['setLoadingBar', 'clearLoadingBar', 'refreshPartSelectOptions',
        'refreshVenueOptions', 'applyOrgSettings', 'updateCloudRunRevision',
        'updateManagerNavigationVisibility', 'showAlert', 'renderEvents',
        'renderAuthDevices', 'renderMemberExtraViews', 'renderPaymentAdmin',
        'renderCastingAdmin', 'renderVenueManagement',
        'renderFlyerDistributionManagement']) sandbox[name] = vi.fn();
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.runInNewContext(SOURCE, sandbox);
    sandbox.renderEssentialViews = vi.fn();
    // Reuse the context created by runInNewContext through an explicit accessor.
    sandbox.readDeferredFlags = vm.runInNewContext('() => ({ ...deferredPortalDataFlags })', sandbox);
    const calls = url => request.mock.calls.filter(call => call[0] === url);
    return { s: sandbox, appState, request, handlers, calls, flags: sandbox.readDeferredFlags };
}

describe('bootstrap-lite deferred refetch', () => {
    test('resets every flag without clearing collections', async () => {
        const { s, appState, flags } = createBootstrapSandbox();
        for (const name of Object.keys(flags())) s.markDeferredPortalDataLoaded(name);
        const old = [{ id: 'old' }];
        appState.castings = old;
        await s.loadEssentialData();
        expect(Object.values(flags()).every(value => value === false)).toBe(true);
        expect(appState.castings).toBe(old);
    });

    test('preserves full payments, deduplicates the visible payment reload and never mutates the response', async () => {
        const { s, appState, handlers, calls } = createBootstrapSandbox();
        handlers.set('/api/extra/payments', () => fullPayments);
        await s.loadExtraData(['payments']);
        const response = Object.freeze({ extras: Object.freeze({ payments: Object.freeze([fullPayments[0]]) }) });
        handlers.set('/api/bootstrap-lite', () => response);
        const pending = deferred();
        handlers.set('/api/extra/payments', () => pending.promise);
        appState.currentPortalTab = { tabName: 'payment-admin' };
        await s.loadEssentialData();
        await tick();
        expect(appState.payments).toEqual(fullPayments);
        expect(response.extras.payments).toHaveLength(1);
        expect(calls('/api/extra/payments')).toHaveLength(2);
        const latest = [{ member_id: 'one', updated: true }, fullPayments[1]];
        pending.resolve(latest);
        await tick();
        expect(appState.payments).toEqual(latest);
    });

    test('failed and overlapping payment refetches keep full-list protection', async () => {
        const { s, appState, handlers } = createBootstrapSandbox();
        handlers.set('/api/extra/payments', () => fullPayments);
        await s.loadExtraData(['payments']);
        handlers.set('/api/extra/payments', () => Promise.reject(new Error('offline')));
        await s.loadEssentialData();
        await tick();
        expect(s.showAlert).toHaveBeenCalled();
        const pending = deferred();
        handlers.set('/api/extra/payments', () => pending.promise);
        await s.loadEssentialData();
        await tick();
        expect(appState.payments).toEqual(fullPayments);
        await s.loadEssentialData();
        await tick();
        expect(appState.payments).toEqual(fullPayments);
        pending.resolve(fullPayments);
        await tick();
        expect(appState.payments).toEqual(fullPayments);
    });

    test.each(['currentUserMemberId', 'currentUserPermission', 'portalAuthGeneration', 'portalAuthTransition'])(
        'does not protect another auth context after %s changes', async key => {
            const { s, appState, handlers, calls } = createBootstrapSandbox();
            handlers.set('/api/extra/payments', () => fullPayments);
            await s.loadExtraData(['payments']);
            appState[key] = 'changed';
            await s.loadEssentialData();
            await tick();
            expect(appState.payments).toEqual([fullPayments[0]]);
            expect(calls('/api/extra/payments')).toHaveLength(1);
        });

    test('an old generation is discarded and retried once without marking its value loaded', async () => {
        const { s, appState, handlers, calls } = createBootstrapSandbox();
        const old = deferred(), latest = deferred();
        handlers.set('/api/extra/castings', () => old.promise);
        const loading = s.loadExtraData(['castings']);
        await tick();
        await s.loadEssentialData();
        handlers.set('/api/extra/castings', () => latest.promise);
        old.resolve([{ id: 'old' }]);
        await tick();
        expect(appState.castings).toEqual([]);
        expect(s.isDeferredPortalDataLoaded('castings')).toBe(false);
        expect(calls('/api/extra/castings')).toHaveLength(2);
        latest.resolve([{ id: 'new' }]);
        await loading;
        expect(appState.castings).toEqual([{ id: 'new' }]);
        expect(s.isDeferredPortalDataLoaded('castings')).toBe(true);
    });

    test('opening after reset bypasses an older in-flight GET without mutating options', async () => {
        const { s, appState, handlers, calls } = createBootstrapSandbox();
        const old = deferred();
        handlers.set('/api/extra/castings', () => old.promise);
        const loading = s.loadExtraData(['castings']);
        await tick();
        await s.loadEssentialData();
        handlers.set('/api/extra/castings', () => [{ id: 'new' }]);
        const options = Object.freeze({ _requestOrigin: 'automatic' });
        await s.ensureDeferredTabDataLoaded('casting-admin', options);
        expect(calls('/api/extra/castings')[1][1]).toMatchObject({ _forceRevalidate: true, _requestOrigin: 'automatic' });
        old.resolve([{ id: 'old' }]);
        await loading;
        expect(appState.castings).toEqual([{ id: 'new' }]);
    });

    test('only the visible collection reloads immediately; other tabs load on opening', async () => {
        const { s, appState, calls } = createBootstrapSandbox();
        appState.currentPortalTab = { tabName: 'casting-admin' };
        await s.loadEssentialData({ _requestOrigin: 'automatic' });
        await tick();
        expect(calls('/api/extra/castings')[0][1]).toMatchObject({ _forceRevalidate: true, _requestOrigin: 'automatic' });
        expect(calls('/api/extra/venue_settings')).toHaveLength(0);
        await s.ensureDeferredTabDataLoaded('venue-admin');
        expect(calls('/api/extra/venue_settings')).toHaveLength(1);
    });

    test.each([
        ['event', '/api/events', 'loadEvents', 'events', 'renderEvents'],
        ['system-auth', '/api/auth/devices', 'loadAuthManagement', 'authDevices', 'renderAuthDevices'],
    ])('%s forwards refetch options and rejects older responses', async (tabName, url, loader, key, render) => {
        const { s, appState, handlers, calls } = createBootstrapSandbox();
        const old = deferred();
        handlers.set(url, () => old.promise);
        const loading = s[loader]();
        expect(calls(url)[0]).toEqual([url]);
        handlers.set(url, () => [{ id: 'new' }]);
        appState.currentPortalTab = { tabName };
        await s.loadEssentialData({ _requestOrigin: 'automatic' });
        await tick();
        expect(calls(url)[1][1]).toEqual({ _forceRevalidate: true, _requestOrigin: 'automatic' });
        const renderCount = s[render].mock.calls.length;
        old.resolve([{ id: 'old' }]);
        await loading;
        expect(appState[key]).toEqual([{ id: 'new' }]);
        expect(s[render]).toHaveBeenCalledTimes(renderCount);
    });

    test.each([
        ['loadEvents', '/api/events', 'events'],
        ['loadAuthManagement', '/api/auth/devices', 'authDevices'],
    ])('%s may render across reset but cannot mark the new generation loaded', async (loader, url, key) => {
        const { s, appState, handlers } = createBootstrapSandbox();
        const pending = deferred();
        handlers.set(url, () => pending.promise);
        const loading = s[loader]();
        s.resetDeferredPortalDataFlags();
        pending.resolve([{ id: 'old-generation' }]);
        await loading;
        expect(appState[key]).toEqual([{ id: 'old-generation' }]);
        expect(s.isDeferredPortalDataLoaded(key)).toBe(false);
    });

    test.each(['startup', 'relogin'])('%s applies personal payments without deferred requests', async () => {
        const { s, appState, handlers, request } = createBootstrapSandbox();
        handlers.set('/api/extra/payments', () => fullPayments);
        await s.loadExtraData(['payments']);
        appState.essentialDataLoaded = false;
        appState.currentPortalTab = { tabName: 'payment-admin' };
        request.mockClear();
        await s.loadEssentialData();
        await tick();
        expect(request.mock.calls.map(call => call[0])).toEqual(['/api/bootstrap-lite']);
        expect(appState.payments).toEqual([fullPayments[0]]);
        expect(s.isAllPaymentsHeld()).toBe(false);
    });

    test('bootstrap request failure leaves state and flags untouched and propagates', async () => {
        const { s, appState, handlers, flags } = createBootstrapSandbox();
        s.markDeferredPortalDataLoaded('castings');
        const before = JSON.stringify(appState), beforeFlags = flags();
        handlers.set('/api/bootstrap-lite', () => Promise.reject(new Error('offline')));
        await expect(s.loadEssentialData()).rejects.toThrow('offline');
        expect(JSON.stringify(appState)).toBe(before);
        expect(flags()).toEqual(beforeFlags);
    });

    test('normal render failure propagates without rollback, reset or refetch', async () => {
        const { s, appState, request, flags } = createBootstrapSandbox();
        s.markDeferredPortalDataLoaded('castings');
        const beforeFlags = flags();
        appState.currentPortalTab = { tabName: 'casting-admin' };
        s.renderEssentialViews.mockImplementation(() => { throw new Error('render'); });
        await expect(s.loadEssentialData()).rejects.toThrow('render');
        await tick();
        expect(appState.performances).toEqual([{ id: 'latest' }]);
        expect(flags()).toEqual(beforeFlags);
        expect(request).toHaveBeenCalledTimes(1);
    });

    test('normal apply failure propagates without resetting flags or starting refetches', async () => {
        const { s, appState, flags, request } = createBootstrapSandbox();
        s.markDeferredPortalDataLoaded('castings');
        const beforeFlags = flags();
        appState.currentPortalTab = { tabName: 'casting-admin' };
        s.refreshPartSelectOptions.mockImplementation(() => { throw new Error('apply'); });
        await expect(s.loadEssentialData()).rejects.toThrow('apply');
        await tick();
        expect(appState.performances).toEqual([{ id: 'latest' }]);
        expect(flags()).toEqual(beforeFlags);
        expect(request).toHaveBeenCalledTimes(1);
    });

    test('SWR latest render failure restores the preview without resetting flags', async () => {
        const { s, appState, flags, request } = createBootstrapSandbox();
        appState.essentialDataLoaded = false;
        appState.portalAuthVerified = true;
        appState.currentPortalTab = { tabName: 'casting-admin' };
        s.markDeferredPortalDataLoaded('castings');
        const beforeFlags = flags();
        const cached = { performances: [{ id: 'cached' }], extras: { payments: [fullPayments[0]] } };
        s.portalRuntimeContext.dbCache.getEntry.mockResolvedValue({ data: cached });
        s.renderEssentialViews.mockImplementationOnce(() => {})
            .mockImplementationOnce(() => { throw new Error('latest render'); });
        await s.loadEssentialData({ useCachedPreview: true });
        await tick();
        expect(appState.performances).toEqual([{ id: 'cached' }]);
        expect(appState.payments).toEqual([fullPayments[0]]);
        expect(s.isAllPaymentsHeld()).toBe(false);
        expect(flags()).toEqual(beforeFlags);
        expect(request).toHaveBeenCalledTimes(1);
    });

    test.each(['loadEvents', 'loadAuthManagement'])('%s propagates request errors and filters options', async loader => {
        const { s, request } = createBootstrapSandbox();
        request.mockRejectedValueOnce(new Error('offline'));
        await expect(s[loader]({ _requestOrigin: 'automatic', _forceRevalidate: true, ignored: true }))
            .rejects.toThrow('offline');
        expect(request.mock.calls[0][1]).toEqual({ _requestOrigin: 'automatic', _forceRevalidate: true });
    });
});

describe('deferred loading unchanged behavior', () => {
    // Exercise real loaders so request URLs, flags and renderer effects stay linked.
    test.each([
        ['event', ['/api/events']],
        ['member-event', ['/api/events', '/api/extra/event_responses']],
        ['member-schedule', ['/api/extra/absences']],
        ['member-absence', ['/api/extra/absences']],
        ['member-date-adjustment', ['/api/extra/date_adjustments', '/api/extra/date_adjustment_responses']],
        ['member-piece-info', ['/api/extra/piece_infos']],
        ['member-practice-instruction', ['/api/extra/piece_infos', '/api/extra/practice_instructions']],
        ['member-performance-day', ['/api/extra/performance_day_infos']],
        ['performance-day-admin', ['/api/extra/performance_day_infos']],
        ['member-casting', ['/api/extra/castings']],
        ['casting-admin', ['/api/extra/castings']],
        ['member-album', ['/api/extra/albums']],
        ['member-flyer-distribution', ['/api/extra/flyer_distributions', '/api/extra/flyer_distribution_assignments']],
        ['flyer-distribution-admin', ['/api/extra/flyer_distributions']],
        ['member-concert-record', ['/api/extra/concert_record_videos']],
        ['concert-record-admin', ['/api/extra/concert_record_videos']],
        ['payment-admin', ['/api/extra/payments', '/api/extra/castings']],
        ['payment-setting', ['/api/extra/payments', '/api/extra/castings']],
        ['member-payment', ['/api/extra/castings']],
        ['member-desired-piece', ['/api/extra/desired_pieces']],
        ['member-promotion', ['/api/extra/promotions']],
        ['venue-admin', ['/api/extra/venue_settings']],
        ['performance', ['/api/extra/venue_settings']],
        ['schedule', ['/api/extra/venue_settings']],
        ['system-connection', ['/api/extra/connection_settings']],
        ['system-auth', ['/api/auth/devices']],
        ['member-home', []],
    ])('%s keeps its request mapping and skips already loaded data', async (tabName, urls) => {
        const { s, request } = createBootstrapSandbox();
        await s.ensureDeferredTabDataLoaded(tabName);
        expect(request.mock.calls.map(([url]) => url)).toEqual(urls);
        for (const [url, options] of request.mock.calls) {
            if (url.startsWith('/api/extra/')) {
                expect(options).toEqual({ _retryContext: expect.any(Object) });
            } else {
                expect(options).toBeUndefined();
            }
        }
        await s.ensureDeferredTabDataLoaded(tabName);
        expect(request.mock.calls.map(([url]) => url)).toEqual(urls);
    });

    test('partial payment load warns, retains data and retries only the failed collection', async () => {
        const { s, appState, handlers, request } = createBootstrapSandbox();
        const previous = [{ member_id: 'one', amount: 100 }];
        appState.payments = previous;
        handlers.set('/api/extra/payments', () => Promise.reject(new Error('offline')));
        await s.ensureDeferredTabDataLoaded('payment-admin');
        expect(appState.payments).toBe(previous);
        expect(s.isDeferredPortalDataLoaded('payments')).toBe(false);
        expect(s.isDeferredPortalDataLoaded('castings')).toBe(true);
        expect(s.showAlert).toHaveBeenCalledWith(expect.stringContaining('payments'), 'warning');
        handlers.set('/api/extra/payments', () => []);
        await s.ensureDeferredTabDataLoaded('payment-setting');
        await s.ensureDeferredTabDataLoaded('payment-admin');
        expect(request.mock.calls.map(([url]) => url)).toEqual([
            '/api/extra/payments', '/api/extra/castings', '/api/extra/payments',
        ]);
        expect(appState.payments).toEqual([]);
        expect(s.isDeferredPortalDataLoaded('payments')).toBe(true);
        expect(s.showAlert).toHaveBeenCalledTimes(1);
    });

    test('concurrent payment screens share requests and apply each response once', async () => {
        const { s, handlers, request } = createBootstrapSandbox();
        const gate = deferred();
        handlers.set('/api/extra/payments', () => gate.promise);
        handlers.set('/api/extra/castings', () => gate.promise);
        const first = s.ensureDeferredTabDataLoaded('payment-admin');
        const second = s.ensureDeferredTabDataLoaded('payment-setting');
        await tick();
        expect(request.mock.calls.map(([url]) => url)).toEqual(['/api/extra/payments', '/api/extra/castings']);
        gate.resolve([]);
        await Promise.all([first, second]);
        expect(s.renderCastingAdmin).toHaveBeenCalledTimes(1);
        expect(s.renderMemberExtraViews).toHaveBeenCalledTimes(1);
        expect(s.showAlert).not.toHaveBeenCalled();
    });

    test('503 waiting preserves displayed data and does not redraw, warn or mark loaded', async () => {
        const { s, appState, handlers, calls } = createBootstrapSandbox();
        const previous = [{ id: 'visible' }];
        appState.castings = previous;
        handlers.set('/api/extra/castings', () => Promise.reject(Object.assign(
            new Error('waiting'), { portalRetryWait: { blocked: true, suppressed: true } }
        )));
        await s.ensureDeferredTabDataLoaded('casting-admin');
        expect(appState.castings).toBe(previous);
        expect(s.isDeferredPortalDataLoaded('castings')).toBe(false);
        expect(calls('/api/extra/castings')).toHaveLength(1);
        expect(s.renderMemberExtraViews).not.toHaveBeenCalled();
        expect(s.renderCastingAdmin).not.toHaveBeenCalled();
        expect(s.showAlert).not.toHaveBeenCalled();
    });

    test.each(['response', 'context error'])('a save discarding a %s retries once, then warns on a second discard', async mode => {
        const { s, appState, handlers, calls } = createBootstrapSandbox();
        const previous = [{ id: 'visible' }];
        appState.castings = previous;
        handlers.set('/api/extra/castings', () => {
            s.portalResponseEpoch = (s.portalResponseEpoch || 0) + 1;
            if (mode === 'context error') {
                throw Object.assign(new Error('saved'), { portalContextChanged: true });
            }
            return [{ id: 'discarded' }];
        });
        await s.loadExtraData(['castings']);
        expect(calls('/api/extra/castings')).toHaveLength(2);
        expect(appState.castings).toBe(previous);
        expect(s.isDeferredPortalDataLoaded('castings')).toBe(false);
        expect(s.renderCastingAdmin).not.toHaveBeenCalled();
        expect(s.showAlert).toHaveBeenCalledTimes(1);
        expect(s.showAlert).toHaveBeenCalledWith(expect.stringContaining('castings'), 'warning');
    });

    test('a save retries an unloaded collection in the new response epoch and applies the result', async () => {
        const { s, appState, handlers, calls } = createBootstrapSandbox();
        const old = deferred();
        handlers.set('/api/extra/castings', () => old.promise);
        const loading = s.loadExtraData(['castings']);
        await tick();
        s.portalResponseEpoch = 1;
        handlers.set('/api/extra/castings', () => [{ id: 'fresh' }]);
        old.resolve([{ id: 'stale' }]);
        await loading;
        expect(calls('/api/extra/castings')).toHaveLength(2);
        expect(appState.castings).toEqual([{ id: 'fresh' }]);
        expect(s.isDeferredPortalDataLoaded('castings')).toBe(true);
        expect(s.renderCastingAdmin).toHaveBeenCalledTimes(1);
        expect(s.showAlert).not.toHaveBeenCalled();
    });

    test.each(['currentUserMemberId', 'currentUserPermission', 'portalAuthGeneration'])(
        'discards in-flight extra responses without retry after %s changes', async key => {
            const { s, appState, handlers, calls } = createBootstrapSandbox();
            const gate = deferred(), previous = [{ id: 'visible' }];
            appState.castings = previous;
            handlers.set('/api/extra/castings', () => gate.promise);
            const loading = s.loadExtraData(['castings']);
            await tick();
            appState[key] = 'changed';
            gate.resolve([{ id: 'other-account' }]);
            await loading;
            expect(appState.castings).toBe(previous);
            expect(calls('/api/extra/castings')).toHaveLength(1);
            expect(s.isDeferredPortalDataLoaded('castings')).toBe(false);
            expect(s.renderCastingAdmin).not.toHaveBeenCalled();
            expect(s.showAlert).not.toHaveBeenCalled();
        });

    test.each(['success', 'network failure'])('SWR renders cache before revalidation and preserves it on %s', async outcome => {
        const { s, appState, handlers, request, flags } = createBootstrapSandbox();
        const cached = { performances: [{ id: 'cached' }], extras: { payments: [fullPayments[0]] } };
        appState.essentialDataLoaded = false;
        appState.portalAuthVerified = true;
        appState.currentPortalTab = { tabName: 'casting-admin' };
        s.markDeferredPortalDataLoaded('castings');
        const beforeFlags = flags();
        s.portalRuntimeContext.dbCache.getEntry.mockResolvedValue({ data: cached });
        const gate = deferred();
        handlers.set('/api/bootstrap-lite', () => gate.promise);
        const loading = s.loadEssentialData({ useCachedPreview: true });
        await tick();
        expect(appState.performances).toEqual(cached.performances);
        expect(s.renderEssentialViews).toHaveBeenCalledTimes(1);
        expect(flags()).toEqual(beforeFlags);
        expect(request.mock.calls.map(([url]) => url)).toEqual(['/api/bootstrap-lite']);
        expect(request.mock.calls[0][1]).toMatchObject({ _allowCacheFallback: false });
        if (outcome === 'success') gate.resolve(lite());
        else gate.reject(new Error('offline'));
        await loading;
        await tick();
        expect(appState.performances).toEqual(outcome === 'success' ? lite().performances : cached.performances);
        expect(s.renderEssentialViews).toHaveBeenCalledTimes(outcome === 'success' ? 2 : 1);
        expect(flags()).toEqual(outcome === 'success'
            ? Object.fromEntries(Object.keys(beforeFlags).map(key => [key, false])) : beforeFlags);
        expect(request).toHaveBeenCalledTimes(1);
    });

    test.each([{ invalid: true }, { data: 'broken' }, { data: {} }])(
        'deletes an invalid or unrenderable cache before falling back to network: %j', async entry => {
            const { s, appState, request } = createBootstrapSandbox();
            appState.essentialDataLoaded = false;
            appState.portalAuthVerified = true;
            const cache = s.portalRuntimeContext.dbCache;
            cache.getEntry.mockResolvedValue(entry);
            if (entry.data && typeof entry.data === 'object') {
                s.renderEssentialViews.mockImplementationOnce(() => { throw new Error('broken preview'); });
            }
            await s.loadEssentialData({ useCachedPreview: true });
            expect(cache.delete).toHaveBeenCalledWith('/api/bootstrap-lite');
            expect(appState.performances).toEqual(lite().performances);
            expect(request.mock.calls.map(([url]) => url)).toEqual(['/api/bootstrap-lite']);
        });

    test.each([
        ['fresh auth and data', 1000, 1000, 'visible', 'true', false, false],
        ['stale auth only', 61000, 1000, 'visible', 'true', true, false],
        ['stale data only', 1000, 61000, 'visible', 'true', false, true],
        ['both stale', 61000, 61000, 'visible', 'true', true, true],
        ['hidden', 61000, 61000, 'hidden', 'true', false, false],
        ['logged out', 61000, 61000, 'visible', 'false', false, false],
    ])('resume retains the refresh condition: %s', async (_label, authAge, dataAge, visibility, storedAuth, verify, reload) => {
        const { s, appState, calls } = createBootstrapSandbox();
        const now = Date.now();
        Object.assign(appState, { portalAuthVerified: true,
            lastPortalSessionVerifiedAt: now - authAge, lastEssentialDataLoadedAt: now - dataAge,
            currentPortalTab: { tabName: 'casting-admin' } });
        s.document.visibilityState = visibility;
        s.localStorage = { getItem: () => storedAuth };
        s.portalRuntimeContext.today = () => '2026-11-26';
        s.isPortalAuthenticated = vi.fn(async () => ({ status: 'authenticated' }));
        // Register lifecycle callbacks without executing DOMContentLoaded startup.
        vm.runInNewContext(RESUME_SOURCE, s);
        await s.syncPortalSessionOnResume();
        await tick();
        expect(s.isPortalAuthenticated).toHaveBeenCalledTimes(verify ? 1 : 0);
        if (verify) expect(s.isPortalAuthenticated).toHaveBeenCalledWith({ forceVerify: true, _requestOrigin: 'automatic' });
        expect(calls('/api/bootstrap-lite')).toHaveLength(reload ? 1 : 0);
        expect(calls('/api/extra/castings')).toHaveLength(reload ? 1 : 0);
        if (reload) expect(calls('/api/extra/castings')[0][1]).toMatchObject({ _requestOrigin: 'automatic', _forceRevalidate: true });
    });
});
