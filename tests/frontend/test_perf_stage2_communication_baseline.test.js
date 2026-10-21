const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

// Replay the archived before scenarios against the stage 2B implementation.
// The archived before JSON remains immutable; assertions now describe the
// reviewed retry/single-flight contract.
const ROOT = path.resolve(__dirname, '../..');
const FIXED_NOW = Date.parse('2026-10-21T03:00:00Z');
const SOURCE_FILES = [
    'src/static/js/store/app_state.js',
    'src/static/js/utils/cache.js',
    'src/static/js/modules/common_helpers/api_runtime.js',
    'src/static/js/modules/common_helpers/transport_retry.js',
    'src/static/js/auth_feature.js',
    'src/static/js/modules/common_helpers/bootstrap_init.js',
];
const DEVICE = { member_id: 701, member_name: '計測用団員', permission: '一般', authenticated_at: '2026-10-21T02:00:00+00:00' };
const AUTH_URL = '/api/auth/devices/baseline-device';
const measurements = [];

function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

function jsonResponse(status, data) {
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function createHarness({ dataSequences, holdAuth = false, authStatus = 200, authStatuses = [], authPayload, dataResponse }) {
    const calls = [];
    const timerSchedules = [];
    const timersByHandle = new Map();
    const outstandingAuth = [];
    let authReleased = false;
    let activeAuth = 0;
    let peakAuth = 0;
    const queues = new Map(Object.entries(dataSequences).map(([url, statuses]) => [url, [...statuses]]));
    const authQueue = [...authStatuses];
    const storage = new Map([
        ['kanadePortalDeviceId', 'baseline-device'],
        ['kanadePortalAuthenticated', 'true'],
    ]);
    const sandbox = {
        console: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
        AbortController, DOMException, Date,
        Math: Object.assign(Object.create(Math), { random: () => 0.5 }),
        setTimeout(callback, ms, ...args) {
            // Capture every schedule, including cancelled request deadlines.
            // Classify by the immediate production source, never by its delay:
            // a 503 jitter delay need not be one of the old 250/750ms values.
            const source = String(new Error().stack || '').split('\n')
                .map((line) => SOURCE_FILES.find((file) => line.replaceAll('\\', '/').includes(file)))
                .find(Boolean) || null;
            const kind = source === SOURCE_FILES[3] ? 'transport-retry'
                : source === SOURCE_FILES[2] ? 'api-runtime' : 'other';
            const record = {
                source, kind, delayMs: Number(ms ?? 0), scheduledAtMs: Date.now() - FIXED_NOW,
                firedAtMs: null, cancelledAtMs: null,
            };
            timerSchedules.push(record);
            const handle = setTimeout(() => {
                record.firedAtMs = Date.now() - FIXED_NOW;
                callback(...args);
            }, ms);
            timersByHandle.set(handle, record);
            return handle;
        },
        clearTimeout(handle) {
            const record = timersByHandle.get(handle);
            if (record && record.firedAtMs === null && record.cancelledAtMs === null) {
                record.cancelledAtMs = Date.now() - FIXED_NOW;
            }
            clearTimeout(handle);
        },
        navigator: { onLine: true },
        document: { visibilityState: 'visible', addEventListener: vi.fn() },
        addEventListener: vi.fn(),
        localStorage: {
            getItem: (key) => storage.get(key) ?? null,
            setItem: (key, value) => storage.set(key, String(value)),
            removeItem: (key) => storage.delete(key),
        },
        showAlert: vi.fn(),
        enterPortal: vi.fn().mockResolvedValue(undefined),
        loadEssentialData: vi.fn().mockResolvedValue(undefined),
        loadPartSettingsForLogin: vi.fn(),
        closePortalDrawer: vi.fn(),
        portalFileOperationsResume: vi.fn().mockResolvedValue(undefined),
        portalStartup: {
            mark: vi.fn(), setMessage: vi.fn(), ready: vi.fn(), showRetry: vi.fn(),
        },
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    function load(file) {
        let source = fs.readFileSync(path.join(ROOT, file), 'utf8');
        if (file === SOURCE_FILES[SOURCE_FILES.length - 1]) {
            // These functions live inside the existing startup-binding block.
            // Export references in this VM only; do not copy their logic or
            // edit the production file to make the baseline harness work.
            const blockEnd = source.lastIndexOf('}');
            source = source.slice(0, blockEnd)
                + '\nglobalThis.__baselineEntries = { start: _runAuthAndStart, resume: syncPortalSessionOnResume };\n'
                + source.slice(blockEnd);
        }
        vm.runInContext(source, sandbox, { filename: file });
    }
    load(SOURCE_FILES[0]);
    const state = sandbox.portalAppState;
    // Known session identity, but authentication and essential data need a check.
    // Response identity stays constant, avoiding a different account-change case.
    Object.assign(state, {
        currentUserMemberId: DEVICE.member_id,
        currentUserPermission: DEVICE.permission,
        portalAuthGeneration: DEVICE.authenticated_at,
    });
    const dbCache = {
        getEntry: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
    };
    sandbox.portalRuntimeContext = {
        appState: state,
        PORTAL_DEVICE_ID_KEY: 'kanadePortalDeviceId',
        PORTAL_AUTH_KEY: 'kanadePortalAuthenticated',
        getById: () => null,
        today: () => '2026-10-21',
        inFlightGetRequests: new Map(), dbCache,
    };
    sandbox.fetch = vi.fn(async (url, options) => {
        const isAuth = url === AUTH_URL;
        const queue = queues.get(url);
        if (!isAuth && (!queue || !queue.length)) throw new Error(`Unexpected/excess mock fetch: ${url}`);
        const status = isAuth ? (authQueue.length ? authQueue.shift() : authStatus) : queue.shift();
        calls.push({ url, method: options.method || 'GET', status, atMs: Date.now() - FIXED_NOW, kind: isAuth ? 'auth' : 'data' });
        if (isAuth) {
            activeAuth += 1;
            peakAuth = Math.max(peakAuth, activeAuth);
            try {
                if (holdAuth && !authReleased) {
                    const pending = deferred();
                    outstandingAuth.push(pending);
                    await pending.promise;
                }
                return jsonResponse(status, authPayload === undefined ? { authenticated: true, device: { ...DEVICE } } : authPayload);
            } finally {
                activeAuth -= 1;
            }
        }
        return dataResponse ? dataResponse(status)
            : jsonResponse(status, status === 200 ? [{ id: 1, title: '架空データ' }] : { detail: `HTTP ${status}` });
    });
    SOURCE_FILES.slice(1).forEach(load);
    for (const [key, name] of Object.entries({ start: '_runAuthAndStart', resume: 'syncPortalSessionOnResume' })) {
        const entry = sandbox.__baselineEntries?.[key];
        const message = `bootstrap_init.js test export ${key}: insertion must expose ${name}`;
        expect(typeof entry, message).toBe('function');
        expect(entry.name, message).toBe(name);
    }
    // Count real side effects without replacing their implementation.
    const originalApply = sandbox.applyPortalAuthDevice;
    const originalClear = sandbox.clearPortalAuthState;
    sandbox.applyPortalAuthDevice = vi.fn((device) => originalApply(device));
    sandbox.clearPortalAuthState = vi.fn(() => originalClear());

    return {
        sandbox, state, dbCache, calls,
        releaseAuth() {
            authReleased = true;
            outstandingAuth.forEach((pending) => pending.resolve());
        },
        expectConsumed({ remaining = {}, alerts = 0 } = {}) {
            for (const [url, queue] of queues) expect(queue, `unconsumed statuses for ${url}`).toEqual(remaining[url] || []);
            expect(authQueue).toEqual([]);
            expect(activeAuth).toBe(0);
            expect(sandbox.portalRuntimeContext.inFlightGetRequests.size).toBe(0);
            expect(vi.getTimerCount()).toBe(0);
            expect(sandbox.console.error).not.toHaveBeenCalled();
            expect(sandbox.showAlert).toHaveBeenCalledTimes(alerts);
        },
        measure(id, input) {
            const result = {
                id, input,
                dataSends: calls.filter((call) => call.kind === 'data').length,
                authSends: calls.filter((call) => call.kind === 'auth').length,
                totalSends: calls.length, peakConcurrentAuth: peakAuth,
                applyCalls: sandbox.applyPortalAuthDevice.mock.calls.length,
                clearCalls: sandbox.clearPortalAuthState.mock.calls.length,
                authEndMarks: sandbox.portalStartup.mark.mock.calls.filter(([name]) => name === 'AUTH_END').length,
                fileOperationResumeCalls: sandbox.portalFileOperationsResume.mock.calls.length,
                enterPortalCalls: sandbox.enterPortal.mock.calls.length,
                essentialLoadStubCalls: sandbox.loadEssentialData.mock.calls.length,
                cacheReads: dbCache.getEntry.mock.calls.length,
                cacheWrites: dbCache.set.mock.calls.length,
                retrySleepsMs: timerSchedules.filter((timer) => timer.kind === 'transport-retry').map((timer) => timer.delayMs),
                timerSchedules: timerSchedules.map((timer) => ({ ...timer })),
                fakeElapsedMs: Date.now() - FIXED_NOW,
                dbQueries: null, lastSeenWrites: null, calls: [...calls],
            };
            return result;
        },
    };
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(FIXED_NOW);
});

afterEach(() => { vi.useRealTimers(); });

afterAll(() => {
    const destination = process.env.PORTAL_PERF_STAGE2_BASELINE_REPORT;
    if (!destination || measurements.length !== 5) return;
    const output = path.resolve(ROOT, destination);
    const relative = path.relative(path.join(ROOT, '.tmp'), output);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('Baseline report must be written below repository .tmp/');
    }
    const report = {
        schemaVersion: 2, phase: 'after', mode: 'node-vm/mock-fetch/fake-timers',
        fixedNow: new Date(FIXED_NOW).toISOString(), nodeVersion: process.version, platform: process.platform,
        harnessSha256: crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),
        fixture: {
            deviceId: 'baseline-device', device: DEVICE, localAuthKey: 'true',
            initialPortalAuthVerified: false, initialEssentialDataLoaded: false,
            initialAuthGeneration: DEVICE.authenticated_at,
            note: 'Known same-account identity isolates send/coalescing behavior from account-switch response rejection; not a cold-browser startup.',
        },
        sourceSha256: Object.fromEntries(SOURCE_FILES.map((file) => [file,
            crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, file))).digest('hex')])),
        limitations: [
            'No browser, HAR, actual BFCache or real-device verification.',
            'Startup/resume entry functions are invoked directly; DOMContentLoaded/event delivery is not simulated.',
            'enterPortal/loadEssentialData and file-operation resume are stubs; their downstream traffic is excluded.',
            'No real network, DB, last_seen update, GCS, bytes, CPU or wall-clock latency measurements.',
            'Historical before JSON is retained; these measurements replay its inputs against the stage 2B implementation.',
        ],
        scenarios: [...measurements].sort((a, b) => a.id.localeCompare(b.id)),
    };
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', 'utf8');
});

