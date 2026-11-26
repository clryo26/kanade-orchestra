const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '../..');
const AUTH = 'kanadePortalAuthenticated';
const DEVICE = 'kanadePortalDeviceId';
const BOOTSTRAP = '/api/bootstrap-lite';
const sources = ['store/app_state.js', 'utils/cache.js', 'modules/common_helpers/api_runtime.js',
    'modules/common_helpers/transport_retry.js', 'modules/bootstrap_loader.js',
    'modules/navigation/events.js', 'auth_feature.js'];
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const payload = member => ({ performances: [], schedules: [], announcements: [],
    extras: { payments: [{ member_id: member, name: member, overdue: true }] } });
const response = (data, status = 200) => new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json' },
});

function createHarness() {
    const storage = new Map([[DEVICE, 'shared-device'], [AUTH, 'true']]);
    const elements = new Map();
    const element = id => {
        if (!elements.has(id)) elements.set(id, { innerHTML: '', hidden: false, value: '',
            focus: vi.fn(), addEventListener: vi.fn(), setAttribute: vi.fn() });
        return elements.get(id);
    };
    const handlers = new Map();
    const s = { console: { warn: vi.fn(), error: vi.fn(), log: vi.fn() },
        AbortController, DOMException, URL, Date, setTimeout, clearTimeout,
        navigator: { userAgent: 'test', onLine: true },
        document: { addEventListener: vi.fn(), visibilityState: 'visible' },
        addEventListener: vi.fn(), location: { href: 'https://portal.test/', reload: vi.fn() },
        localStorage: { getItem: key => storage.get(key) ?? null,
            setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) },
        portalStartup: { mark: vi.fn(), setMessage: vi.fn(), ready: vi.fn() },
        jsonOptions: (method, data) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }),
    };
    s.window = s;
    s.globalThis = s;
    vm.createContext(s);
    const load = file => vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/static/js', file), 'utf8'), s, { filename: file });
    load(sources[0]);
    const state = s.portalAppState;
    // Model disk entries with the real identity prefix, including the auth generation.
    // Stale timestamps force network revalidation after the preview is rendered.
    const entries = new Map();
    const cacheKey = url => `${s.portalCacheIdentity()}:${url}`;
    const cache = {
        getEntry: vi.fn(async url => entries.get(cacheKey(url)) || null),
        set: vi.fn(async (url, data, etag) => entries.set(cacheKey(url), { data, etag, timestamp: 0 })),
        delete: vi.fn(async url => entries.delete(cacheKey(url))),
    };
    s.portalRuntimeContext = { appState: state, PORTAL_AUTH_KEY: AUTH, PORTAL_DEVICE_ID_KEY: DEVICE,
        getById: element, inFlightGetRequests: new Map(), dbCache: cache };
    s.fetch = vi.fn(async (url, options) => {
        if (!handlers.has(url)) throw new Error(`Unexpected fetch: ${url}`);
        return handlers.get(url)(options);
    });
    sources.slice(1).forEach(load);
    for (const name of ['setLoadingBar', 'clearLoadingBar', 'showAlert', 'refreshPartSelectOptions',
        'refreshVenueOptions', 'applyOrgSettings', 'updateCloudRunRevision', 'updateManagerNavigationVisibility',
        'renderPortalHome']) s[name] = vi.fn();
    // View boundaries record the actual data supplied by the production lifecycle.
    // Browser layout and real overdue calculation remain device acceptance checks.
    const menuSnapshots = [];
    const drawMenu = () => menuSnapshots.push(state.payments.map(item => ({ ...item })));
    s.renderMenuGroups = vi.fn(drawMenu);
    s.renderPortalDrawerMenu = vi.fn(drawMenu);
    s.renderEssentialViews = vi.fn(() => {
        element('memberPaymentInfo').innerHTML = JSON.stringify(state.payments);
        s.renderMenuGroups(element('portalHomeMenu'));
        s.renderPortalDrawerMenu();
    });
    s.showMemberPanel = vi.fn(async () => { element('memberPanel').hidden = false; });
    // These independent post-startup features are outside account-switch coverage.
    s.loadAttendanceReminderAfterStartup = vi.fn();
    s.loadPaymentAlertAfterStartup = vi.fn();
    const flags = () => vm.runInContext('({ ...deferredPortalDataFlags })', s);
    const setMember = (id = 'A', name = id, verified = true) => {
        Object.assign(state, { currentUserMemberId: id, currentUserName: name,
            currentUserPermission: '一般', portalAuthVerified: verified, essentialDataLoaded: false,
            portalAuthGeneration: 'session-A', portalAuthTransition: 10 });
        storage.set(AUTH, 'true');
    };
    const login = () => {
        element('portalNameInput').value = 'B';
        element('portalPartInput').value = 'Violin';
        element('portalPasswordInput').value = 'fixture-password';
        handlers.set('/api/auth/portal-login', () => response({ member_id: 'B', member_name: 'B', permission: '一般' }));
        return s.handlePortalLogin();
    };
    const calls = url => s.fetch.mock.calls.filter(([called]) => called === url);
    return { s, state, storage, cache, entries, cacheKey, handlers, element, flags, setMember, login, calls, menuSnapshots };
}

