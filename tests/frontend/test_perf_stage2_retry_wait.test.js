const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createHttpHarness } = require('./helpers/portal_http_harness.cjs');

const BEFORE = process.env.PORTAL_PERF_WAIT_PHASE === 'before';
const metrics = [];
const busy = (seconds = '300', code = 'maintenance') => new Response(JSON.stringify({ detail: { code, message: 'fixture busy' } }),
    { status: 503, headers: { 'Content-Type': 'application/json', 'Retry-After': seconds } });
const ok = () => new Response('[]', { headers: { 'Content-Type': 'application/json' } });
function harness(respond = () => busy()) {
    const h = createHttpHarness(respond);
    vm.runInContext(fs.readFileSync('src/static/js/modules/common_helpers/transport_retry.js', 'utf8'), h.ctx);
    return h;
}
const get = (h, url = '/api/extra/albums', options = {}) => h.ctx.request(url, options).catch((error) => ({ error: error.message }));
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-21T03:00:00Z')); });
afterEach(() => vi.useRealTimers());
afterAll(() => {
    const dest = process.env.PORTAL_PERF_WAIT_REPORT;
    if (!dest || metrics.length !== 5) return;
    const target = path.resolve(dest);
    if (!target.startsWith(path.resolve('.tmp') + path.sep)) throw new Error('Report must be below .tmp');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const files = ['src/static/js/modules/common_helpers/api_runtime.js', 'src/static/js/modules/common_helpers/transport_retry.js'];
    fs.writeFileSync(target, JSON.stringify({ phase: BEFORE ? 'before' : 'after', mode: 'Node VM/mock HTTP/fake timers',
        sourceSha256: Object.fromEntries(files.map((file) => [file, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')])),
        metrics, dbQueries: null, browserVerified: false }, null, 2) + '\n');
});

test('W01 same-key manual clicks coalesce and may probe at 10 seconds even during Retry-After 300', async () => {
    const start = Date.now();
    const h = harness(() => Date.now() - start >= 10000 ? ok() : busy());
    await get(h);
    await Promise.all([get(h), get(h), get(h)]);
    const immediate = h.calls.length;
    await vi.advanceTimersByTimeAsync(9999);
    await get(h);
    const beforeTen = h.calls.length;
    await vi.advanceTimersByTimeAsync(1);
    expect(await get(h)).toEqual([]);
    expect([immediate, beforeTen, h.calls.length]).toEqual(BEFORE ? [2, 3, 4] : [1, 1, 2]);
    metrics.push({ id: 'W01', sends: [immediate, beforeTen, h.calls.length] });
});

test('W02 automatic polling cannot use the manual 10-second exception', async () => {
    const start = Date.now();
    const h = harness(() => Date.now() - start >= 300000 ? ok() : busy());
    await get(h);
    await vi.advanceTimersByTimeAsync(10000);
    await get(h, '/api/extra/albums', { _requestOrigin: 'automatic' });
    const duringWait = h.calls.length;
    await vi.advanceTimersByTimeAsync(290000);
    expect(await get(h, '/api/extra/albums', { _requestOrigin: 'automatic' })).toEqual([]);
    expect([duringWait, h.calls.length]).toEqual(BEFORE ? [2, 3] : [1, 2]);
    metrics.push({ id: 'W02', sends: [duringWait, h.calls.length] });
});

test('W03 another URL and forced fetch have independent wait keys', async () => {
    const h = harness((url, _options, count) => url === '/api/events' || count === 3 ? ok() : busy());
    await get(h);
    expect(await get(h, '/api/events')).toEqual([]);
    expect(await get(h, '/api/extra/albums', { _forceRevalidate: true })).toEqual([]);
    await get(h);
    expect(h.calls).toHaveLength(BEFORE ? 4 : 3);
    metrics.push({ id: 'W03', sends: h.calls.length });
});

test('W04 account changes never reuse the previous account wait or cached body', async () => {
    const h = harness();
    await get(h);
    await get(h);
    const oldAccount = h.calls.length;
    h.state.currentUserMemberId = 8;
    await get(h);
    expect([oldAccount, h.calls.length]).toEqual(BEFORE ? [2, 3] : [1, 2]);
    metrics.push({ id: 'W04', sends: [oldAccount, h.calls.length] });
});

test('W05 successful manual probe clears only its own wait', async () => {
    const start = Date.now();
    const h = harness((url) => url === '/api/extra/albums' && Date.now() - start >= 10000 ? ok() : busy());
    await get(h);
    await get(h, '/api/members');
    await vi.advanceTimersByTimeAsync(10000);
    expect(await get(h)).toEqual([]);
    expect(await get(h, '/api/extra/albums', { _requestOrigin: 'automatic' })).toEqual([]);
    await get(h, '/api/members', { _requestOrigin: 'automatic' });
    expect(h.calls).toHaveLength(BEFORE ? 5 : 4);
    metrics.push({ id: 'W05', sends: h.calls.length });
});

test.skipIf(BEFORE)('blocked retries do not extend the manual deadline and show remaining time with existing alerts', async () => {
    const h = harness();
    await get(h);
    await vi.advanceTimersByTimeAsync(9000);
    await get(h);
    expect(h.calls).toHaveLength(1);
    expect(h.ctx.showAlert).toHaveBeenCalledWith(expect.stringContaining('あと1秒'), 'warning');
    await vi.advanceTimersByTimeAsync(1000);
    await get(h);
    expect(h.calls).toHaveLength(2);
    await get(h);
    expect(h.calls).toHaveLength(2);
});

test.skipIf(BEFORE)('explicit logout invalidates wait entries even for the same device and identity', async () => {
    const h = harness();
    await get(h);
    h.ctx.advancePortalAuthTransition();
    await get(h);
    expect(h.calls).toHaveLength(2);
});

test.skipIf(BEFORE)('saving unrelated data changes the response epoch without cancelling a server wait', async () => {
    const h = harness();
    await get(h);
    await h.ctx.invalidateCacheForMutation('/api/events/1');
    await get(h);
    expect(h.calls).toHaveLength(1);
});

test.skipIf(BEFORE)('the transport strips request origin without mutating caller options', async () => {
    const h = harness(() => ok());
    const options = Object.freeze({ _requestOrigin: 'automatic' });
    await h.ctx.fetchWithTimeout('/api/events', options, 15000);
    expect(h.calls[0].options._requestOrigin).toBeUndefined();
    expect(options._requestOrigin).toBe('automatic');
});

test.skipIf(BEFORE)('temporary wait responses preserve HTTP status, JSON and result-unknown contracts', async () => {
    const h = harness();
    const url = '/api/promotions/operations/fixture';
    const first = await h.ctx.request(url, { _structuredResult: true });
    const second = await h.ctx.request(url, { _structuredResult: true });
    expect(first).toEqual(second);
    expect(second.status).toBe(503);
    expect(second.data.detail.code).toBe('maintenance');
    expect(h.calls).toHaveLength(1);
});

test.skipIf(BEFORE).each(['invalid', 'Thu, 22 Oct 2026 00:00:00 GMT', '0'])(
    'an uninterpretable Retry-After %s does not invent a persistent server deadline', async (seconds) => {
        const h = harness(() => busy(seconds));
        await get(h);
        await get(h);
        expect(h.calls).toHaveLength(1);
        await get(h, '/api/extra/albums', { _requestOrigin: 'automatic' });
        expect(h.calls).toHaveLength(2);
    }
);

test.skipIf(BEFORE)('version clock anomalies keep the administrator message without automatic retry', async () => {
    const h = harness(() => busy('300', 'version_clock_anomaly'));
    await get(h); await get(h);
    expect(h.calls).toHaveLength(1);
    expect(h.ctx.showAlert).toHaveBeenCalledWith(expect.stringContaining('fixture busy'), 'warning');
});

test.skipIf(BEFORE)('headerless HTML 503 has one jitter retry and a ten-second manual interval', async () => {
    const h = harness(() => new Response('<html>gateway busy</html>', { status: 503 }));
    const pending = get(h);
    await vi.advanceTimersByTimeAsync(1500);
    await pending;
    expect(h.calls).toHaveLength(2);
    await Promise.all([get(h), get(h), get(h)]);
    expect(h.calls).toHaveLength(2);
    expect(h.ctx.portalRetryWaitInfo('/api/extra/albums').blocked).toBe(true);
    expect(h.ctx.portalRetryWaitInfo('/api/extra/albums', { _requestOrigin: 'automatic' }).blocked).toBe(false);
    await vi.advanceTimersByTimeAsync(10000);
    const probe = get(h);
    await vi.advanceTimersByTimeAsync(1500);
    await probe;
    expect(h.calls).toHaveLength(4);
});

test.skipIf(BEFORE).each(['POST', 'PUT', 'DELETE'])(
    'successful %s clears related list and bootstrap waits, retaining unrelated waits', async (method) => {
        let saved = false;
        const h = harness((_url, options) => {
            if (options.method === method) { saved = true; return ok(); }
            return saved ? ok() : busy();
        });
        await get(h);
        await get(h, '/api/extra/albums?view=all', { _forceRevalidate: true });
        await get(h, '/api/bootstrap-lite');
        await get(h, '/api/members');
        await h.ctx.request('/api/extra/albums/5', { method });
        expect(h.ctx.portalRetryWaitInfo('/api/extra/albums')).toBeNull();
        expect(h.ctx.portalRetryWaitInfo('/api/extra/albums?view=all', { _forceRevalidate: true })).toBeNull();
        expect(h.ctx.portalRetryWaitInfo('/api/bootstrap-lite')).toBeNull();
        expect(h.ctx.portalRetryWaitInfo('/api/members').blocked).toBe(true);
        h.ctx.showAlert.mockClear();
        // Match existing post-save callers that omit _requestOrigin.
        expect(await get(h, '/api/extra/albums')).toEqual([]);
        expect(h.db.delete).toHaveBeenCalledWith('/api/extra/albums');
        expect(h.ctx.showAlert).not.toHaveBeenCalled();
        expect(h.calls).toHaveLength(6);
    }
);

test.skipIf(BEFORE)('failed saves do not release related waits', async () => {
    const h = harness(() => busy());
    await get(h);
    await h.ctx.request('/api/extra/albums/5', { method: 'PUT' }).catch(() => {});
    expect(h.ctx.portalRetryWaitInfo('/api/extra/albums').blocked).toBe(true);
});

test.skipIf(BEFORE).each([true, false])('late 503 registration respects related mutation targets (%s)', async (related) => {
    let finish;
    const h = harness(() => new Promise((resolve) => { finish = resolve; }));
    const pending = h.ctx.fetchWithTimeout('/api/extra/albums', {}, 15000);
    await h.ctx.invalidateCacheForMutation(related ? '/api/extra/albums/5' : '/api/events/1');
    finish(busy());
    await pending;
    expect(Boolean(h.ctx.portalRetryWaitInfo('/api/extra/albums')?.blocked)).toBe(!related);
});

test.skipIf(BEFORE)('a late success cannot clear a more recently received 503 wait', async () => {
    let finish;
    const h = harness((_url, _options, count) => count === 1 ? new Promise((resolve) => { finish = resolve; }) : busy());
    const slow = h.ctx.fetchWithTimeout('/probe', {}, 15000);
    await h.ctx.fetchWithTimeout('/probe', {}, 15000);
    finish(ok()); await slow;
    expect(h.ctx.portalRetryWaitInfo('/probe', { _requestOrigin: 'automatic' }).blocked).toBe(true);
    await h.ctx.fetchWithTimeout('/probe', {}, 15000);
    expect(h.calls).toHaveLength(2);
});

test.skipIf(BEFORE)('an eligible direct-call probe reserves its interval before network IO', async () => {
    let finish;
    const h = harness((_url, _options, count) => count === 1 ? busy() : new Promise((resolve) => { finish = resolve; }));
    await h.ctx.fetchWithTimeout('/probe', {}, 15000);
    await vi.advanceTimersByTimeAsync(10000);
    const probe = h.ctx.fetchWithTimeout('/probe', {}, 15000);
    const other = await h.ctx.fetchWithTimeout('/probe', {}, 15000);
    expect(other.status).toBe(503);
    expect(h.calls).toHaveLength(2);
    finish(ok()); expect((await probe).status).toBe(200);
    expect(h.ctx.portalRetryWaitInfo('/probe')).toBeNull();
});

test.skipIf(BEFORE)('abort before an eligible probe does not consume the next manual interval', async () => {
    const h = harness();
    await get(h);
    await vi.advanceTimersByTimeAsync(10000);
    const controller = new AbortController(); controller.abort();
    await expect(h.ctx.fetchWithTimeout('/api/extra/albums', { signal: controller.signal }, 15000)).rejects.toThrow();
    await get(h);
    expect(h.calls).toHaveLength(2);
});

test.skipIf(BEFORE)('headers are normalized but different explicit tenants do not share a wait', async () => {
    const h = harness();
    await get(h, '/probe', { headers: { 'X-Tenant-Id': 'one' } });
    await get(h, '/probe', { headers: new Headers({ 'x-tenant-id': 'one' }) });
    expect(h.calls).toHaveLength(1);
    await get(h, '/probe', { headers: { 'X-Tenant-Id': 'two' } });
    expect(h.calls).toHaveLength(2);
});

test.skipIf(BEFORE)('a stale 503 after a transition cannot repopulate the next session wait', async () => {
    let finish;
    const h = harness(() => new Promise((resolve) => { finish = resolve; }));
    const pending = h.ctx.fetchWithTimeout('/probe', {}, 15000);
    h.ctx.advancePortalAuthTransition();
    finish(busy()); await pending;
    expect(h.ctx.portalRetryWaitInfo('/probe')).toBeNull();
});

test.skipIf(BEFORE)('write requests are not suppressed or retried by the GET wait policy', async () => {
    const h = harness();
    await h.ctx.fetchWithTimeout('/probe', { method: 'POST' }, 15000);
    await h.ctx.fetchWithTimeout('/probe', { method: 'POST' }, 15000);
    expect(h.calls).toHaveLength(2);
    expect(h.ctx.portalRetryWaitInfo('/probe')).toBeNull();
});

test.skipIf(BEFORE)('automatic promotion polling is explicitly tagged and cannot become a new manual action', async () => {
    const h = harness();
    const store = new Map();
    Object.assign(h.ctx, { Blob, TextEncoder, crypto: require('node:crypto').webcrypto,
        location: { origin: 'https://fixture.invalid' }, document: { hidden: false },
        sessionStorage: { getItem: (key) => store.get(key) || null, setItem: (key, value) => store.set(key, value), removeItem: (key) => store.delete(key) } });
    vm.runInContext(fs.readFileSync('src/static/js/modules/date_piece_promotion/api.js', 'utf8'), h.ctx);
    h.ctx.checkPromotionOperation = vi.fn(async () => false);
    const pending = h.ctx.runPromotionOperation('POST', '', { title: 'fixture' }, null, '{}');
    // Crypto resolves on the host task queue, independently of fake timers.
    for (let i = 0; i < 50 && !h.calls.length; i++) await new Promise((resolve) => require('node:timers').setImmediate(resolve));
    await vi.runAllTimersAsync();
    expect(await pending).toBe(false);
    expect(h.ctx.checkPromotionOperation).toHaveBeenCalledTimes(6);
    for (const [options] of h.ctx.checkPromotionOperation.mock.calls) expect(options._requestOrigin).toBe('automatic');
    expect(store.size).toBe(1);
});
