const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = name => fs.readFileSync(path.resolve(__dirname,
    '../../src/static/js/modules', name), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function deferred() {
    let resolve;
    const promise = new Promise(yes => { resolve = yes; });
    return { promise, resolve };
}

function setup({ sns = false } = {}) {
    const appState = { schedules: [], snsSettings: [], absences: [], members: [],
        payments: [], currentUserMemberId: 'one', portalAuthGeneration: 1 };
    const elements = Object.fromEntries(['snsFacebookUrl', 'snsInstagramUrl', 'snsXUrl', 'snsSettingId']
        .map(id => [id, { value: '' }]));
    const handlers = new Map();
    const request = vi.fn((url, options) => handlers.has(url)
        ? handlers.get(url)(options) : Promise.resolve([]));
    const s = { request, console: { warn: vi.fn() }, document: { addEventListener: vi.fn() },
        portalRuntimeContext: { appState, getById: id => elements[id] || null },
        jsonOptions: (method, payload) => ({ method, body: JSON.stringify(payload) }),
    };
    for (const name of ['showAlert', 'renderSchedules', 'renderMemberSchedules', 'renderAbsenceView',
        'renderSnsManagement', 'renderMemberExtraViews', 'refreshVenueOptions', 'renderVenueManagement',
        'refreshPartSelectOptions', 'applyOrgSettings', 'renderOrgManagement',
        'ensureMemberFeatureLoaded', 'attendanceOverviewSchedules', 'showUpcomingAttendanceReminder']) {
        s[name] = vi.fn();
    }
    s.window = s;
    s.globalThis = s;
    vm.createContext(s);
    vm.runInContext(source('bootstrap_loader.js'), s);
    vm.runInContext(source('navigation/events.js'), s);
    if (sns) vm.runInContext(source('sns.js'), s);
    const calls = url => request.mock.calls.filter(([value]) => value === url);
    return { s, appState, elements, request, handlers, calls };
}

const tabs = [
    ['member-schedule', '/api/schedules', 'schedules'],
    ['member-absence', '/api/schedules', 'schedules'],
    ['schedule', '/api/schedules', 'schedules'],
    ['member-sns', '/api/extra/sns_settings', 'snsSettings'],
    ['system-sns', '/api/extra/sns_settings', 'snsSettings'],
];

describe('lite deferred collections', () => {
    test.each(tabs)('%s loads once, including successful empty lists', async (tab, url, key) => {
        const { s, calls, appState } = setup();
        await s.ensureDeferredTabDataLoaded(tab);
        await s.ensureDeferredTabDataLoaded(tab);
        expect(calls(url)).toHaveLength(1);
        expect(appState[key]).toEqual([]);
        expect(s.isDeferredPortalDataLoaded(key)).toBe(true);
    });

    test.each(tabs)('%s preserves data and can retry after a failed load', async (tab, url, key) => {
        const { s, appState, handlers, calls } = setup();
        const old = [{ id: 'visible' }];
        appState[key] = old;
        handlers.set(url, () => Promise.reject(new Error('offline')));
        await expect(s.ensureDeferredTabDataLoaded(tab)).resolves.toBeUndefined();
        expect(appState[key]).toBe(old);
        expect(s.isDeferredPortalDataLoaded(key)).toBe(false);
        expect(s.showAlert).toHaveBeenCalledTimes(1);
        expect(s.showAlert).toHaveBeenCalledWith(expect.any(String), 'warning');
        handlers.set(url, () => [{ id: 'latest' }]);
        await s.ensureDeferredTabDataLoaded(tab);
        expect(calls(url)).toHaveLength(2);
        expect(appState[key]).toEqual([{ id: 'latest' }]);
        expect(s.isDeferredPortalDataLoaded(key)).toBe(true);
    });

    test.each(['schedules', 'snsSettings'])('%s retry wait keeps data and flags without warnings', async key => {
        const { s, appState, handlers } = setup();
        const old = [{ id: 'visible' }];
        appState[key] = old;
        const url = key === 'schedules' ? '/api/schedules' : '/api/extra/sns_settings';
        handlers.set(url, () => Promise.reject(Object.assign(new Error('wait'), { portalRetryWait: true })));
        if (key === 'schedules') expect(await s.loadSchedules({ _requestOrigin: 'automatic' })).toBe(false);
        else await s.loadExtraData([key]);
        expect(appState[key]).toBe(old);
        expect(s.isDeferredPortalDataLoaded(key)).toBe(false);
        expect(s.showAlert).not.toHaveBeenCalled();
    });

    test('login settings request only part and org and retain SNS data', async () => {
        const { s, appState, request, handlers } = setup();
        const old = [{ id: 'common' }];
        appState.snsSettings = old;
        handlers.set('/api/extra/part_settings', () => [{ name: 'Violin' }]);
        handlers.set('/api/extra/org_settings', () => [{ name: 'Kanade' }]);
        await s.loadPartSettingsForLogin();
        expect(request.mock.calls.map(([url]) => url).sort()).toEqual([
            '/api/extra/org_settings', '/api/extra/part_settings',
        ]);
        expect(appState.partSettings).toEqual([{ name: 'Violin' }]);
        expect(appState.orgSettings).toEqual([{ name: 'Kanade' }]);
        expect(appState.snsSettings).toBe(old);
        expect(s.refreshPartSelectOptions).toHaveBeenCalledTimes(1);
        expect(s.applyOrgSettings).toHaveBeenCalledTimes(1);
    });

    test('account reset preserves common schedules and SNS but resets their flags and generation', () => {
        const { s, appState, request } = setup();
        const schedules = [{ id: 'schedule' }], snsSettings = [{ id: 'sns' }];
        Object.assign(appState, { schedules, snsSettings });
        s.markDeferredPortalDataLoaded('schedules');
        s.markDeferredPortalDataLoaded('snsSettings');
        const generation = s.currentDeferredPortalDataGeneration();
        s.resetPortalDataForAccountChange();
        expect(appState.schedules).toBe(schedules);
        expect(appState.snsSettings).toBe(snsSettings);
        expect(s.isDeferredPortalDataLoaded('schedules')).toBe(false);
        expect(s.isDeferredPortalDataLoaded('snsSettings')).toBe(false);
        expect(s.currentDeferredPortalDataGeneration()).toBe(generation + 1);
        expect(request).not.toHaveBeenCalled();
    });
});

describe('loadSchedules ordering and return value', () => {
    test('success applies data and renders all dependent views', async () => {
        const { s, appState, handlers, calls } = setup();
        handlers.set('/api/schedules', () => [{ id: 'new' }]);
        const options = Object.freeze({ _requestOrigin: 'automatic', _forceRevalidate: true, ignored: true });
        expect(await s.loadSchedules(options)).toBe(true);
        expect(calls('/api/schedules')[0][1]).toEqual({ _requestOrigin: 'automatic', _forceRevalidate: true });
        expect(appState.schedules).toEqual([{ id: 'new' }]);
        expect(s.isDeferredPortalDataLoaded('schedules')).toBe(true);
        for (const name of ['renderSchedules', 'renderMemberSchedules', 'renderAbsenceView']) {
            expect(s[name]).toHaveBeenCalledTimes(1);
        }
    });

    test('optional render functions may be absent', async () => {
        const { s } = setup();
        for (const name of ['renderSchedules', 'renderMemberSchedules', 'renderAbsenceView']) delete s[name];
        expect(await s.loadSchedules()).toBe(true);
    });

    test.each([true, false])('newer save/deferred load wins (older deferred=%s)', async olderDeferred => {
        const { s, appState, handlers } = setup();
        const pending = deferred();
        handlers.set('/api/schedules', () => pending.promise);
        const old = olderDeferred ? s.loadSchedules({ _requestOrigin: 'automatic' }) : s.loadSchedules();
        handlers.set('/api/schedules', () => [{ id: 'saved' }]);
        expect(await (olderDeferred ? s.loadSchedules() : s.loadSchedules({ _requestOrigin: 'automatic' }))).toBe(true);
        s.unmarkDeferredPortalDataLoaded('schedules');
        const renderCount = s.renderSchedules.mock.calls.length;
        pending.resolve([{ id: 'old' }]);
        expect(await old).toBe(false);
        expect(appState.schedules).toEqual([{ id: 'saved' }]);
        expect(s.isDeferredPortalDataLoaded('schedules')).toBe(false);
        expect(s.renderSchedules).toHaveBeenCalledTimes(renderCount);
    });

    test('generation change discards a response without rendering or marking it', async () => {
        const { s, appState, handlers } = setup();
        const pending = deferred(), old = [{ id: 'visible' }];
        appState.schedules = old;
        handlers.set('/api/schedules', () => pending.promise);
        const loading = s.loadSchedules({ _requestOrigin: 'automatic' });
        s.resetDeferredPortalDataFlags();
        pending.resolve([{ id: 'discarded' }]);
        expect(await loading).toBe(false);
        expect(appState.schedules).toBe(old);
        expect(s.isDeferredPortalDataLoaded('schedules')).toBe(false);
        expect(s.renderSchedules).not.toHaveBeenCalled();
    });

    test('automatic failure resolves false; save-triggered failure still rejects', async () => {
        const { s, handlers } = setup();
        const error = new Error('offline');
        handlers.set('/api/schedules', () => Promise.reject(error));
        expect(await s.loadSchedules({ _requestOrigin: 'automatic' })).toBe(false);
        expect(s.showAlert).toHaveBeenCalledWith('一部データの読込に失敗しました: schedules', 'warning');
        await expect(s.loadSchedules()).rejects.toBe(error);
        expect(s.showAlert).toHaveBeenCalledTimes(1);
        expect(s.isDeferredPortalDataLoaded('schedules')).toBe(false);
    });
});

describe('startup attendance reminder with real collection loaders', () => {
    test('waits for both applied collections before reminding', async () => {
        const { s, handlers, calls } = setup();
        const schedules = deferred(), absences = deferred();
        handlers.set('/api/schedules', () => schedules.promise);
        handlers.set('/api/extra/absences', () => absences.promise);
        const loading = s.loadAttendanceReminderAfterStartup();
        await tick();
        schedules.resolve([{ id: 1 }]);
        await tick();
        expect(s.showUpcomingAttendanceReminder).not.toHaveBeenCalled();
        absences.resolve([]);
        await loading;
        expect(s.isDeferredPortalDataLoaded('schedules')).toBe(true);
        expect(s.isDeferredPortalDataLoaded('absences')).toBe(true);
        expect(s.showUpcomingAttendanceReminder).toHaveBeenCalledTimes(1);
        for (const url of ['/api/schedules', '/api/extra/absences']) {
            expect(calls(url)).toHaveLength(1);
            expect(calls(url)[0][1]).toMatchObject({ _requestOrigin: 'automatic' });
        }
    });

    test.each([
        ['/api/extra/absences', 'absences'], ['/api/schedules', 'schedules'],
    ])('suppresses reminder when %s failure is swallowed', async (url, key) => {
        const { s, handlers } = setup();
        handlers.set(url, () => Promise.reject(new Error('offline')));
        await expect(s.loadAttendanceReminderAfterStartup()).resolves.toBeUndefined();
        expect(s.isDeferredPortalDataLoaded(key)).toBe(false);
        expect(s.showUpcomingAttendanceReminder).not.toHaveBeenCalled();
        expect(s.console.warn).toHaveBeenCalled();
    });

    test('generation reset suppresses reminder even when both flags become true again', async () => {
        const { s, handlers } = setup();
        const pending = deferred();
        handlers.set('/api/schedules', () => pending.promise);
        const loading = s.loadAttendanceReminderAfterStartup();
        await tick();
        s.resetDeferredPortalDataFlags();
        handlers.set('/api/schedules', () => []);
        await s.loadSchedules({ _requestOrigin: 'automatic' });
        await s.loadExtraData(['absences']);
        pending.resolve([]);
        await loading;
        expect(s.isDeferredPortalDataLoaded('schedules')).toBe(true);
        expect(s.isDeferredPortalDataLoaded('absences')).toBe(true);
        expect(s.showUpcomingAttendanceReminder).not.toHaveBeenCalled();
        expect(s.console.warn).toHaveBeenCalled();
    });

    test('already loaded schedules in the same generation are reused', async () => {
        const { s, calls } = setup();
        await s.loadSchedules();
        await s.loadAttendanceReminderAfterStartup();
        expect(calls('/api/schedules')).toHaveLength(1);
        expect(s.showUpcomingAttendanceReminder).toHaveBeenCalledTimes(1);
    });
});

describe('SNS save with real extra loader and form redraw', () => {
    const input = { facebook_url: 'https://example.com/new-facebook',
        instagram_url: 'https://example.com/new-instagram', x_url: 'https://example.com/new-x' };
    function snsSetup() {
        const h = setup({ sns: true });
        for (const [id, key] of [['snsFacebookUrl', 'facebook_url'], ['snsInstagramUrl', 'instagram_url'], ['snsXUrl', 'x_url']]) {
            h.elements[id].value = `  ${input[key]}  `;
        }
        const stored = [{ id: 'existing/id', facebook_url: 'https://example.com/old' }];
        h.handlers.set('/api/extra/sns_settings', options => {
            if (options?.method === 'POST') return [];
            return stored;
        });
        return h;
    }
    const values = elements => ['snsFacebookUrl', 'snsInstagramUrl', 'snsXUrl'].map(id => elements[id].value);
    const writes = request => request.mock.calls.filter(([, options]) => ['PUT', 'POST'].includes(options?.method));
    const warning = 'SNS情報を読み込めなかったため、保存していません。時間をおいてもう一度保存してください。';

    test.each([false, true])('loads existing id and retains captured input (write failure=%s)', async failWrite => {
        const { s, handlers, request, elements, calls } = snsSetup();
        const pending = deferred();
        const saving = s.saveSnsSetting();
        // Hold the write to inspect the restored form after GET redraws old values.
        handlers.set('/api/extra/sns_settings/existing%2Fid', () => pending.promise);
        await tick();
        expect(writes(request)).toHaveLength(1);
        const [url, options] = writes(request)[0];
        expect(url).toBe('/api/extra/sns_settings/existing%2Fid');
        expect(options.method).toBe('PUT');
        expect(JSON.parse(options.body)).toEqual(input);
        expect(values(elements)).toEqual(Object.values(input));
        if (failWrite) {
            // Reject through a resolved thenable to attach the assertion before rejection.
            const failure = expect(saving).rejects.toThrow('write failed');
            pending.resolve(Promise.reject(new Error('write failed')));
            await failure;
            expect(values(elements)).toEqual(Object.values(input));
            expect(calls('/api/extra/sns_settings')).toHaveLength(1);
            expect(s.showAlert).not.toHaveBeenCalledWith('SNS情報を保存しました', 'success');
        } else {
            handlers.set('/api/extra/sns_settings', () => [{ id: 'existing/id', ...input }]);
            pending.resolve([]);
            await saving;
            expect(values(elements)).toEqual(Object.values(input));
            expect(calls('/api/extra/sns_settings')).toHaveLength(2);
            expect(s.showAlert).toHaveBeenCalledWith('SNS情報を保存しました', 'success');
        }
        expect(request.mock.calls[0][0]).toBe('/api/extra/sns_settings');
    });

    test.each([false, true])('failed load never writes or loses input (retry wait=%s)', async retryWait => {
        const { s, handlers, request, elements } = snsSetup();
        const before = values(elements);
        handlers.set('/api/extra/sns_settings', () => Promise.reject(
            Object.assign(new Error('offline'), { portalRetryWait: retryWait })));
        await s.saveSnsSetting();
        expect(writes(request)).toHaveLength(0);
        expect(s.isDeferredPortalDataLoaded('snsSettings')).toBe(false);
        expect(values(elements)).toEqual(before);
        expect(s.showAlert).toHaveBeenCalledWith(warning, 'warning');
        expect(s.showAlert).toHaveBeenCalledTimes(retryWait ? 1 : 2);
    });

    test('account changes during the initial GET prevent saving and keep inputs', async () => {
        const { s, appState, handlers, request, elements } = snsSetup();
        const before = values(elements), pending = deferred();
        handlers.set('/api/extra/sns_settings', () => pending.promise);
        const saving = s.saveSnsSetting();
        await tick();
        appState.currentUserMemberId = 'another';
        s.resetPortalDataForAccountChange();
        pending.resolve([{ id: 'old-account' }]);
        await saving;
        expect(writes(request)).toHaveLength(0);
        expect(values(elements)).toEqual(before);
        expect(s.showAlert).toHaveBeenCalledWith(warning, 'warning');
    });

    test('generation change alone prevents a write even if a retry successfully loads SNS', async () => {
        const { s, handlers, request, elements } = snsSetup();
        const before = values(elements);
        const pending = deferred();
        handlers.set('/api/extra/sns_settings', () => pending.promise);
        const saving = s.saveSnsSetting();
        await tick();
        s.resetDeferredPortalDataFlags();
        handlers.set('/api/extra/sns_settings', () => [{ id: 'latest' }]);
        pending.resolve([{ id: 'old' }]);
        await saving;
        expect(s.isDeferredPortalDataLoaded('snsSettings')).toBe(true);
        expect(writes(request)).toHaveLength(0);
        expect(values(elements)).toEqual(before);
        expect(s.showAlert).toHaveBeenCalledWith(warning, 'warning');
    });

    test('unloaded SNS creates a row only after a successful empty GET', async () => {
        const { s, handlers, request } = snsSetup();
        handlers.set('/api/extra/sns_settings', () => []);
        await s.saveSnsSetting();
        expect(request.mock.calls[0][0]).toBe('/api/extra/sns_settings');
        expect(request.mock.calls[0][1]?.method).toBeUndefined();
        expect(writes(request)).toHaveLength(1);
        expect(writes(request)[0][0]).toBe('/api/extra/sns_settings');
        expect(writes(request)[0][1].method).toBe('POST');
        expect(JSON.parse(writes(request)[0][1].body)).toEqual(input);
    });

    test.each([true, false])('already loaded SNS saves directly (existing id=%s)', async existing => {
        const { s, appState, request, calls } = snsSetup();
        appState.snsSettings = existing ? [{ id: 12 }] : [];
        s.markDeferredPortalDataLoaded('snsSettings');
        await s.saveSnsSetting();
        expect(request.mock.calls[0][0]).toBe(existing ? '/api/extra/sns_settings/12' : '/api/extra/sns_settings');
        expect(request.mock.calls[0][1].method).toBe(existing ? 'PUT' : 'POST');
        expect(JSON.parse(request.mock.calls[0][1].body)).toEqual(input);
        expect(calls('/api/extra/sns_settings').filter(([, opts]) => !opts?.method)).toHaveLength(1);
    });
});

describe('schedule loading placeholders', () => {
    function renderingSetup() {
        const h = setup();
        const makeContainer = () => ({ innerHTML: '', querySelectorAll: () => [],
            insertAdjacentHTML(position, html) { this.innerHTML += html; } });
        for (const id of ['schedListItems', 'memberSchedInfo', 'memberAbsenceInfo']) {
            h.elements[id] = makeContainer();
        }
        h.s.portalRuntimeContext.today = () => '2026-11-26';
        h.s.sortedSchedules = rows => rows;
        vm.runInContext(source('schedules.js'), h.s);
        return h;
    }

    test.each(['future', 'past'])('schedule lists retain period controls during first load (%s)', period => {
        const { s, appState, elements } = renderingSetup();
        appState.scheduleAdminPeriod = period;
        s.renderSchedules();
        expect(elements.schedListItems.innerHTML).toContain('読み込み中です...');
        expect(elements.memberSchedInfo.innerHTML).toContain('読み込み中です...');
        expect(elements.schedListItems.innerHTML).toContain('data-schedule-period="future"');
        expect(elements.schedListItems.innerHTML).toContain('data-schedule-period="past"');
        s.markDeferredPortalDataLoaded('schedules');
        s.renderSchedules();
        expect(elements.schedListItems.innerHTML).not.toContain('読み込み中です...');
        expect(elements.schedListItems.innerHTML).toContain(period === 'past'
            ? '過去の練習予定はありません' : '当日以降の練習予定はありません');
        expect(elements.memberSchedInfo.innerHTML).toContain('練習予定はまだありません');
    });

    test('cached schedules do not count as awaiting a first load after flag reset', () => {
        const { s, appState } = renderingSetup();
        appState.schedules = [{ id: 'preview', date: '2099-01-01' }];
        s.resetDeferredPortalDataFlags();
        expect(s.schedulesAwaitingFirstLoad()).toBe(false);
    });

    test.each(['absences.js', 'attendance_followup.js'])('%s distinguishes loading from empty attendance schedules', file => {
        const { s, elements } = renderingSetup();
        vm.runInContext(source('absences.js'), s);
        if (file === 'attendance_followup.js') vm.runInContext(source(file), s);
        s.visibleAttendanceSchedules = () => [];
        s.attendanceOverviewSchedules = () => [];
        s.renderAbsenceView();
        expect(elements.memberAbsenceInfo.innerHTML).toContain('読み込み中です...');
        expect(elements.memberAbsenceInfo.innerHTML).not.toContain('今後の練習予定はありません');
        s.markDeferredPortalDataLoaded('schedules');
        s.renderAbsenceView();
        expect(elements.memberAbsenceInfo.innerHTML).toContain('今後の練習予定はありません');
        expect(elements.memberAbsenceInfo.innerHTML).not.toContain('読み込み中です...');
    });
});