test('measurement recorder captures non-legacy retry waits, other timers and cancelled deadlines', async () => {
    const h = createHarness({ dataSequences: {} });
    expect(await h.sandbox.tryRecoverPortalSession('baseline-device')).toBe(true);
    // Synthetic recorder check only, not a claim that production already uses
    // jitter. Give this VM snippet the retry module's filename for attribution.
    vm.runInContext('setTimeout(function syntheticRetryWait() {}, 1000);', h.sandbox, { filename: SOURCE_FILES[3] });
    h.sandbox.setTimeout(() => {}, 17);
    await vi.advanceTimersByTimeAsync(1000);
    const result = h.measure('recorder-self-check-not-a-baseline-scenario', {});
    expect(result.retrySleepsMs).toEqual([1000]);
    expect(result.timerSchedules).toHaveLength(3);
    expect(result.timerSchedules).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'api-runtime', delayMs: 10000, firedAtMs: null, cancelledAtMs: 0 }),
        expect.objectContaining({ kind: 'transport-retry', delayMs: 1000, firedAtMs: 1000, cancelledAtMs: null }),
        expect.objectContaining({ kind: 'other', delayMs: 17, firedAtMs: 17, cancelledAtMs: null }),
    ]));
    h.expectConsumed();
    // Do not append this synthetic check to the five historical measurements.
});

