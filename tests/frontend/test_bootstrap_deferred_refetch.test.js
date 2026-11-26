const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHttpHarness } = require('./helpers/portal_http_harness.cjs');

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
        'renderFlyerDistributionManagement', 'renderSnsManagement',
        'renderSchedules', 'renderMemberSchedules', 'renderAbsenceView']) sandbox[name] = vi.fn();
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
    test.each(['member-schedule', 'member-absence', 'schedule', 'member-sns', 'system-sns'])(
        'initial bootstrap/login does not start deferred requests for remembered %s', async tabName => {
            const { s, appState, calls } = createBootstrapSandbox();
            appState.essentialDataLoaded = false;
            appState.currentPortalTab = { tabName };
            await s.loadEssentialData();
            await tick();
            expect(calls('/api/schedules')).toHaveLength(0);
            expect(calls('/api/extra/sns_settings')).toHaveLength(0);
            expect(s.isDeferredPortalDataLoaded('schedules')).toBe(false);
            expect(s.isDeferredPortalDataLoaded('snsSettings')).toBe(false);
        });

    test.each([
        ['member-schedule', '/api/schedules', 'schedules'],
        ['member-absence', '/api/schedules', 'schedules'],
        ['schedule', '/api/schedules', 'schedules'],
        ['member-sns', '/api/extra/sns_settings', 'snsSettings'],
        ['system-sns', '/api/extra/sns_settings', 'snsSettings'],
    ])('%s revalidates only its visible deferred data once', async (tabName, url, key) => {
        const { s, appState, calls } = createBootstrapSandbox();
        await s.ensureDeferredTabDataLoaded(tabName);
        expect(s.isDeferredPortalDataLoaded(key)).toBe(true);
        appState.currentPortalTab = { tabName };
        await s.loadEssentialData({ _requestOrigin: 'automatic' });
        await tick();
        expect(calls(url)).toHaveLength(2);
        expect(calls(url)[1][1]).toMatchObject({ _forceRevalidate: true, _requestOrigin: 'automatic' });
        expect(s.isDeferredPortalDataLoaded(key)).toBe(true);
        const other = key === 'schedules' ? '/api/extra/sns_settings' : '/api/schedules';
        expect(calls(other)).toHaveLength(0);
        await s.ensureDeferredTabDataLoaded(tabName);
        expect(calls(url)).toHaveLength(2);
    });

    test('home refetch does not load schedules or SNS', async () => {
        const { s, appState, calls } = createBootstrapSandbox();
        appState.currentPortalTab = { tabName: 'member-home' };
        await s.loadEssentialData();
        await tick();
        expect(calls('/api/schedules')).toHaveLength(0);
        expect(calls('/api/extra/sns_settings')).toHaveLength(0);
    });

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

    test('repeated generation changes retry a discarded extra load only once and retain visible data', async () => {
        const { s, appState, handlers, calls } = createBootstrapSandbox();
        const previous = [{ id: 'visible' }];
        appState.castings = previous;
        handlers.set('/api/extra/castings', () => {
            s.resetDeferredPortalDataFlags();
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

    test('visible events bypass a still-fresh cache after bootstrap refetch', async () => {
        const { s, appState, handlers, calls } = createBootstrapSandbox();
        const cached = [{ id: 'cached' }], latest = [{ id: 'latest' }];
        // Model request() returning its fresh cache unless revalidation is forced.
        handlers.set('/api/events', options => options?._forceRevalidate ? latest : cached);
        await s.ensureDeferredTabDataLoaded('event');
        expect(appState.events).toEqual(cached);
        appState.currentPortalTab = { tabName: 'event' };
        await s.loadEssentialData();
        await tick();
        expect(calls('/api/events')).toHaveLength(2);
        expect(calls('/api/events')[1][1]).toEqual({ _forceRevalidate: true });
        expect(appState.events).toEqual(latest);
        expect(s.isDeferredPortalDataLoaded('events')).toBe(true);
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

describe('payment 403 ownership release', () => {
    test('T1: reopening payment administration after 403 and role recovery reloads everyone', async () => {
        const { s, appState, handlers, calls } = createBootstrapSandbox();
        handlers.set('/api/extra/payments', () => fullPayments);
        await s.loadExtraData(['payments']);
        handlers.set('/api/extra/payments', () => Promise.reject(Object.assign(new Error('forbidden'), { status: 403 })));
        await s.loadExtraData(['payments']);
        expect(appState.payments).toEqual([fullPayments[0]]);
        expect(s.isDeferredPortalDataLoaded('payments')).toBe(false);
        appState.currentUserPermission = '一般';
        appState.currentUserPermission = '管理者';
        const before = calls('/api/extra/payments').length;
        handlers.set('/api/extra/payments', () => fullPayments);
        await s.ensureDeferredTabDataLoaded('payment-admin');
        expect(calls('/api/extra/payments')).toHaveLength(before + 1);
        expect(appState.payments).toEqual(fullPayments);
        expect(s.isDeferredPortalDataLoaded('payments')).toBe(true);
        expect(s.isAllPaymentsHeld()).toBe(true);
    });

    test('T2: account reset replaces private arrays, clears views and retains common data', async () => {
        const { s, appState, handlers, flags } = createBootstrapSandbox();
        handlers.set('/api/extra/payments', () => fullPayments);
        await s.loadExtraData(['payments']);
        const privateData = { payments: appState.payments,
            connectionSettings: [{ secretPlaceholder: 'fixture' }], authDevices: [{ id: 'fixture' }] };
        const privateSnapshot = JSON.parse(JSON.stringify(privateData));
        Object.assign(appState, privateData, { essentialDataLoaded: true, dataLoaded: true, lastEssentialDataLoadedAt: 123 });
        const common = Object.fromEntries(['partSettings', 'orgSettings', 'snsSettings', 'performances',
            'schedules', 'announcements', 'members', 'castings', 'recordings', 'sheetLibrary', 'events']
            .map(key => [key, [{ id: key }]]));
        Object.assign(appState, common, { cloudRunRevision: 'revision' });
        const elements = Object.fromEntries(['memberPerfInfo', 'memberSchedInfo', 'memberAnnounceList',
            'memberPaymentInfo', 'portalHomeMenu'].map(id => [id, { innerHTML: 'old' }]));
        s.$ = id => elements[id] || null;
        s.renderMenuGroups = vi.fn();
        s.renderPortalDrawerMenu = vi.fn();
        for (const key of Object.keys(flags())) s.markDeferredPortalDataLoaded(key);
        s.resetPortalDataForAccountChange();
        for (const [key, original] of Object.entries(privateData)) {
            expect(appState[key]).toEqual([]);
            expect(appState[key]).not.toBe(original);
            expect(original).toEqual(privateSnapshot[key]);
        }
        expect(Object.values(flags())).toEqual(Object.keys(flags()).map(() => false));
        expect(s.isAllPaymentsHeld()).toBe(false);
        expect(appState).toMatchObject({ essentialDataLoaded: false, dataLoaded: false, lastEssentialDataLoadedAt: 0,
            cloudRunRevision: 'revision' });
        for (const [key, original] of Object.entries(common)) expect(appState[key]).toBe(original);
        for (const id of ['memberPerfInfo', 'memberSchedInfo', 'memberAnnounceList', 'memberPaymentInfo']) {
            expect(elements[id].innerHTML).toBe('');
        }
        expect(s.renderMenuGroups).toHaveBeenCalledTimes(1);
        expect(s.renderMenuGroups).toHaveBeenCalledWith(elements.portalHomeMenu);
        expect(s.renderPortalDrawerMenu).toHaveBeenCalledTimes(1);
    });

    test('unmarking payments leaves other flags, generation and full-list ownership intact', async () => {
        const { s, handlers, flags } = createBootstrapSandbox();
        handlers.set('/api/extra/payments', () => fullPayments);
        await s.loadExtraData(['payments']);
        for (const key of Object.keys(flags())) s.markDeferredPortalDataLoaded(key);
        const generation = vm.runInNewContext('deferredPortalDataGeneration', s);
        s.unmarkDeferredPortalDataLoaded('payments');
        s.unmarkDeferredPortalDataLoaded('unknown');
        expect(flags()).toEqual(Object.fromEntries(Object.keys(flags()).map(key => [key, key !== 'payments'])));
        expect(vm.runInNewContext('deferredPortalDataGeneration', s)).toBe(generation);
        expect(s.isAllPaymentsHeld()).toBe(true);
    });

    test('resetDeferredPortalDataFlags advances only the deferred generation and keeps collections and ownership', async () => {
        const { s, appState, handlers, flags } = createBootstrapSandbox();
        handlers.set('/api/extra/payments', () => fullPayments);
        await s.loadExtraData(['payments']);
        const payments = appState.payments;
        const castings = appState.castings;
        for (const key of Object.keys(flags())) s.markDeferredPortalDataLoaded(key);
        const generation = vm.runInNewContext('deferredPortalDataGeneration', s);

        s.resetDeferredPortalDataFlags();

        expect(Object.values(flags()).every(value => value === false)).toBe(true);
        expect(vm.runInNewContext('deferredPortalDataGeneration', s)).toBe(generation + 1);
        expect(appState.payments).toBe(payments);
        expect(appState.castings).toBe(castings);
        expect(appState.essentialDataLoaded).toBe(true);
        expect(s.isAllPaymentsHeld()).toBe(true);
        expect(s.renderEssentialViews).not.toHaveBeenCalled();
    });

    test('request parses the server 403 JSON and the loader releases full payments and redraws', async () => {
        const h = createHttpHarness(() => new Response(JSON.stringify({
            detail: 'Admin permission is required',
        }), { status: 403, headers: { 'Content-Type': 'application/json' } }));
        const err = await h.ctx.request('/api/extra/payments').then(
            () => { throw new Error('Expected the payment request to reject'); },
            error => error,
        );
        expect(err.status).toBe(403);
        expect(err.portalRetryWait).toBeUndefined();
        expect(h.calls).toHaveLength(1);
        expect(h.calls[0].url).toBe('/api/extra/payments');
        expect(h.ctx.showAlert).toHaveBeenCalledTimes(1);
        expect(h.ctx.showAlert).toHaveBeenCalledWith(
            'paymentsの取得に失敗しました。原因: Admin permission is required', 'danger');

        const { s, appState, handlers } = createBootstrapSandbox();
        handlers.set('/api/extra/payments', () => fullPayments);
        await s.loadExtraData(['payments']);
        expect(s.isAllPaymentsHeld()).toBe(true);
        expect(s.isDeferredPortalDataLoaded('payments')).toBe(true);
        s.renderMemberExtraViews.mockClear();
        s.renderPaymentAdmin.mockClear();
        handlers.set('/api/extra/payments', () => Promise.reject(err));

        await s.loadExtraData(['payments']);
        expect(appState.payments).toEqual([fullPayments[0]]);
        expect(fullPayments).toEqual([{ member_id: 'one' }, { member_id: 'two' }]);
        expect(s.isAllPaymentsHeld()).toBe(false);
        // 本人分だけになったので、管理者として開き直したとき全員分を再取得する。
        expect(s.isDeferredPortalDataLoaded('payments')).toBe(false);
        expect(s.renderMemberExtraViews).toHaveBeenCalledTimes(1);
        expect(s.renderMemberExtraViews).toHaveBeenCalledWith({ collections: ['payments'] });
        expect(s.renderPaymentAdmin).toHaveBeenCalledTimes(1);
        expect(s.showAlert).toHaveBeenCalledTimes(1);
        expect(s.showAlert).toHaveBeenCalledWith('一部データの読込に失敗しました: payments', 'warning');
    });

    test('refetch 403 keeps only personal payments without mutation, redraws once and releases protection', async () => {
        const { s, appState, handlers, calls } = createBootstrapSandbox();
        const original = Object.freeze(fullPayments.map(payment => Object.freeze({ ...payment })));
        handlers.set('/api/extra/payments', () => original);
        await s.loadExtraData(['payments']);
        appState.currentPortalTab = { tabName: 'member-home' };
        const response = Object.freeze({ extras: Object.freeze({ payments: Object.freeze([fullPayments[0]]) }) });
        handlers.set('/api/bootstrap-lite', () => response);
        handlers.set('/api/extra/payments', () => Promise.reject(Object.assign(new Error('forbidden'), { status: 403 })));
        s.renderMemberExtraViews.mockClear();
        s.renderPaymentAdmin.mockClear();

        await s.loadEssentialData();
        await tick();
        expect(appState.payments).toEqual([{ member_id: 'one' }]);
        expect(appState.payments).not.toBe(original);
        expect(original).toEqual(fullPayments);
        expect(response.extras.payments).toEqual([fullPayments[0]]);
        expect(s.isAllPaymentsHeld()).toBe(false);
        expect(s.isDeferredPortalDataLoaded('payments')).toBe(false);
        expect(s.renderMemberExtraViews).toHaveBeenCalledTimes(1);
        expect(s.renderMemberExtraViews).toHaveBeenCalledWith({ collections: ['payments'] });
        expect(s.renderPaymentAdmin).toHaveBeenCalledTimes(1);
        expect(s.showAlert).toHaveBeenCalledTimes(1);
        expect(s.showAlert).toHaveBeenCalledWith('一部データの読込に失敗しました: payments', 'warning');
        expect(calls('/api/extra/payments')).toHaveLength(2);

        const nextPersonal = Object.freeze([{ member_id: 'one', updated: true }]);
        handlers.set('/api/bootstrap-lite', () => Object.freeze({ extras: Object.freeze({ payments: nextPersonal }) }));
        await s.loadEssentialData();
        await tick();
        expect(calls('/api/extra/payments')).toHaveLength(2);
        expect(appState.payments).toEqual(nextPersonal);
    });

    test('same-auth 403 after an epoch advance still purges and releases protection', async () => {
        const { s, appState, handlers, calls } = createBootstrapSandbox();
        handlers.set('/api/extra/payments', () => fullPayments);
        await s.loadExtraData(['payments']);
        appState.currentPortalTab = { tabName: 'member-home' };
        const pending = deferred();
        handlers.set('/api/extra/payments', () => pending.promise);
        await s.loadEssentialData();
        await tick();
        s.portalResponseEpoch = (s.portalResponseEpoch || 0) + 1;
        s.renderMemberExtraViews.mockClear();
        s.renderPaymentAdmin.mockClear();
        pending.reject(Object.assign(new Error('forbidden'), { status: 403 }));
        await tick();
        expect(appState.payments).toEqual([fullPayments[0]]);
        expect(s.isAllPaymentsHeld()).toBe(false);
        expect(s.isDeferredPortalDataLoaded('payments')).toBe(false);
        expect(s.renderMemberExtraViews).toHaveBeenCalledTimes(1);
        expect(s.renderPaymentAdmin).toHaveBeenCalledTimes(1);
        expect(s.showAlert).toHaveBeenCalledWith('一部データの読込に失敗しました: payments', 'warning');
        await s.loadEssentialData();
        await tick();
        expect(calls('/api/extra/payments')).toHaveLength(2);
    });

    test('a replaced entry 403 cannot purge or release the held payments', async () => {
        const { s, appState, handlers, calls } = createBootstrapSandbox();
        handlers.set('/api/extra/payments', () => fullPayments);
        await s.loadExtraData(['payments']);
        const old = deferred(), newer = deferred();
        handlers.set('/api/extra/payments', () => old.promise);
        const first = s.loadExtraData(['payments']);
        await tick();
        handlers.set('/api/extra/payments', () => newer.promise);
        const second = s.loadExtraData(['payments'], { _forceRevalidate: true });
        await tick();
        expect(calls('/api/extra/payments')).toHaveLength(3);
        s.renderMemberExtraViews.mockClear();
        s.renderPaymentAdmin.mockClear();
        old.reject(Object.assign(new Error('forbidden'), { status: 403 }));
        await first;
        expect(appState.payments).toBe(fullPayments);
        expect(s.isAllPaymentsHeld()).toBe(true);
        expect(s.renderMemberExtraViews).not.toHaveBeenCalled();
        expect(s.renderPaymentAdmin).not.toHaveBeenCalled();
        expect(s.showAlert).not.toHaveBeenCalled();
        const latest = [{ member_id: 'one', updated: true }, fullPayments[1]];
        newer.resolve(latest);
        await second;
        expect(appState.payments).toEqual(latest);
        expect(s.isAllPaymentsHeld()).toBe(true);
    });

    test.each([
        ['503 retry wait', { status: 503, portalRetryWait: { blocked: true } }],
        ['500', { status: 500 }],
        ['timeout', { name: 'PortalTimeoutError' }],
        ['context change', { portalContextChanged: true }],
    ])('%s preserves full payments and retries on the next bootstrap', async (_label, errorProperties) => {
        const { s, appState, handlers, calls } = createBootstrapSandbox();
        handlers.set('/api/extra/payments', () => fullPayments);
        await s.loadExtraData(['payments']);
        appState.currentPortalTab = { tabName: 'member-home' };
        handlers.set('/api/extra/payments', () => Promise.reject(Object.assign(new Error('failed'), errorProperties)));
        await s.loadEssentialData();
        await tick();
        expect(appState.payments).toBe(fullPayments);
        expect(s.isAllPaymentsHeld()).toBe(true);
        expect(s.isDeferredPortalDataLoaded('payments')).toBe(false);
        expect(calls('/api/extra/payments')).toHaveLength(2);
        await s.loadEssentialData();
        await tick();
        expect(calls('/api/extra/payments')).toHaveLength(3);
        expect(appState.payments).toBe(fullPayments);
        expect(s.isAllPaymentsHeld()).toBe(true);
    });

    test.each([
        ['name fallback', '', 'A', undefined, [{ name: 'A' }]],
        ['member name helper', '', 'B', 'A', [{ name: 'A' }]],
        ['member ID priority', 'one', 'A', undefined, [{ member_id: 'one', name: 'B' }]],
        ['no identity', '', '', undefined, []],
    ])('%s follows the server personal-payment selection', async (_label, memberId, name, helperName, expected) => {
        const { s, appState, handlers } = createBootstrapSandbox();
        appState.currentUserMemberId = memberId;
        appState.currentUserName = name;
        if (helperName !== undefined) s.currentUserMemberName = () => helperName;
        const original = Object.freeze([{ name: 'A' }, { member_id: 'one', name: 'B' }]);
        handlers.set('/api/extra/payments', () => original);
        await s.loadExtraData(['payments']);
        handlers.set('/api/extra/payments', () => Promise.reject(Object.assign(new Error('forbidden'), { status: 403 })));
        await s.loadExtraData(['payments']);
        expect(appState.payments).toEqual(expected);
        expect(appState.payments).not.toBe(original);
        expect(s.isAllPaymentsHeld()).toBe(false);
        expect(s.isDeferredPortalDataLoaded('payments')).toBe(false);
    });

    test('403 after an auth change is discarded without purging or redrawing', async () => {
        const { s, appState, handlers } = createBootstrapSandbox();
        handlers.set('/api/extra/payments', () => fullPayments);
        await s.loadExtraData(['payments']);
        const heldContext = vm.runInNewContext('allPaymentsHeldAuthContext', s);
        const pending = deferred();
        handlers.set('/api/extra/payments', () => pending.promise);
        const loading = s.loadExtraData(['payments']);
        await tick();
        appState.currentUserPermission = '一般';
        s.renderMemberExtraViews.mockClear();
        s.renderPaymentAdmin.mockClear();
        pending.reject(Object.assign(new Error('forbidden'), { status: 403 }));
        await loading;
        expect(appState.payments).toBe(fullPayments);
        expect(vm.runInNewContext('allPaymentsHeldAuthContext', s)).toBe(heldContext);
        expect(s.renderMemberExtraViews).not.toHaveBeenCalled();
        expect(s.renderPaymentAdmin).not.toHaveBeenCalled();
        expect(s.showAlert).not.toHaveBeenCalled();
    });
});

describe('payment ownership unchanged behavior', () => {
    test.each([
        ['network', {}], ['timeout', { name: 'PortalTimeoutError' }],
        ['503 wait', { status: 503, portalRetryWait: { blocked: true } }], ['500', { status: 500 }],
    ])('direct %s failure retains full payments, ownership and the loaded flag', async (_label, properties) => {
        const { s, appState, handlers } = createBootstrapSandbox();
        handlers.set('/api/extra/payments', () => fullPayments);
        await s.loadExtraData(['payments']);
        s.renderMemberExtraViews.mockClear();
        s.renderPaymentAdmin.mockClear();
        handlers.set('/api/extra/payments', () => Promise.reject(Object.assign(new Error('fixture failure'), properties)));
        await s.loadExtraData(['payments']);
        expect(appState.payments).toBe(fullPayments);
        expect(s.isAllPaymentsHeld()).toBe(true);
        expect(s.isDeferredPortalDataLoaded('payments')).toBe(true);
        expect(s.renderMemberExtraViews).not.toHaveBeenCalled();
        expect(s.renderPaymentAdmin).not.toHaveBeenCalled();
    });

    test('payments retry wait preserves ownership without warning, redrawing or marking loaded', async () => {
        const { s, appState, handlers, calls } = createBootstrapSandbox();
        handlers.set('/api/extra/payments', () => fullPayments);
        await s.loadExtraData(['payments']);
        s.resetDeferredPortalDataFlags();
        s.renderMemberExtraViews.mockClear();
        s.renderPaymentAdmin.mockClear();
        handlers.set('/api/extra/payments', () => Promise.reject(Object.assign(new Error('waiting'), {
            status: 503, portalRetryWait: { blocked: true, suppressed: true },
        })));
        await s.loadExtraData(['payments']);
        expect(calls('/api/extra/payments')).toHaveLength(2);
        expect(appState.payments).toBe(fullPayments);
        expect(s.isAllPaymentsHeld()).toBe(true);
        expect(s.isDeferredPortalDataLoaded('payments')).toBe(false);
        expect(s.renderMemberExtraViews).not.toHaveBeenCalled();
        expect(s.renderPaymentAdmin).not.toHaveBeenCalled();
        expect(s.showAlert).not.toHaveBeenCalled();
    });

    test.each(['payment-admin', 'payment-setting'])(
        '%s shares the protected bootstrap reload and applies a successful full list once', async tabName => {
            const { s, appState, handlers, calls } = createBootstrapSandbox();
            const original = Object.freeze(fullPayments.map(payment => Object.freeze({ ...payment })));
            handlers.set('/api/extra/payments', () => original);
            await s.loadExtraData(['payments']);
            const personal = Object.freeze([Object.freeze({ member_id: 'one', source: 'bootstrap' })]);
            const response = Object.freeze({ extras: Object.freeze({ payments: personal }) });
            handlers.set('/api/bootstrap-lite', () => response);
            const pending = deferred();
            handlers.set('/api/extra/payments', () => pending.promise);
            appState.currentPortalTab = { tabName };
            await s.loadEssentialData();
            await tick();
            expect(calls('/api/extra/payments')).toHaveLength(2);
            expect(appState.payments).toBe(original);
            expect(s.isAllPaymentsHeld()).toBe(true);
            expect(s.isDeferredPortalDataLoaded('payments')).toBe(false);
            s.renderMemberExtraViews.mockClear();
            s.renderPaymentAdmin.mockClear();

            const latest = Object.freeze([Object.freeze({ member_id: 'one', updated: true }), fullPayments[1]]);
            pending.resolve(latest);
            await tick();
            expect(appState.payments).toBe(latest);
            expect(s.isAllPaymentsHeld()).toBe(true);
            expect(s.isDeferredPortalDataLoaded('payments')).toBe(true);
            expect(s.renderMemberExtraViews).toHaveBeenCalledTimes(1);
            expect(s.renderPaymentAdmin).toHaveBeenCalledTimes(1);
            expect(s.showAlert).not.toHaveBeenCalled();
            expect(original).toEqual(fullPayments);
            expect(response.extras.payments).toBe(personal);
            expect(personal).toEqual([{ member_id: 'one', source: 'bootstrap' }]);
        });

    test('network failure keeps ownership through overlapping bootstrap refreshes and later success', async () => {
        const { s, appState, handlers, calls } = createBootstrapSandbox();
        handlers.set('/api/extra/payments', () => fullPayments);
        await s.loadExtraData(['payments']);
        appState.currentPortalTab = { tabName: 'member-home' };
        handlers.set('/api/extra/payments', () => Promise.reject(new Error('offline')));
        await s.loadEssentialData();
        await tick();
        expect(appState.payments).toBe(fullPayments);
        expect(s.isAllPaymentsHeld()).toBe(true);
        expect(s.isDeferredPortalDataLoaded('payments')).toBe(false);
        expect(s.showAlert).toHaveBeenCalledTimes(1);
        expect(s.showAlert).toHaveBeenCalledWith('一部データの読込に失敗しました: payments', 'warning');

        const old = deferred(), latest = deferred();
        handlers.set('/api/extra/payments', () => old.promise);
        await s.loadEssentialData();
        await tick();
        handlers.set('/api/extra/payments', () => latest.promise);
        await s.loadEssentialData();
        await tick();
        expect(calls('/api/extra/payments')).toHaveLength(4);
        expect(appState.payments).toBe(fullPayments);
        expect(s.isAllPaymentsHeld()).toBe(true);
        old.resolve([{ member_id: 'two', stale: true }]);
        await tick();
        expect(appState.payments).toBe(fullPayments);
        expect(s.isDeferredPortalDataLoaded('payments')).toBe(false);
        const fresh = [{ member_id: 'one', updated: true }, fullPayments[1]];
        latest.resolve(fresh);
        await tick();
        expect(appState.payments).toBe(fresh);
        expect(s.isAllPaymentsHeld()).toBe(true);
        expect(s.isDeferredPortalDataLoaded('payments')).toBe(true);
        expect(s.showAlert).toHaveBeenCalledTimes(1);
    });

    test.each(['payment-admin', 'payment-setting'])(
        '%s failure warns once and reopening retries only payments', async tabName => {
            const { s, appState, handlers, calls } = createBootstrapSandbox();
            handlers.set('/api/extra/payments', () => fullPayments);
            await s.loadExtraData(['payments']);
            s.resetDeferredPortalDataFlags();
            handlers.set('/api/extra/payments', () => Promise.reject(Object.assign(new Error('failed'), { status: 500 })));
            await s.ensureDeferredTabDataLoaded(tabName);
            expect(appState.payments).toBe(fullPayments);
            expect(s.isAllPaymentsHeld()).toBe(true);
            expect(s.isDeferredPortalDataLoaded('payments')).toBe(false);
            expect(s.isDeferredPortalDataLoaded('castings')).toBe(true);
            expect(s.showAlert).toHaveBeenCalledTimes(1);
            expect(s.showAlert).toHaveBeenCalledWith('一部データの読込に失敗しました: payments', 'warning');
            const fresh = [{ member_id: 'one', updated: true }, fullPayments[1]];
            handlers.set('/api/extra/payments', () => fresh);
            await s.ensureDeferredTabDataLoaded(tabName);
            await s.ensureDeferredTabDataLoaded(tabName);
            expect(calls('/api/extra/payments')).toHaveLength(3);
            expect(calls('/api/extra/castings')).toHaveLength(1);
            expect(appState.payments).toBe(fresh);
            expect(s.isAllPaymentsHeld()).toBe(true);
            expect(s.isDeferredPortalDataLoaded('payments')).toBe(true);
            expect(s.showAlert).toHaveBeenCalledTimes(1);
        });

    test.each(['currentUserMemberId', 'currentUserPermission', 'portalAuthGeneration', 'portalAuthTransition'])(
        'a successful payment response after %s changes is discarded without retry', async key => {
            const { s, appState, handlers, calls } = createBootstrapSandbox();
            handlers.set('/api/extra/payments', () => fullPayments);
            await s.loadExtraData(['payments']);
            s.resetDeferredPortalDataFlags();
            const pending = deferred();
            handlers.set('/api/extra/payments', () => pending.promise);
            const loading = s.loadExtraData(['payments']);
            await tick();
            appState[key] = 'changed';
            s.renderMemberExtraViews.mockClear();
            s.renderPaymentAdmin.mockClear();
            pending.resolve([{ member_id: 'two', stale: true }]);
            await loading;
            expect(appState.payments).toBe(fullPayments);
            expect(s.isAllPaymentsHeld()).toBe(false);
            expect(s.isDeferredPortalDataLoaded('payments')).toBe(false);
            expect(calls('/api/extra/payments')).toHaveLength(2);
            expect(s.renderMemberExtraViews).not.toHaveBeenCalled();
            expect(s.renderPaymentAdmin).not.toHaveBeenCalled();
            expect(s.showAlert).not.toHaveBeenCalled();
        });

    test.each(['success', 'second discard'])(
        'a save retries payments once with the spent retry budget: %s', async outcome => {
            const { s, appState, handlers, calls } = createBootstrapSandbox();
            handlers.set('/api/extra/payments', () => fullPayments);
            await s.loadExtraData(['payments']);
            s.resetDeferredPortalDataFlags();
            s.renderMemberExtraViews.mockClear();
            s.renderPaymentAdmin.mockClear();
            const latest = [{ member_id: 'one', updated: true }, fullPayments[1]];
            let attempts = 0, spentBudget, retrySnapshot;
            handlers.set('/api/extra/payments', options => {
                attempts += 1;
                if (attempts === 1) {
                    spentBudget = options._retryContext;
                    spentBudget.transientRetries = 2;
                    spentBudget.unknown503Retries = 1;
                    s.portalResponseEpoch = (s.portalResponseEpoch || 0) + 1;
                    throw Object.assign(new Error('saved'), { portalContextChanged: true });
                }
                // Assert outside the handler: loader error handling must not swallow assertion failures.
                retrySnapshot = { budget: options._retryContext,
                    counters: { ...options._retryContext }, payments: appState.payments,
                    held: s.isAllPaymentsHeld(), loaded: s.isDeferredPortalDataLoaded('payments') };
                if (outcome === 'second discard') {
                    s.portalResponseEpoch += 1;
                    return [{ member_id: 'two', stale: true }];
                }
                return latest;
            });
            await s.loadExtraData(['payments']);
            expect(calls('/api/extra/payments')).toHaveLength(3);
            expect(retrySnapshot.budget).toBe(spentBudget);
            expect(retrySnapshot.counters).toMatchObject({ transientRetries: 2, unknown503Retries: 1 });
            expect(retrySnapshot.payments).toBe(fullPayments);
            expect(retrySnapshot.held).toBe(true);
            expect(retrySnapshot.loaded).toBe(false);
            expect(appState.payments).toBe(outcome === 'success' ? latest : fullPayments);
            expect(s.isAllPaymentsHeld()).toBe(true);
            expect(s.isDeferredPortalDataLoaded('payments')).toBe(outcome === 'success');
            expect(s.renderMemberExtraViews).toHaveBeenCalledTimes(outcome === 'success' ? 1 : 0);
            expect(s.renderPaymentAdmin).toHaveBeenCalledTimes(outcome === 'success' ? 1 : 0);
            if (outcome === 'success') expect(s.showAlert).not.toHaveBeenCalled();
            else {
                expect(s.showAlert).toHaveBeenCalledTimes(1);
                expect(s.showAlert).toHaveBeenCalledWith('一部データの読込に失敗しました: payments', 'warning');
            }
        });
});

describe('deferred loading unchanged behavior', () => {
    // Exercise real loaders so request URLs, flags and renderer effects stay linked.
    test.each([
        ['event', ['/api/events']],
        ['member-event', ['/api/events', '/api/extra/event_responses']],
        ['member-schedule', ['/api/schedules', '/api/extra/absences']],
        ['member-absence', ['/api/schedules', '/api/extra/absences']],
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
        ['schedule', ['/api/schedules', '/api/extra/venue_settings']],
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

    test.each(['pageshow', 'visibilitychange'].flatMap(lifecycleEvent => [
        ['fresh auth and data', 1000, 1000, 'visible', 'true', false, false],
        ['stale auth only', 61000, 1000, 'visible', 'true', true, false],
        ['stale data only', 1000, 61000, 'visible', 'true', false, true],
        ['both stale', 61000, 61000, 'visible', 'true', true, true],
        ['just before expiry', 59999, 59999, 'visible', 'true', false, false],
        ['exactly at expiry', 60000, 60000, 'visible', 'true', true, true],
        ['hidden', 61000, 61000, 'hidden', 'true', false, false],
        ['logged out', 61000, 61000, 'visible', 'false', false, false],
    ].map(row => [lifecycleEvent, ...row])))('resume via %s retains the refresh condition: %s', async (lifecycleEvent, _label, authAge, dataAge, visibility, storedAuth, verify, reload) => {
        const { s, appState, calls } = createBootstrapSandbox();
        const now = Date.now();
        // Fix the clock in this VM only so the 60-second boundary is deterministic.
        s.Date = class extends Date { static now() { return now; } };
        Object.assign(appState, { portalAuthVerified: true,
            lastPortalSessionVerifiedAt: now - authAge, lastEssentialDataLoadedAt: now - dataAge,
            currentPortalTab: { tabName: 'casting-admin' } });
        s.document.visibilityState = visibility;
        s.localStorage = { getItem: () => storedAuth };
        s.portalRuntimeContext.today = () => '2026-11-26';
        s.portalRuntimeContext.dbCache.init = vi.fn(async () => {});
        s.isPortalAuthenticated = vi.fn(async () => ({ status: 'authenticated' }));
        const documentListeners = new Map();
        const windowListeners = new Map();
        s.document.addEventListener = (name, handler) => documentListeners.set(name, handler);
        s.addEventListener = (name, handler) => windowListeners.set(name, handler);
        s.setInterval = vi.fn();
        for (const name of ['setDefaultDates', 'setupPortalHome', 'setupMemberManagerTabs',
            'bindNavigation', 'bindUpload', 'bindForms', 'bindDownloadConfirmations',
            'updateSavePath', 'loadCloudRunRevision', 'enterPortal']) s[name] = vi.fn();
        // The resume helper is scoped inside the initialization guard. Exercise
        // its registered lifecycle callback, as the browser does, rather than
        // assuming the helper is exported as a sandbox global.
        vm.runInNewContext(RESUME_SOURCE, s);
        expect(documentListeners.get('DOMContentLoaded')).toEqual(expect.any(Function));
        await documentListeners.get('DOMContentLoaded')();
        s.isPortalAuthenticated.mockClear();
        const resume = lifecycleEvent === 'pageshow'
            ? windowListeners.get('pageshow') : documentListeners.get('visibilitychange');
        expect(resume).toEqual(expect.any(Function));
        resume();
        await tick();
        expect(s.isPortalAuthenticated).toHaveBeenCalledTimes(verify ? 1 : 0);
        if (verify) expect(s.isPortalAuthenticated).toHaveBeenCalledWith({ forceVerify: true, _requestOrigin: 'automatic' });
        expect(calls('/api/bootstrap-lite')).toHaveLength(reload ? 1 : 0);
        expect(calls('/api/extra/castings')).toHaveLength(reload ? 1 : 0);
        if (reload) expect(calls('/api/extra/castings')[0][1]).toMatchObject({ _requestOrigin: 'automatic', _forceRevalidate: true });
        expect(s.showAlert).not.toHaveBeenCalled();
    });
});
