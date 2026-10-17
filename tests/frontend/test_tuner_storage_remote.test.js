import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { IDBFactory } = require('fake-indexeddb');
const R = require(path.join(process.cwd(), 'src/static/js/modules/tuner/storage_remote.js'));
const L = require(path.join(process.cwd(), 'src/static/js/modules/tuner/storage_local.js'));

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, text: () => Promise.resolve(body === undefined ? '' : JSON.stringify(body)) };
}

function client(handler) {
  const calls = [];
  const remote = R.createRemoteClient({
    request: (url, init) => { calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined }); return handler(url, init, calls.length); },
    deviceId: () => 'device-1',
    setTimeout: () => 1,
    clearTimeout: () => {},
  });
  return { remote, calls };
}

describe('remote client', () => {
  it('sends only whitelisted summaries without cache and with the device header', async () => {
    const { remote, calls } = client(() => Promise.resolve(response(200, { ok: true })));
    await remote.createSession({ historyEpoch: 2 }, { sessionId: 's1', summary: { mean: NaN, n: 3 }, chunks: [1], series: new Float32Array(3), audio: 'x' }, 'op-1');
    const c = calls[0];
    expect(c.url).toBe('/api/tuner/sessions');
    expect(c.init.cache).toBe('no-store');
    expect(c.init.credentials).toBe('same-origin');
    expect(c.init.headers['X-Device-Id']).toBe('device-1');
    expect(c.body).toEqual({ schemaVersion: 1, historyEpoch: 2, clientOperationId: 'op-1', session: { sessionId: 's1', summary: { mean: null, n: 3 } } });
    expect(c.init.body).not.toMatch(/NaN|Infinity|chunks|series|audio/);
  });

  it('maps errors to codes and never throws', async () => {
    const statuses = [[401, null, 'unauthenticated'], [403, 'ACCOUNT_STORAGE_UNAVAILABLE', 'account-storage-unavailable'], [409, 'STORAGE_LIMIT', 'storage-limit'], [409, 'HISTORY_EPOCH', 'conflict'], [410, 'DELETED', 'deleted'], [413, null, 'too-large'], [503, null, 'unavailable']];
    for (const [status, code, expected] of statuses) {
      const { remote } = client(() => Promise.resolve(response(status, { detail: code ? { code } : 'x' })));
      expect((await remote.identity()).code).toBe(expected);
    }
    const { remote } = client(() => Promise.reject(new TypeError('offline')));
    expect(await remote.identity()).toEqual({ ok: false, status: 0, code: 'network' });
  });

  it('a response arriving after logout is stale and in-flight requests are aborted', async () => {
    let release;
    let signal;
    const { remote } = client((url, init) => { signal = init.signal; return new Promise((r) => { release = r; }); });
    const pending = remote.listSessions({ limit: 5 });
    await Promise.resolve();
    await Promise.resolve();
    remote.invalidate();
    expect(signal.aborted).toBe(true);
    release(response(200, { sessions: [{ id: 'someone-else' }] }));
    expect(await pending).toMatchObject({ ok: false, code: 'stale-owner' });
  });

  it('partitions events into <= 500 events and <= 1 MiB with stable hashes', () => {
    const events = Array.from({ length: 1201 }, (_, i) => ({ eventId: `e${i}`, ordinal: i, stats: { m: i }, frames: [1, 2, 3] }));
    const parts = R.partition(events);
    expect(parts.map((p) => p.events.length)).toEqual([500, 500, 201]);
    expect(parts[0].events[0]).toEqual({ eventId: 'e0', ordinal: 0, stats: { m: 0 } });
    expect(R.partition(events)[1].hash).toBe(parts[1].hash);
    const big = Array.from({ length: 30 }, (_, i) => ({ eventId: `b${i}`, stats: { text: 'x'.repeat(60000) } }));
    const bigParts = R.partition(big);
    expect(bigParts.length).toBeGreaterThan(1);
    expect(bigParts.every((p) => p.bytes <= R.MAX_PART_BYTES)).toBe(true);
  });
});