describe('stage 2B comparison measurements (production JS, mock HTTP)', () => {
    test('B01: 503 -> 401 recovery -> 502 -> 200 uses four data sends', async () => {
        const statuses = [503, 401, 502, 200];
        const h = createHarness({ dataSequences: { '/api/performances': statuses } });
        const pending = h.sandbox.request('/api/performances');
        await vi.runAllTimersAsync();
        expect(await pending).toEqual([{ id: 1, title: '架空データ' }]);
        expect(h.calls.filter((call) => call.kind === 'data').map((call) => call.status)).toEqual(statuses);
        const result = h.measure('B01-short-retry-chain', { statuses });
        expect(result).toMatchObject({ dataSends: 4, authSends: 1, applyCalls: 1, clearCalls: 0, authEndMarks: 0, fakeElapsedMs: 1750 });
        expect(result.retrySleepsMs).toEqual([1000, 750]);
        h.expectConsumed();
        measurements.push(result);
    });

    test('B02: the transient budget survives recovery and stops at four data sends', async () => {
        const statuses = [503, 502, 401, 502, 504, 200];
        const h = createHarness({ dataSequences: { '/api/performances': statuses } });
        const pending = h.sandbox.request('/api/performances').then(() => null, (error) => error);
        await vi.runAllTimersAsync();
        expect((await pending).message).toContain('HTTP 502');
        expect(h.calls.filter((call) => call.kind === 'data').map((call) => call.status)).toEqual(statuses.slice(0, 4));
        const result = h.measure('B02-six-data-send-witness', { statuses });
        expect(result).toMatchObject({ dataSends: 4, authSends: 1, totalSends: 5, applyCalls: 1, fakeElapsedMs: 1750 });
        expect(result.retrySleepsMs).toEqual([1000, 750]);
        h.expectConsumed({ remaining: { '/api/performances': [504, 200] }, alerts: 1 });
        measurements.push(result);
    });

    test('B03: startup, resume and two distinct 401 requests share one auth send', async () => {
        const dataSequences = { '/api/performances': [401, 200], '/api/schedules': [401, 200] };
        const h = createHarness({ dataSequences, holdAuth: true });
        const pending = Promise.all([
            h.sandbox.__baselineEntries.start(),
            h.sandbox.__baselineEntries.resume(),
            h.sandbox.__baselineEntries.resume(), // existing resume guard suppresses this one
            h.sandbox.request('/api/performances'),
            h.sandbox.request('/api/schedules'),
        ]);
        // Drain dispatch/response microtasks while holding all auth responses.
        // Release does not depend on the old count (4), so stage 2B can replay
        // the same schedule after coalescing it to one authentication send.
        await vi.advanceTimersByTimeAsync(0);
        expect(h.calls.filter((call) => call.kind === 'data').map((call) => call.status)).toEqual([401, 401]);
        h.releaseAuth();
        await pending;
        const result = h.measure('B03-overlapping-auth-entry-points', { dataSequences, resumeEntries: 2 });
        expect(result).toMatchObject({ dataSends: 4, authSends: 1, totalSends: 5, peakConcurrentAuth: 1,
            applyCalls: 4, clearCalls: 0, authEndMarks: 2, fileOperationResumeCalls: 4,
            enterPortalCalls: 1, essentialLoadStubCalls: 1, fakeElapsedMs: 0 });
        expect(result.retrySleepsMs).toEqual([]);
        h.expectConsumed();
        measurements.push(result);
    });

    test('C01: identical concurrent data GETs already coalesce', async () => {
        const h = createHarness({ dataSequences: { '/api/performances': [401, 200] }, holdAuth: true });
        const pending = Promise.all([h.sandbox.request('/api/performances'), h.sandbox.request('/api/performances')]);
        await vi.advanceTimersByTimeAsync(0);
        h.releaseAuth();
        const values = await pending;
        expect(values[0]).toEqual(values[1]);
        const result = h.measure('C01-existing-identical-get-coalescing', { callers: 2 });
        expect(result).toMatchObject({ dataSends: 2, authSends: 1, applyCalls: 1, cacheReads: 1 });
        h.expectConsumed();
        measurements.push(result);
    });

    test('C02: a completed recovery is not reused by a later recovery', async () => {
        const h = createHarness({ dataSequences: {} });
        expect(await h.sandbox.tryRecoverPortalSession('baseline-device')).toBe(true);
        expect(await h.sandbox.tryRecoverPortalSession('baseline-device')).toBe(true);
        const result = h.measure('C02-no-completed-auth-cache', { sequentialRecoveryCalls: 2 });
        expect(result).toMatchObject({ dataSends: 0, authSends: 2, peakConcurrentAuth: 1, applyCalls: 2 });
        h.expectConsumed();
        measurements.push(result);
    });
});

