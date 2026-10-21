const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createHttpHarness } = require('./helpers/portal_http_harness.cjs');

const BEFORE = process.env.PORTAL_PERF_HTTP_PHASE === 'before';
const metrics = [];
const json = (data, headers = {}) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json', ...headers } });

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-21T03:00:00Z')); });
afterEach(() => vi.useRealTimers());
afterAll(() => {
    const dest = process.env.PORTAL_PERF_HTTP_REPORT;
    if (!dest || metrics.length !== 5) return;
    const absolute = path.resolve(dest);
    if (!absolute.startsWith(path.resolve('.tmp') + path.sep)) throw new Error('Report must be below .tmp');
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    const sources = ['src/static/js/modules/common_helpers/api_runtime.js', 'src/static/js/utils/cache.js'];
    fs.writeFileSync(absolute, JSON.stringify({ phase: BEFORE ? 'before' : 'after', mode: 'Node VM / mock HTTP',
        sourceSha256: Object.fromEntries(sources.map((file) => [file, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')])),
        metrics, dbQueries: null, browserVerified: false }, null, 2) + '\n');
});

test('normal and forced GET have independent flights while normal GET still coalesces', async () => {
    const h = createHttpHarness(() => json(['server']));
    const values = await Promise.all([h.ctx.request('/api/events'), h.ctx.request('/api/events'), h.ctx.request('/api/events', { _forceRevalidate: true })]);
    expect(values).toEqual([['server'], ['server'], ['server']]);
    expect(h.calls).toHaveLength(BEFORE ? 1 : 2);
    metrics.push({ id: 'force-flight', sends: h.calls.length });
});

test('explicit tenant headers bypass short reuse, conditional headers and cache writes', async () => {
    const h = createHttpHarness(() => json(['server'], { ETag: '"new"' }));
    h.cache.set('/api/events', { data: ['old'], etag: '"old"', timestamp: Date.now() });
    const result = await h.ctx.request('/api/events', { headers: { 'x-OrGaNiZaTiOn-Id': '' } });
    expect(result).toEqual(BEFORE ? ['old'] : ['server']);
    expect(h.calls).toHaveLength(BEFORE ? 0 : 1);
    if (!BEFORE) {
        expect(h.db.getEntry).not.toHaveBeenCalled();
        expect(h.db.set).not.toHaveBeenCalled();
        expect(h.calls[0].options.cache).toBe('no-store');
        expect(h.calls[0].options.headers['If-None-Match']).toBeUndefined();
    }
    metrics.push({ id: 'tenant-bypass', sends: h.calls.length, cacheReads: h.db.getEntry.mock.calls.length, cacheWrites: h.db.set.mock.calls.length });
});

test('304 refreshes validation time so the following GET can reuse the body', async () => {
    const h = createHttpHarness(() => new Response(null, { status: 304, headers: { ETag: '"same"' } }));
    h.cache.set('/api/events', { data: [], etag: '"same"', timestamp: Date.now() - 60000 });
    await h.ctx.request('/api/events');
    await h.ctx.request('/api/events');
    expect(h.calls).toHaveLength(BEFORE ? 2 : 1);
    expect(h.db.set).toHaveBeenCalledTimes(BEFORE ? 0 : 1);
    metrics.push({ id: '304-freshness', sends: h.calls.length, writes: h.db.set.mock.calls.length });
});

test('304 without a cached body retries once without conditional headers', async () => {
    const h = createHttpHarness((_url, _options, count) => count === 1 ? new Response(null, { status: 304 }) : json(['server']));
    const pending = h.ctx.request('/api/events').catch((error) => ({ error: error.message }));
    const result = await pending;
    if (BEFORE) expect(result.error).toBeTruthy();
    else {
        expect(result).toEqual(['server']);
        expect(h.calls[1].options.headers['If-None-Match']).toBeUndefined();
    }
    expect(h.calls).toHaveLength(BEFORE ? 1 : 2);
    metrics.push({ id: '304-missing-body', sends: h.calls.length, resolved: !result.error });
});

test('non-JSON promotion 503 preserves its HTTP status in structured results', async () => {
    const h = createHttpHarness(() => new Response('<html>gateway</html>', { status: 503, headers: { 'Retry-After': '3' } }));
    const result = await h.ctx.request('/api/promotions/operations/fixture', { _structuredResult: true }).catch((error) => ({ error: error.name }));
    if (BEFORE) expect(result.error).toBe('SyntaxError');
    else expect(result).toEqual({ status: 503, data: null, retryAfter: '3' });
    metrics.push({ id: 'promotion-html-503', sends: h.calls.length, status: result.status ?? null, parseError: Boolean(result.error) });
});

test.each([new Headers({ 'X-Tenant-Id': '' }), [['x-tenant-id', 'other']], { 'X-Organization-Id': 'other' }])(
    'tenant bypass supports standard header representations', async (headers) => {
        if (BEFORE) return; // no before metric; the plain-object baseline is above
        const h = createHttpHarness(() => json([]));
        await Promise.all([h.ctx.request('/api/events', { headers }), h.ctx.request('/api/events', { headers })]);
        expect(h.calls).toHaveLength(2);
        expect(h.db.getEntry).not.toHaveBeenCalled();
        expect(h.calls[0].options.cache).toBe('no-store');
    }
);

test.skipIf(BEFORE)('a second bodyless 304 stops without looping', async () => {
    const h = createHttpHarness(() => new Response(null, { status: 304 }));
    await expect(h.ctx.request('/api/events')).rejects.toThrow();
    expect(h.calls).toHaveLength(2);
});

test.skipIf(BEFORE)('explicit tenant requests do not fall back to another cached body offline', async () => {
    const h = createHttpHarness(() => { throw new Error('offline'); });
    h.cache.set('/api/events', { data: ['old'], timestamp: Date.now(), etag: 'old' });
    await expect(h.ctx.request('/api/events', { headers: { 'X-Tenant-Id': 'other' } })).rejects.toThrow();
    expect(h.db.getEntry).not.toHaveBeenCalled();
    expect(h.db.set).not.toHaveBeenCalled();
});

test.skipIf(BEFORE).each(['/api/bootstrap', '/api/auth/devices/fixture', '/api/portal-file-actor', '/api/portal-file-operations/fixture'])(
    'sensitive response %s is never persisted or read from application cache', async (url) => {
        const h = createHttpHarness(() => json({}, { ETag: '"never-cache"' }));
        await h.ctx.request(url);
        expect(h.db.getEntry).not.toHaveBeenCalled();
        expect(h.db.set).not.toHaveBeenCalled();
        expect(h.calls[0].options.cache).toBe('no-store');
    }
);

test.skipIf(BEFORE)('malformed successful promotion JSON remains an error', async () => {
    const h = createHttpHarness(() => new Response('broken', { status: 200 }));
    await expect(h.ctx.request('/api/promotions/operations/fixture', { _structuredResult: true })).rejects.toThrow();
});

test.skipIf(BEFORE)('malformed promotion 4xx retains the previous parse-error behavior', async () => {
    const h = createHttpHarness(() => new Response('broken', { status: 400 }));
    await expect(h.ctx.request('/api/promotions/operations/fixture', { _structuredResult: true })).rejects.toThrow();
});

test.skipIf(BEFORE)('an account switch during the 304 timestamp write cannot return the previous body', async () => {
    const h = createHttpHarness(() => new Response(null, { status: 304 }));
    h.cache.set('/api/events', { data: ['previous'], timestamp: Date.now() - 60000, etag: 'old' });
    h.db.set.mockImplementation(async () => { h.state.currentUserMemberId = 9; });
    await expect(h.ctx.request('/api/events')).rejects.toThrow('表示情報が更新されました');
});

test.skipIf(BEFORE).each(['/api/bootstrap-lite', '/api/bootstrap-core', '/api/members', '/api/member-introductions', '/api/extra/albums'])(
    '304 on %s returns the cached body without rewriting it when short reuse is disabled', async (url) => {
        const h = createHttpHarness(() => new Response(null, { status: 304 }));
        const entry = { data: ['cached'], timestamp: Date.now() - 60000, etag: 'old' };
        h.cache.set(url, entry);
        expect(await h.ctx.request(url)).toEqual(['cached']);
        expect(await h.ctx.request(url)).toEqual(['cached']);
        expect(h.calls).toHaveLength(2);
        expect(h.db.set).not.toHaveBeenCalled();
        expect(h.cache.get(url)).toBe(entry);
    }
);

test.skipIf(BEFORE).each(['/api/performances', '/api/schedules', '/api/announcements'])(
    '304 on short-reuse list %s updates validation time once', async (url) => {
        const h = createHttpHarness(() => new Response(null, { status: 304 }));
        h.cache.set(url, { data: [], timestamp: Date.now() - 60000, etag: 'old' });
        await h.ctx.request(url);
        await h.ctx.request(url);
        expect(h.calls).toHaveLength(1);
        expect(h.db.set).toHaveBeenCalledTimes(1);
    }
);