describe('outbox synchronisation', () => {
  async function setup(historyEpoch = 1) {
    const local = L.createLocalStore({ idbFactory: new IDBFactory() });
    await local.open();
    const ctx = local.setOwner({ ownerId: 'owner-a', kind: 'account', historyEpoch });
    const s = await local.beginSession(ctx, { startedAt: 1, summary: { n: 2 } });
    await local.putEvents(ctx, s.sessionId, [{ eventId: 'e1', ordinal: 0, stats: { medianCents: 2 } }, { eventId: 'e2', ordinal: 1, stats: { medianCents: NaN } }]);
    await local.finalizeSession(ctx, s.sessionId, { n: 2 });
    await local.enqueue(ctx, { type: 'upload-session', sessionId: s.sessionId });
    return { local, ctx, sessionId: s.sessionId };
  }

  it('uploads session, parts and finalize in order and removes the operation', async () => {
    const { local, ctx, sessionId } = await setup();
    const { remote, calls } = client(() => Promise.resolve(response(200, { ok: true })));
    const report = await R.syncOutbox({ local, remote, ctx, isCurrent: (c) => !local.isStale(c) });
    expect(report).toEqual({ sent: 1, dropped: 0, kept: 0, stoppedBy: null });
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      'POST /api/tuner/sessions',
      `PUT /api/tuner/sessions/${sessionId}/parts/0`,
      `POST /api/tuner/sessions/${sessionId}/finalize`,
    ]);
    expect(calls[1].body.events[1].stats.medianCents).toBeNull();
    expect(calls[2].body).toMatchObject({ partCount: 1, eventCount: 2, historyEpoch: 1 });
    expect(await local.outbox(ctx)).toEqual([]);
  });

  it('keeps operations on network errors and stops on 401 / 403', async () => {
    const { local, ctx } = await setup();
    const net = client(() => Promise.reject(new Error('offline')));
    expect(await R.syncOutbox({ local, remote: net.remote, ctx, isCurrent: () => true })).toMatchObject({ kept: 1 });
    const [op] = await local.outbox(ctx);
    expect(op).toMatchObject({ attempts: 1, lastError: 'network' });
    const auth = client(() => Promise.resolve(response(401, { detail: 'x' })));
    expect(await R.syncOutbox({ local, remote: auth.remote, ctx, isCurrent: () => true })).toMatchObject({ stoppedBy: 'unauthenticated', kept: 0 });
    expect(await local.outbox(ctx)).toHaveLength(1);
  });

  it('drops operations of an older history epoch and of server-deleted sessions (no resurrection)', async () => {
    const { local, ctx } = await setup(1);
    const newer = local.setOwner({ ownerId: 'owner-a', kind: 'account', historyEpoch: 2 });
    const { remote, calls } = client(() => Promise.resolve(response(200, {})));
    expect(await R.syncOutbox({ local, remote, ctx: newer, isCurrent: (c) => !local.isStale(c) })).toMatchObject({ dropped: 1, sent: 0 });
    expect(calls).toHaveLength(0);
    const second = await setup(1);
    const gone = client(() => Promise.resolve(response(410, { detail: { code: 'DELETED' } })));
    expect(await R.syncOutbox({ local: second.local, remote: gone.remote, ctx: second.ctx, isCurrent: () => true })).toMatchObject({ dropped: 1 });
    expect(await second.local.outbox(second.ctx)).toEqual([]);
  });

  it('never sends a queued operation under another account; device owners do not sync', async () => {
    const { local, ctx } = await setup();
    const { remote, calls } = client(() => Promise.resolve(response(200, {})));
    local.setOwner({ ownerId: 'owner-b', kind: 'account', historyEpoch: 1 }); // another person signs in
    expect(await R.syncOutbox({ local, remote, ctx, isCurrent: (c) => !local.isStale(c) })).toMatchObject({ sent: 0 });
    expect(calls).toHaveLength(0);
    const device = local.setOwner({ ownerId: 'local-1', kind: 'device' });
    expect(await R.syncOutbox({ local, remote, ctx: device, isCurrent: () => true })).toMatchObject({ stoppedBy: 'no-account' });
  });

  it('logout during an upload stops before the next part', async () => {
    const { local, ctx } = await setup();
    let current = true;
    const { remote, calls } = client(() => { current = false; return Promise.resolve(response(200, {})); });
    const report = await R.syncOutbox({ local, remote, ctx, isCurrent: () => current });
    expect(calls).toHaveLength(1); // only createSession went out
    expect(report.stoppedBy).toBe('stale-owner');
  });
});