function expectReset(h) {
    expect(h.state.payments).toEqual([]);
    expect(h.state.essentialDataLoaded).toBe(false);
    expect(Object.values(h.flags()).every(flag => flag === false)).toBe(true);
    expect(h.element('memberPaymentInfo').innerHTML).toBe('');
}

describe('portal account lifecycle', () => {
    test.each(['success', 'failure'])('T3: real logout/login never supplies A to B views during %s', async outcome => {
        const h = createHarness();
        h.setMember();
        h.handlers.set(BOOTSTRAP, () => response(payload('A')));
        await h.s.loadEssentialData();
        await h.cache.set(BOOTSTRAP, payload('A'));
        const aCacheKey = h.cacheKey(BOOTSTRAP);
        expect(h.element('memberPaymentInfo').innerHTML).toContain('A');
        await h.s.logoutPortal();
        expectReset(h);
        expect(h.menuSnapshots.slice(-2)).toEqual([[], []]);
        // Keep another old-A disk entry to prove B's identity cannot read it.
        h.entries.set(aCacheKey, { data: payload('A'), timestamp: 0 });
        h.menuSnapshots.length = 0;
        const gate = deferred();
        h.handlers.set(BOOTSTRAP, () => gate.promise);
        const pending = h.login();
        await tick();
        expect(h.calls(BOOTSTRAP)).toHaveLength(2);
        expect(h.state.currentUserMemberId).toBe('B');
        expect(h.state.payments).toEqual([]);
        expect(h.element('memberPaymentInfo').innerHTML).not.toContain('A');
        if (outcome === 'success') gate.resolve(response(payload('B')));
        else gate.reject(new TypeError('offline fixture'));
        await pending;
        expect(h.element('memberPaymentInfo').innerHTML).not.toContain('A');
        expect(h.menuSnapshots.flat().some(item => item.member_id === 'A')).toBe(false);
        expect(h.state.payments).toEqual(outcome === 'success' ? payload('B').extras.payments : []);
        if (outcome === 'failure') expect(h.state.essentialDataLoaded).toBe(false);
    });

    test.each(['success', 'failure'])('T4: late A bootstrap %s cannot complete old enterPortal after logout', async outcome => {
        const h = createHarness();
        h.setMember();
        await h.cache.set(BOOTSTRAP, payload('A'));
        const gate = deferred();
        h.handlers.set(BOOTSTRAP, () => gate.promise);
        const pending = h.s.enterPortal();
        await tick();
        expect(h.state.payments).toEqual(payload('A').extras.payments);
        await h.s.logoutPortal();
        h.s.setLoadingBar.mockClear();
        h.s.showAlert.mockClear();
        h.s.renderEssentialViews.mockClear();
        if (outcome === 'success') gate.resolve(response(payload('A')));
        else gate.reject(new TypeError('offline'));
        await pending;
        expectReset(h);
        expect(h.s.renderEssentialViews).not.toHaveBeenCalled();
        expect(h.s.setLoadingBar).not.toHaveBeenCalled();
        expect(h.s.showAlert).not.toHaveBeenCalled();
        h.handlers.set(BOOTSTRAP, () => response(payload('B')));
        const before = h.calls(BOOTSTRAP).length;
        await h.login();
        expect(h.calls(BOOTSTRAP)).toHaveLength(before + 1);
        expect(h.state.payments).toEqual(payload('B').extras.payments);
    });

    test('T4: an account change during getEntry cannot render the old preview', async () => {
        const h = createHarness();
        h.setMember();
        const gate = deferred();
        h.cache.getEntry.mockReturnValueOnce(gate.promise);
        const pending = h.s.loadEssentialData({ useCachedPreview: true }).catch(error => error);
        await h.s.logoutPortal();
        gate.resolve({ data: payload('A') });
        expect(await pending).toMatchObject({ portalContextChanged: true });
        expectReset(h);
        expect(h.s.renderEssentialViews).not.toHaveBeenCalled();
        expect(h.calls(BOOTSTRAP)).toHaveLength(0);
    });

    test('T4: changing account during showMemberPanel ends startup quietly', async () => {
        const h = createHarness();
        h.setMember();
        const gate = deferred();
        h.s.showMemberPanel.mockReturnValueOnce(gate.promise);
        const pending = h.s.enterPortal();
        await h.s.logoutPortal();
        h.s.portalStartup.ready.mockClear();
        gate.resolve();
        await pending;
        expectReset(h);
        expect(h.s.portalStartup.ready).toHaveBeenCalledTimes(1);
        expect(h.s.renderPortalHome).not.toHaveBeenCalled();
        expect(h.calls(BOOTSTRAP)).toHaveLength(0);
        expect(h.s.showAlert).not.toHaveBeenCalled();
    });

    test.each(['resolve', 'reject'])('T9: no preview restoration after account change during cache delete (%s)', async result => {
        const h = createHarness();
        h.setMember();
        await h.cache.set(BOOTSTRAP, payload('A'));
        h.handlers.set(BOOTSTRAP, () => response(payload('latest-A')));
        const gate = deferred();
        const deletionStarted = deferred();
        h.cache.delete.mockImplementationOnce(() => {
            deletionStarted.resolve();
            return gate.promise;
        });
        h.s.renderEssentialViews.mockImplementationOnce(() => {})
            .mockImplementationOnce(() => { throw new Error('latest render failed'); });
        const apply = h.s.applyBootstrapData;
        h.s.applyBootstrapData = vi.fn(apply);
        const pending = h.s.loadEssentialData({ useCachedPreview: true }).catch(error => error);
        await deletionStarted.promise;
        expect(h.cache.delete).toHaveBeenCalledWith(BOOTSTRAP);
        expect(h.s.applyBootstrapData).toHaveBeenCalledTimes(2);
        expect(h.s.renderEssentialViews).toHaveBeenCalledTimes(2);
        h.s.advancePortalAuthTransition();
        h.s.resetPortalDataForAccountChange();
        h.s.applyBootstrapData.mockClear();
        h.s.renderEssentialViews.mockClear();
        h.s.setLoadingBar.mockClear();
        h.s.console.warn.mockClear();
        if (result === 'resolve') gate.resolve();
        else gate.reject(new Error('delete failed'));
        expect(await pending).toMatchObject({ portalContextChanged: true });
        expectReset(h);
        expect(h.s.applyBootstrapData).not.toHaveBeenCalled();
        expect(h.s.renderEssentialViews).not.toHaveBeenCalled();
        expect(h.s.setLoadingBar).not.toHaveBeenCalled();
        expect(h.s.console.warn).not.toHaveBeenCalled();
        expect(h.s.showAlert).not.toHaveBeenCalled();
    });

    test.each(['resolve', 'reject'])('T9 control: same transition restores preview after delete %s', async result => {
        const h = createHarness();
        h.setMember();
        await h.cache.set(BOOTSTRAP, payload('A'));
        h.handlers.set(BOOTSTRAP, () => response(payload('latest-A')));
        h.s.markDeferredPortalDataLoaded('payments');
        const originalFlags = h.flags();
        h.state.lastEssentialDataLoadedAt = 123;
        const gate = deferred();
        const deletionStarted = deferred();
        h.cache.delete.mockImplementationOnce(() => {
            deletionStarted.resolve();
            return gate.promise;
        });
        h.s.renderEssentialViews.mockImplementationOnce(() => {})
            .mockImplementationOnce(() => { throw new Error('latest render failed'); });
        const apply = h.s.applyBootstrapData;
        h.s.applyBootstrapData = vi.fn(apply);
        const pending = h.s.loadEssentialData({ useCachedPreview: true });
        await deletionStarted.promise;
        expect(h.cache.delete).toHaveBeenCalledWith(BOOTSTRAP);
        expect(h.s.applyBootstrapData).toHaveBeenCalledTimes(2);
        if (result === 'resolve') gate.resolve();
        else gate.reject(new Error('delete failed'));
        await pending;
        expect(h.state.payments).toEqual(payload('A').extras.payments);
        expect(h.s.applyBootstrapData).toHaveBeenCalledTimes(3);
        expect(h.s.applyBootstrapData).toHaveBeenLastCalledWith(payload('A'));
        expect(h.s.renderEssentialViews).toHaveBeenCalledTimes(3);
        expect(h.s.setLoadingBar).toHaveBeenLastCalledWith('保存済みデータを表示しています。最新データの反映に失敗しました。');
        expect(h.state.portalAuthTransition).toBe(10);
        expect(h.flags()).toEqual(originalFlags);
        expect(h.s.isAllPaymentsHeld()).toBe(false);
        expect(h.state.lastEssentialDataLoadedAt).toBe(123);
        expect(h.calls(BOOTSTRAP)).toHaveLength(1);
    });

    test.each([AUTH, DEVICE, null])('T5: storage %s clears data before reload or login', key => {
        for (const loggedIn of [true, false]) {
            const h = createHarness();
            h.setMember();
            h.state.payments = payload('A').extras.payments;
            h.s.markDeferredPortalDataLoaded('payments');
            h.element('memberPaymentInfo').innerHTML = 'A';
            if (!loggedIn) h.storage.delete(AUTH);
            const reload = h.s.location.reload;
            reload.mockImplementation(() => expectReset(h));
            const listener = h.s.addEventListener.mock.calls.find(([event]) => event === 'storage')[1];
            listener({ key });
            expectReset(h);
            expect(h.state.portalAuthTransition).toBeGreaterThan(10);
            expect(reload).toHaveBeenCalledTimes(loggedIn ? 1 : 0);
            if (!loggedIn) {
                expect(h.state.portalAuthVerified).toBe(false);
                expect(h.state.currentUserMemberId).toBeNull();
                expect(h.element('portalLoginPanel').hidden).toBe(false);
                expect(h.element('memberPanel').hidden).toBe(true);
            }
        }
    });

    test.each([AUTH, DEVICE, null].flatMap(key => ['true', null].map(auth => [key, auth])))(
        'T5: login-screen storage %s (auth=%s) only advances the transition', (key, auth) => {
        const h = createHarness();
        h.setMember(null, '', false);
        if (auth === null) h.storage.delete(AUTH);
        const payments = h.state.payments;
        const listener = h.s.addEventListener.mock.calls.find(([event]) => event === 'storage')[1];
        listener({ key });
        expect(h.state.portalAuthTransition).toBe(11);
        expect(h.state.payments).toBe(payments);
        expect(h.s.location.reload).not.toHaveBeenCalled();
        expect(h.s.renderMenuGroups).not.toHaveBeenCalled();
        });

    const identities = [
        ['same ID, changed name', 701, '山田 太郎', '701', '山田太郎', false],
        ['different IDs, same name', 701, '山田太郎', 702, '山田太郎', true],
        ['no IDs, same name', null, '山田太郎', null, '山田太郎', false],
        ['no IDs, different name', null, '山田 太郎', null, '山田太郎', true],
        ['previous ID only, same name', 701, '山田太郎', null, '山田太郎', false],
        ['previous ID only, different name', 701, '山田太郎', null, '別人', true],
        ['next ID only, same name', null, '山田太郎', 701, '山田太郎', false],
        ['next ID only, different name', null, '山田太郎', 701, '別人', true],
        ['zero IDs use names', 0, '山田太郎', 701, '山田太郎', false],
    ];
    test.each(identities.flatMap(([label, ...row]) => [true, false].map(verified => [label, verified, ...row])))(
        'T8: %s (verified=%s)', (_label, verified, prevId, prevName, nextId, nextName, different) => {
            const h = createHarness();
            h.setMember(prevId, prevName, verified);
            const payments = payload('A').extras.payments;
            h.state.payments = payments;
            h.s.markDeferredPortalDataLoaded('payments');
            const flags = h.flags();
            const changed = verified && different;
            h.s.location.reload.mockImplementation(() => {
                expect(h.state.currentUserMemberId).toBe(nextId);
                expect(h.state.portalAuthTransition).toBe(11);
                expectReset(h);
            });
            h.s.applyPortalAuthDevice({ member_id: nextId, member_name: nextName, permission: '一般' });
            expect(h.state.currentUserName).toBe(nextName);
            expect(h.state.portalAuthVerified).toBe(true);
            expect(h.state.portalAuthTransition).toBe(changed ? 11 : 10);
            expect(h.s.location.reload).toHaveBeenCalledTimes(changed ? 1 : 0);
            if (changed) expectReset(h);
            else {
                expect(h.state.payments).toBe(payments);
                expect(h.flags()).toEqual(flags);
                expect(h.s.renderMenuGroups).not.toHaveBeenCalled();
            }
        });

    test('T8 regression: same ID and auth context retain full-payment ownership after a name change', async () => {
        const h = createHarness();
        h.setMember(701, '山田 太郎');
        h.state.currentUserPermission = '管理者';
        const allPayments = [{ member_id: 701 }, { member_id: 702 }];
        h.handlers.set('/api/extra/payments', () => response(allPayments));
        await h.s.loadExtraData(['payments']);
        expect(h.s.isAllPaymentsHeld()).toBe(true);
        expect(h.s.isDeferredPortalDataLoaded('payments')).toBe(true);
        const payments = h.state.payments;
        const flags = h.flags();
        const identity = h.s.portalCacheIdentity();
        h.s.renderMenuGroups.mockClear();
        h.s.renderPortalDrawerMenu.mockClear();

        h.s.applyPortalAuthDevice({ member_id: 701, member_name: '山田太郎',
            permission: '管理者', authenticated_at: 'session-A' });

        expect(h.state.currentUserName).toBe('山田太郎');
        expect(h.state.portalAuthTransition).toBe(10);
        expect(h.s.portalCacheIdentity()).toBe(identity);
        expect(h.state.payments).toBe(payments);
        expect(h.state.payments).toEqual(allPayments);
        expect(h.flags()).toEqual(flags);
        expect(h.s.isAllPaymentsHeld()).toBe(true);
        expect(h.s.location.reload).not.toHaveBeenCalled();
        expect(h.s.renderMenuGroups).not.toHaveBeenCalled();
        expect(h.s.renderPortalDrawerMenu).not.toHaveBeenCalled();
    });

    test('T5: verified state without previous identity does not reset on first device', () => {
        const h = createHarness();
        h.setMember(null, '', true);
        h.s.applyPortalAuthDevice({ member_id: 701, member_name: '山田太郎' });
        expect(h.state.portalAuthTransition).toBe(10);
        expect(h.s.location.reload).not.toHaveBeenCalled();
        expect(h.s.renderMenuGroups).not.toHaveBeenCalled();
    });

    test.each(['success', 'failure'])('T6: same member renders preview before network and preserves it on %s', async outcome => {
        const h = createHarness();
        h.setMember();
        await h.cache.set(BOOTSTRAP, payload('A'));
        const gate = deferred();
        h.handlers.set(BOOTSTRAP, () => {
            expect(h.state.payments).toEqual(payload('A').extras.payments);
            expect(h.element('memberPaymentInfo').innerHTML).toContain('A');
            return gate.promise;
        });
        const pending = h.s.enterPortal();
        await tick();
        expect(h.calls(BOOTSTRAP)).toHaveLength(1);
        expect(h.s.renderEssentialViews).toHaveBeenCalledTimes(1);
        if (outcome === 'success') gate.resolve(response(payload('latest-A')));
        else gate.reject(new TypeError('offline fixture'));
        await pending;
        expect(h.state.payments).toEqual(payload(outcome === 'success' ? 'latest-A' : 'A').extras.payments);
        expect(h.state.essentialDataLoaded).toBe(true);
        expect(h.s.location.reload).not.toHaveBeenCalled();
        if (outcome === 'failure') expect(h.s.setLoadingBar).toHaveBeenLastCalledWith(
            '保存済みデータを表示しています。最新データの取得に失敗しました。');
    });

    test('T7: clear uses the real account reset to clear payments and all deferred flags', () => {
        const h = createHarness();
        h.setMember();
        h.state.payments = payload('A').extras.payments;
        for (const key of Object.keys(h.flags())) h.s.markDeferredPortalDataLoaded(key);
        h.element('memberPaymentInfo').innerHTML = 'A';
        h.s.clearPortalAuthState();
        expectReset(h);
        expect(h.state.portalAuthVerified).toBe(false);
    });

    test('refresh suppresses context-change warnings and leaves startup unloaded', async () => {
        const h = createHarness();
        h.setMember();
        const gate = deferred();
        h.handlers.set(BOOTSTRAP, () => gate.promise);
        const pending = h.s.refreshPortalData({ includeBackground: false });
        await tick();
        await h.s.logoutPortal();
        gate.resolve(response(payload('A')));
        await pending;
        expectReset(h);
        expect(h.s.showAlert).not.toHaveBeenCalled();
        expect(h.s.console.warn).not.toHaveBeenCalled();
    });
});