describe('stage 2B authentication and transport contracts', () => {
    test.each([401, 403, 404, 'unauthenticated', 'missing-device', 'authenticated'].flatMap((outcome) =>
        ['recovery-first', 'verification-first'].map((order) => [outcome, order])))(
        'shared auth %s preserves caller results and final state (%s)', async (outcome, order) => {
            const rejected = typeof outcome === 'number';
            const missing = outcome === 'missing-device';
            const accepted = outcome === 'authenticated';
            const h = createHarness({ dataSequences: {}, holdAuth: true,
                authStatus: rejected ? outcome : 200,
                authPayload: rejected ? undefined : accepted ? { authenticated: true, device: { ...DEVICE, authenticated_at: 'shared-server-generation' } }
                    : { authenticated: missing } });
            const calls = {
                recovery: () => h.sandbox.tryRecoverPortalSession('baseline-device'),
                verification: () => h.sandbox.isPortalAuthenticated({ forceVerify: true }),
            };
            const first = order === 'recovery-first' ? 'recovery' : 'verification';
            const second = first === 'recovery' ? 'verification' : 'recovery';
            const pending = { [first]: calls[first](), [second]: calls[second]() };
            await vi.advanceTimersByTimeAsync(0);
            h.releaseAuth();
            expect(await pending.recovery).toBe(accepted);
            expect((await pending.verification).status).toBe(accepted || missing ? 'authenticated' : 'unauthenticated');
            expect(h.calls.filter((call) => call.kind === 'auth')).toHaveLength(1);
            expect(h.sandbox.applyPortalAuthDevice).toHaveBeenCalledTimes(accepted ? 2 : missing ? 1 : 0);
            expect(h.sandbox.clearPortalAuthState).toHaveBeenCalledTimes(accepted ? 0 : missing ? 1 : 2);
            const finalAuthenticated = accepted || (missing && order === 'recovery-first');
            expect(h.state.portalAuthVerified).toBe(finalAuthenticated);
            expect(h.sandbox.localStorage.getItem('kanadePortalAuthenticated')).toBe(finalAuthenticated ? 'true' : null);
            expect(h.state.currentUserMemberId).toBe(accepted ? DEVICE.member_id : null);
            expect(h.state.portalAuthGeneration).toBe(accepted ? 'shared-server-generation' : '');
            expect(h.sandbox.portalFileOperationsResume).toHaveBeenCalledTimes(accepted ? 2 : missing ? 1 : 0);
            expect(h.state.portalAuthTransition).toBe(accepted ? 0 : missing ? 1 : 2);
            h.expectConsumed();
        }
    );

    test.each(['data-first', 'resume-first'])(
        'overlapping data 401 and resume show the existing session-expiry warning (%s)', async (order) => {
            const h = createHarness({ dataSequences: { '/probe': [401] }, holdAuth: true, authStatus: 401 });
            h.sandbox.showPortalLogin = vi.fn();
            const startData = () => h.sandbox.request('/probe').catch(() => 'discarded');
            const startResume = () => h.sandbox.__baselineEntries.resume();
            const first = order === 'data-first' ? startData() : startResume();
            await vi.advanceTimersByTimeAsync(0);
            const second = order === 'data-first' ? startResume() : startData();
            await vi.advanceTimersByTimeAsync(0);
            h.releaseAuth();
            await Promise.all([first, second]);
            expect(h.sandbox.showPortalLogin).toHaveBeenCalledTimes(1);
            expect(h.sandbox.showAlert).toHaveBeenCalledWith('ログイン期限が切れました。もう一度ログインしてください。', 'warning');
            expect(h.sandbox.showAlert).not.toHaveBeenCalledWith(expect.stringContaining('通信が不安定'), expect.anything());
            expect(h.calls.filter((call) => call.kind === 'auth')).toHaveLength(1);
            expect(h.sandbox.clearPortalAuthState).toHaveBeenCalledTimes(2);
            h.expectConsumed({ alerts: 1 });
        }
    );

    test('a new login after a logout storage event still rejects the old verification without clearing it', async () => {
        const h = createHarness({ dataSequences: {}, holdAuth: true, authStatus: 401 });
        const pending = h.sandbox.isPortalAuthenticated({ forceVerify: true });
        await vi.advanceTimersByTimeAsync(0);
        h.sandbox.localStorage.removeItem('kanadePortalAuthenticated');
        const listener = h.sandbox.addEventListener.mock.calls.find(([name]) => name === 'storage')[1];
        listener({ key: 'kanadePortalAuthenticated', newValue: null });
        h.sandbox.advancePortalAuthTransition();
        h.sandbox.applyPortalAuthDevice({ ...DEVICE, authenticated_at: 'new-login' });
        h.releaseAuth();
        expect((await pending).status).toBe('unavailable');
        expect(h.state.portalAuthGeneration).toBe('new-login');
        expect(h.state.portalAuthVerified).toBe(true);
        expect(h.sandbox.clearPortalAuthState).not.toHaveBeenCalled();
        h.expectConsumed();
    });

    test('a logout storage event is unauthenticated, while its old successful response is discarded', async () => {
        const h = createHarness({ dataSequences: {}, holdAuth: true });
        const pending = h.sandbox.isPortalAuthenticated({ forceVerify: true });
        await vi.advanceTimersByTimeAsync(0);
        h.sandbox.localStorage.removeItem('kanadePortalAuthenticated');
        const listener = h.sandbox.addEventListener.mock.calls.find(([name]) => name === 'storage')[1];
        listener({ key: 'kanadePortalAuthenticated', newValue: null });
        h.releaseAuth();
        expect((await pending).status).toBe('unauthenticated');
        expect(h.sandbox.applyPortalAuthDevice).not.toHaveBeenCalled();
        expect(h.sandbox.clearPortalAuthState).not.toHaveBeenCalled();
        h.expectConsumed();
    });

    test.each(['2', '120', '2147484', '9'.repeat(400)])(
        'unknown 503 Retry-After %s above 1500ms returns immediately without consuming retry budget', async (retryAfter) => {
            const h = createHarness({ dataSequences: { '/probe': [503] }, dataResponse: () =>
                new Response('gateway', { status: 503, headers: { 'Retry-After': retryAfter } }) });
            const budget = { transientRetries: 0, unknown503Retries: 0 };
            const response = await h.sandbox.fetchWithTimeout('/probe', { _retryContext: budget }, 15000);
            expect(response.status).toBe(503);
            expect(await response.text()).toBe('gateway');
            expect(h.measure('probe', {}).retrySleepsMs).toEqual([]);
            expect(budget).toEqual({ transientRetries: 0, unknown503Retries: 0 });
            h.expectConsumed();
        }
    );
    test('bodyless 304 recovery cannot reset an exhausted transient budget', async () => {
        const h = createHarness({ dataSequences: { '/probe': [502, 502, 304] },
            dataResponse: (status) => status === 304 ? new Response(null, { status }) : jsonResponse(status, {}) });
        const pending = h.sandbox.request('/probe').catch((error) => error);
        await vi.runAllTimersAsync();
        expect(await pending).toMatchObject({ name: 'Error', message: expect.any(String) });
        expect(h.calls.filter((call) => call.kind === 'data')).toHaveLength(3);
        h.expectConsumed({ alerts: 1 });
    });

    test('bodyless 304 and a later 401 share transient budget but allow the separate auth resend', async () => {
        const h = createHarness({ dataSequences: { '/probe': [304, 401, 502, 200] },
            dataResponse: (status) => status === 304 ? new Response(null, { status }) : jsonResponse(status, []) });
        const pending = h.sandbox.request('/probe');
        await vi.runAllTimersAsync();
        expect(await pending).toEqual([]);
        expect(h.calls.filter((call) => call.kind === 'data')).toHaveLength(4);
        expect(h.calls.filter((call) => call.kind === 'auth')).toHaveLength(1);
        h.expectConsumed();
    });
    test('authentication transient retries have a budget independent of the data request', async () => {
        const h = createHarness({ dataSequences: { '/probe': [503, 401, 502, 200] }, authStatuses: [502, 504, 200] });
        const pending = h.sandbox.request('/probe');
        await vi.runAllTimersAsync();
        await pending;
        expect(h.calls.filter((call) => call.kind === 'data')).toHaveLength(4);
        expect(h.calls.filter((call) => call.kind === 'auth')).toHaveLength(3);
        h.expectConsumed();
    });

    test('the sheet API carries its own budget across its 401 resend', async () => {
        const h = createHarness({ dataSequences: { '/api/sheets': [503, 502, 401, 502, 504, 200] } });
        // Sheet accountKey includes the verified bit; normal sheet operations
        // start authenticated, unlike the overlapping startup fixture.
        h.state.portalAuthVerified = true;
        const file = 'src/static/js/modules/scores/sheet_api.js';
        vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), h.sandbox, { filename: file });
        const pending = h.sandbox.portalSheetApi.call('/api/sheets').catch((error) => error);
        await vi.runAllTimersAsync();
        expect((await pending).status).toBe(502);
        expect(h.calls.filter((call) => call.kind === 'data')).toHaveLength(4);
        h.expectConsumed({ remaining: { '/api/sheets': [504, 200] } });
    });

    test('D08 network failures still propagate without the initial GET cache fallback', async () => {
        const h = createHarness({ dataSequences: { '/probe': [401, 'network', 'network', 'network'] }, dataResponse: (status) => {
            if (status === 'network') throw new TypeError('network down');
            return jsonResponse(status, { detail: 'unauthorized' });
        } });
        h.dbCache.getEntry.mockResolvedValue({ data: ['old'], timestamp: 0 });
        const pending = h.sandbox.request('/probe').catch((error) => error);
        await vi.runAllTimersAsync();
        expect((await pending).message).toBe('network down');
        h.expectConsumed();
    });

    test.each([['1', 1000], ['invalid', 1000], ['Thu, 22 Oct 2026 00:00:00 GMT', 1000]])(
        'unknown 503 handles Retry-After %s safely', async (retryAfter, wait) => {
            const h = createHarness({ dataSequences: { '/probe': [503, 200] }, dataResponse: (status) =>
                new Response('gateway', { status, headers: { 'Retry-After': retryAfter } }) });
            const pending = h.sandbox.fetchWithTimeout('/probe', {}, 15000);
            await vi.runAllTimersAsync();
            expect((await pending).status).toBe(200);
            expect(h.measure('probe', {}).retrySleepsMs).toEqual([wait]);
            h.expectConsumed();
        }
    );

    test('aborting during retry wait clears the timer and sends no second request', async () => {
        const h = createHarness({ dataSequences: { '/probe': [503] } });
        const controller = new AbortController();
        const pending = h.sandbox.fetchWithTimeout('/probe', { signal: controller.signal }, 15000).catch((error) => error);
        await vi.advanceTimersByTimeAsync(0);
        controller.abort();
        expect((await pending).name).toBe('AbortError');
        expect(h.calls).toHaveLength(1);
        h.expectConsumed();
    });
    test.each(['logout', 'same-device-login', 'other-device', 'storage-event'])(
        'pending authentication cannot restore an old context after %s', async (transition) => {
            const h = createHarness({ dataSequences: {}, holdAuth: true });
            const pending = h.sandbox.tryRecoverPortalSession('baseline-device');
            await vi.advanceTimersByTimeAsync(0);
            if (transition === 'logout') {
                h.sandbox.showPortalLogin = vi.fn();
                await h.sandbox.logoutPortal();
            } else if (transition === 'same-device-login') {
                h.sandbox.advancePortalAuthTransition();
                h.state.portalAuthGeneration = 'new-session';
            } else if (transition === 'other-device') {
                h.sandbox.localStorage.setItem('kanadePortalDeviceId', 'other-device');
            } else {
                const listener = h.sandbox.addEventListener.mock.calls.find(([name]) => name === 'storage')[1];
                listener({ key: 'kanadePortalAuthenticated' });
            }
            h.releaseAuth();
            expect(await pending).toBe(false);
            expect(h.sandbox.applyPortalAuthDevice).not.toHaveBeenCalled();
            expect(h.sandbox.clearPortalAuthState).not.toHaveBeenCalled();
            h.expectConsumed();
        }
    );

    test('a stale 401 does not clear a new login', async () => {
        const h = createHarness({ dataSequences: {}, holdAuth: true, authStatus: 401 });
        const pending = h.sandbox.tryRecoverPortalSession('baseline-device');
        await vi.advanceTimersByTimeAsync(0);
        h.sandbox.advancePortalAuthTransition();
        h.state.portalAuthGeneration = 'new-session';
        h.state.portalAuthVerified = true;
        h.releaseAuth();
        expect(await pending).toBe(false);
        expect(h.state.portalAuthVerified).toBe(true);
        expect(h.sandbox.clearPortalAuthState).not.toHaveBeenCalled();
        h.expectConsumed();
    });

    test('saving data changes the response epoch without invalidating authentication', async () => {
        const h = createHarness({ dataSequences: {}, holdAuth: true });
        const pending = h.sandbox.tryRecoverPortalSession('baseline-device');
        await vi.advanceTimersByTimeAsync(0);
        await h.sandbox.invalidateCacheForMutation('/api/schedules/1');
        h.releaseAuth();
        expect(await pending).toBe(true);
        expect(h.sandbox.applyPortalAuthDevice).toHaveBeenCalledTimes(1);
        h.expectConsumed();
    });

    test('shared callers may apply a legitimately updated response generation', async () => {
        const h = createHarness({ dataSequences: {}, holdAuth: true,
            authPayload: { authenticated: true, device: { ...DEVICE, authenticated_at: 'server-new-generation' } } });
        const pending = Promise.all([h.sandbox.isPortalAuthenticated(), h.sandbox.tryRecoverPortalSession('baseline-device')]);
        await vi.advanceTimersByTimeAsync(0);
        h.releaseAuth();
        const values = await pending;
        expect(values[0].status).toBe('authenticated');
        expect(values[1]).toBe(true);
        expect(h.calls).toHaveLength(1);
        expect(h.sandbox.applyPortalAuthDevice).toHaveBeenCalledTimes(2);
        expect(h.state.portalAuthGeneration).toBe('server-new-generation');
        h.expectConsumed();
    });

    test('missing device still has different startup and recovery outcomes', async () => {
        const h = createHarness({ dataSequences: {}, authPayload: { authenticated: true } });
        expect((await h.sandbox.isPortalAuthenticated()).status).toBe('authenticated');
        expect(await h.sandbox.tryRecoverPortalSession('baseline-device')).toBe(false);
        expect(h.sandbox.applyPortalAuthDevice).toHaveBeenCalledTimes(1);
        expect(h.sandbox.clearPortalAuthState).toHaveBeenCalledTimes(1);
        h.expectConsumed();
    });

    test.each(['read_capacity_exceeded', 'save_busy', 'maintenance', 'version_clock_anomaly'])(
        'classified 503 %s is not retried and its original JSON remains readable', async (code) => {
            const h = createHarness({ dataSequences: { '/probe': [503] },
                dataResponse: () => jsonResponse(503, { detail: { code, message: 'existing message' } }) });
            const response = await h.sandbox.fetchWithTimeout('/probe', { method: 'GET' }, 15000);
            expect((await response.json()).detail.code).toBe(code);
            expect(h.calls).toHaveLength(1);
            h.expectConsumed();
        }
    );

    test.each([
        ['Service temporarily unavailable', '60'],
        ['メンテナンス中です。しばらくしてから再度お試しください', '300'],
    ])('legacy maintenance %s is not retried', async (detail, retryAfter) => {
        const h = createHarness({ dataSequences: { '/probe': [503] }, dataResponse: () => new Response(JSON.stringify({ detail }),
            { status: 503, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': retryAfter } }) });
        const response = await h.sandbox.fetchWithTimeout('/probe', {}, 15000);
        expect((await response.json()).detail).toBe(detail);
        h.expectConsumed();
    });

    test('unknown HTML 503 is retried only once and the original body remains readable', async () => {
        const h = createHarness({ dataSequences: { '/probe': [503, 503] },
            dataResponse: () => new Response('<html>gateway</html>', { status: 503 }) });
        const pending = h.sandbox.fetchWithTimeout('/probe', {}, 15000);
        await vi.runAllTimersAsync();
        const response = await pending;
        expect(response.status).toBe(503);
        expect(await response.text()).toBe('<html>gateway</html>');
        expect(h.calls).toHaveLength(2);
        expect(h.measure('probe', {}).retrySleepsMs).toEqual([1000]);
        h.expectConsumed();
    });

    test('internal options are stripped without modifying caller options', async () => {
        const h = createHarness({ dataSequences: { '/probe': [200] } });
        const options = { _structuredResult: true, _forceRevalidate: true, _allowCacheFallback: false,
            _skipAuthRecovery: true, _retryContext: { transientRetries: 0, unknown503Retries: 0 } };
        const before = JSON.stringify(options);
        await h.sandbox.fetchWithTimeout('/probe', options, 15000);
        const sent = h.sandbox.fetch.mock.calls[0][1];
        expect(Object.keys(sent).filter((key) => key.startsWith('_'))).toEqual([]);
        expect(JSON.stringify(options)).toBe(before);
        h.expectConsumed();
    });
});
