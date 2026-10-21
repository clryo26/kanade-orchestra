const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

// Characterization measurements of the unmodified production entry points.
// Counts below describe the old behavior, not the desired retry/single-flight
// contract. Keep the archived baseline when changing these assertions in 2B.
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

function createHarness({ dataSequences, holdAuth = false }) {
    const calls = [];
    const retrySleeps = [];
    const outstandingAuth = [];
    let authReleased = false;
    let activeAuth = 0;
    let peakAuth = 0;
    const queues = new Map(Object.entries(dataSequences).map(([url, statuses]) => [url, [...statuses]]));
    const storage = new Map([
        ['kanadePortalDeviceId', 'baseline-device'],
        ['kanadePortalAuthenticated', 'true'],
    ]);
    const sandbox = {
        console: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
        AbortController, DOMException, Date,
        setTimeout(callback, ms, ...args) {
            if (ms === 250 || ms === 750) retrySleeps.push(ms);
            return setTimeout(callback, ms, ...args);
        },
        clearTimeout,
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
        const status = isAuth ? 200 : queue.shift();
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
                return jsonResponse(200, { authenticated: true, device: { ...DEVICE } });
            } finally {
                activeAuth -= 1;
            }
        }
        return jsonResponse(status, status === 200 ? [{ id: 1, title: '架空データ' }] : { detail: `HTTP ${status}` });
    });
    SOURCE_FILES.slice(1).forEach(load);
    // Count real side effects without replacing their implementation.
    const originalApply = sandbox.applyPortalAuthDevice;
    const originalClear = sandbox.clearPortalAuthState;
    sandbox.applyPortalAuthDevice = vi.fn((device) => originalApply(device));
    sandbox.clearPortalAuthState = vi.fn(() => originalClear());

    return {
        sandbox, state, dbCache, calls, retrySleeps,
        releaseAuth() {
            authReleased = true;
            outstandingAuth.forEach((pending) => pending.resolve());
        },
        expectConsumed() {
            for (const [url, queue] of queues) expect(queue, `unconsumed statuses for ${url}`).toEqual([]);
            expect(activeAuth).toBe(0);
            expect(sandbox.portalRuntimeContext.inFlightGetRequests.size).toBe(0);
            expect(vi.getTimerCount()).toBe(0);
            expect(sandbox.console.error).not.toHaveBeenCalled();
            expect(sandbox.showAlert).not.toHaveBeenCalled();
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
                retrySleepsMs: [...retrySleeps], fakeElapsedMs: Date.now() - FIXED_NOW,
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
        schemaVersion: 1, phase: 'before', mode: 'node-vm/mock-fetch/fake-timers',
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
            'Historical characterization assertions must be reviewed when implementing stage 2B; archive this before report.',
        ],
        scenarios: [...measurements].sort((a, b) => a.id.localeCompare(b.id)),
    };
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', 'utf8');
});

describe('stage 2B before measurements (production JS, mock HTTP)', () => {
    test('B01: 503 -> 401 recovery -> 502 -> 200 uses four data sends', async () => {
        const statuses = [503, 401, 502, 200];
        const h = createHarness({ dataSequences: { '/api/performances': statuses } });
        const pending = h.sandbox.request('/api/performances');
        await vi.runAllTimersAsync();
        expect(await pending).toEqual([{ id: 1, title: '架空データ' }]);
        expect(h.calls.filter((call) => call.kind === 'data').map((call) => call.status)).toEqual(statuses);
        const result = h.measure('B01-short-retry-chain', { statuses });
        expect(result).toMatchObject({ dataSends: 4, authSends: 1, applyCalls: 1, clearCalls: 0, authEndMarks: 0, fakeElapsedMs: 500 });
        expect(result.retrySleepsMs).toEqual([250, 250]);
        h.expectConsumed();
        measurements.push(result);
    });

    test('B02: both transport budgets are spent, allowing six data sends', async () => {
        const statuses = [503, 502, 401, 502, 504, 200];
        const h = createHarness({ dataSequences: { '/api/performances': statuses } });
        const pending = h.sandbox.request('/api/performances');
        await vi.runAllTimersAsync();
        expect(await pending).toEqual([{ id: 1, title: '架空データ' }]);
        expect(h.calls.filter((call) => call.kind === 'data').map((call) => call.status)).toEqual(statuses);
        const result = h.measure('B02-six-data-send-witness', { statuses });
        expect(result).toMatchObject({ dataSends: 6, authSends: 1, totalSends: 7, applyCalls: 1, fakeElapsedMs: 2000 });
        expect(result.retrySleepsMs).toEqual([250, 750, 250, 750]);
        h.expectConsumed();
        measurements.push(result);
    });

    test('B03: startup, resume and two distinct 401 requests send four concurrent auth checks', async () => {
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
        expect(result).toMatchObject({ dataSends: 4, authSends: 4, totalSends: 8, peakConcurrentAuth: 4,
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
