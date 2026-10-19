import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { IDBFactory } = require('fake-indexeddb');
const S = require(path.join(process.cwd(), 'src/static/js/modules/tuner/storage_local.js'));

function frames(n, base2 = 0, step2 = 1600) {
  const f = { frame2: [], hz: [], conf: [], rms: [], reason: [], flags: [] };
  for (let i = 0; i < n; i += 1) {
    f.frame2.push(base2 + i * step2);
    f.hz.push(i % 7 === 3 ? null : 440 * 2 ** ((i % 11) / 1200));
    f.conf.push(0.9);
    f.rms.push(-30 - i * 0.01);
    f.reason.push(i % 7 === 3 ? 2 : 0);
    f.flags.push(i % 5 === 0 ? 16 : 0);
  }
  return f;
}

async function openStore(extra = {}) {
  const idbFactory = extra.idbFactory || new IDBFactory();
  let t = 1_800_000_000_000;
  const store = S.createLocalStore(Object.assign({ idbFactory, now: () => (t += 1) }, extra));
  const res = await store.open();
  return { store, idbFactory, res };
}

describe('standard series format', () => {
  it('round-trips Float32 values within 1e-4 cent and keeps missing values missing', () => {
    const f = frames(200, 2 * 48000 * 10 + 801);
    const enc = S.encodeChunk({ epochId: 3, sampleRate: 48000, baseFrame: 48000 * 10, engineVersion: 'yin-2' }, f);
    expect(enc.data.byteLength).toBe(200 * S.BYTES_PER_FRAME);
    const dec = S.decodeChunk(enc);
    for (let i = 0; i < 200; i += 1) {
      expect(dec.frame2[i]).toBe(f.frame2[i]); // exact effective time
      if (f.hz[i] === null) {
        expect(Number.isNaN(dec.hz[i])).toBe(true); // never 0 Hz
      } else {
        expect(Math.abs(1200 * Math.log2(dec.hz[i] / f.hz[i]))).toBeLessThanOrEqual(1e-4);
      }
      expect(dec.reason[i]).toBe(f.reason[i]);
      expect(dec.flags[i]).toBe(f.flags[i]);
    }
    expect(() => S.decodeChunk({ header: Object.assign({}, enc.header, { formatVersion: 99 }), data: enc.data })).toThrow();
    expect(() => S.encodeChunk({ baseFrame: 10, sampleRate: 48000 }, frames(1, 0))).toThrow();
  });

  it('neutralises spreadsheet formulas in CSV', () => {
    expect(S.csvCell('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
    expect(S.csvCell('+1')).toBe('"\'+1"');
    expect(S.csvCell('-2')).toBe('"\'-2"');
    expect(S.csvCell('@cmd')).toBe('"\'@cmd"');
    expect(S.csvCell(-2.5)).toBe('-2.5'); // numbers stay numbers
    expect(S.csvCell(NaN)).toBe('');
    expect(S.csvCell(null)).toBe('');
  });
});

describe('local history store (fake IndexedDB)', () => {
  it('includes the final fractional second of a JST day and excludes next midnight', async () => {
    const { store } = await openStore();
    const ctx = store.setOwner({ ownerId: 'day-boundary' });
    const before = Date.parse('2026-10-20T00:00:00+09:00');
    const last = await store.beginSession(ctx, { startedAt: before - 500 });
    await store.finalizeSession(ctx, last.sessionId, {});
    const next = await store.beginSession(ctx, { startedAt: before });
    await store.finalizeSession(ctx, next.sessionId, {});
    const rows = await store.listSessions(ctx, { from: before - 86400000, before });
    expect(rows.map((r) => r.sessionId)).toEqual([last.sessionId]);
    // The pre-existing inclusive "to" option keeps its contract.
    expect(await store.listSessions(ctx, { to: before })).toHaveLength(2);
  });
  it('opens, saves a session with chunks and events, and reads it back', async () => {
    const { store, res } = await openStore();
    expect(res).toMatchObject({ ok: true, status: 'open' });
    const ctx = store.setOwner({ ownerId: 'owner-a' });
    const begun = await store.beginSession(ctx, { startedAt: 1, a4Tenths: 4420, temperament: 'equal' });
    expect(begun.ok).toBe(true);
    const enc = S.encodeChunk({ epochId: 1, sampleRate: 48000, baseFrame: 0 }, frames(50));
    expect(await store.appendChunk(ctx, begun.sessionId, 0, enc, null)).toMatchObject({ ok: true });
    expect(await store.putEvents(ctx, begun.sessionId, [{ eventId: 'e1', medianCents: 3.2, targetLabel: '=A4' }])).toMatchObject({ ok: true, count: 1 });
    expect(await store.finalizeSession(ctx, begun.sessionId, { events: 1 })).toEqual({ ok: true });
    const got = await store.getSession(ctx, begun.sessionId);
    expect(got.session.status).toBe('complete');
    expect(got.chunks).toHaveLength(1);
    expect(got.events).toHaveLength(1);
    const q = await store.quotaState();
    expect(q.usedBytes).toBeGreaterThan(enc.data.byteLength);
    const json = await store.exportJson(ctx);
    expect(json.sessions[0].session.ownerId).toBeUndefined();
    expect(json.sessions[0].series[0].frequencyHz[3]).toBeNull();
    const csv = await store.exportCsv(ctx);
    expect(csv).toContain('"\'=A4"');
  });

  it('keeps owners apart and drops completions after an owner change', async () => {
    const { store } = await openStore();
    const a = store.setOwner({ ownerId: 'owner-a' });
    const s = await store.beginSession(a, { startedAt: 5 });
    const b = store.setOwner({ ownerId: 'owner-b' });
    expect(await store.listSessions(b)).toEqual([]);
    expect(await store.getSession(b, s.sessionId)).toBeNull();
    // The old context is stale now: reads are empty, writes refused.
    expect(store.isStale(a)).toBe(true);
    expect(await store.listSessions(a)).toEqual([]);
    expect(await store.beginSession(a, { startedAt: 6 })).toEqual({ ok: false, reason: 'stale-owner' });
    // A write that was started before logout resolves as stale.
    const c = store.setOwner({ ownerId: 'owner-c' });
    const pending = store.beginSession(c, { startedAt: 7 });
    store.clearOwner();
    expect(await pending).toEqual({ ok: false, reason: 'stale-owner' });
    const c2 = store.setOwner({ ownerId: 'owner-c' });
    expect(await store.listSessions(c2)).toEqual([]); // nothing was written after logout
    // Re-login as A gives a new epoch; A's own data is visible again.
    const a2 = store.setOwner({ ownerId: 'owner-a' });
    expect((await store.listSessions(a2)).map((r) => r.sessionId)).toEqual([s.sessionId]);
  });

  it('stops saving at the device quota and the session limits without deleting anything', async () => {
    const { store } = await openStore({ limits: { deviceBytes: 6000, sessionEvents: 3, sessionSeconds: 1 } });
    const ctx = store.setOwner({ ownerId: 'owner-a' });
    const s = await store.beginSession(ctx, { startedAt: 1 });
    const enc = S.encodeChunk({ epochId: 1, sampleRate: 48000, baseFrame: 0 }, frames(40));
    expect((await store.appendChunk(ctx, s.sessionId, 0, enc, null)).ok).toBe(true);
    expect(await store.appendChunk(ctx, s.sessionId, 1, S.encodeChunk({ epochId: 1, sampleRate: 48000, baseFrame: 0 }, frames(20)), null)).toMatchObject({ ok: false, reason: 'session-limit' });
    expect(await store.putEvents(ctx, s.sessionId, [{}, {}, {}, {}])).toMatchObject({ ok: false, reason: 'event-limit' });
    const big = S.encodeChunk({ epochId: 1, sampleRate: 48000, baseFrame: 0 }, frames(300));
    const s2 = await store.beginSession(ctx, { startedAt: 2 });
    expect(await store.appendChunk(ctx, s2.sessionId, 0, big, null)).toMatchObject({ ok: false, reason: 'quota' });
    expect((await store.getSession(ctx, s.sessionId)).chunks).toHaveLength(1); // kept
    // Limits can only be lowered, never raised.
    const raised = S.createLocalStore({ idbFactory: new IDBFactory(), limits: { deviceBytes: 1e12 } });
    await raised.open();
    expect((await raised.quotaState()).limitBytes).toBe(S.LIMITS.deviceBytes);
  });

  it('delete leaves a tombstone: delayed writes and a delayed start of the same id are refused', async () => {
    const { store } = await openStore();
    const ctx = store.setOwner({ ownerId: 'owner-a' });
    const s = await store.beginSession(ctx, { startedAt: 1 });
    await store.appendChunk(ctx, s.sessionId, 0, S.encodeChunk({ epochId: 1, sampleRate: 48000, baseFrame: 0 }, frames(10)), null);
    await store.enqueue(ctx, { type: 'upload-session', sessionId: s.sessionId });
    expect(await store.deleteSession(ctx, s.sessionId)).toEqual({ ok: true });
    expect(await store.isTombstoned(ctx, 'session', s.sessionId)).toBe(true);
    expect(await store.getSession(ctx, s.sessionId)).toBeNull();
    expect(await store.outbox(ctx)).toEqual([]); // pending upload dropped
    expect(await store.appendChunk(ctx, s.sessionId, 1, S.encodeChunk({ epochId: 1, sampleRate: 48000, baseFrame: 0 }, frames(10)), null)).toMatchObject({ ok: false, reason: 'not-recording' });
    expect(await store.putEvents(ctx, s.sessionId, [{}])).toMatchObject({ ok: false, reason: 'missing' });
    expect(await store.beginSession(ctx, { sessionId: s.sessionId, startedAt: 1 })).toMatchObject({ ok: false, reason: 'deleted' });
    expect((await store.quotaState()).usedBytes).toBe(0);
  });

  it('delete all removes only this owner and keeps other owners', async () => {
    const { store } = await openStore();
    const a = store.setOwner({ ownerId: 'owner-a' });
    const sa = await store.beginSession(a, { startedAt: 1 });
    await store.putEvents(a, sa.sessionId, [{ eventId: 'x' }]);
    await store.putInstrument(a, { name: 'Vn' });
    const b = store.setOwner({ ownerId: 'owner-b' });
    const sb = await store.beginSession(b, { startedAt: 1 });
    await store.putEvents(b, sb.sessionId, [{ eventId: 'x' }]);
    const a2 = store.setOwner({ ownerId: 'owner-a' });
    expect(await store.deleteAll(a2)).toEqual({ ok: true });
    expect(await store.listSessions(a2)).toEqual([]);
    expect(await store.listInstruments(a2, true)).toEqual([]);
    const b2 = store.setOwner({ ownerId: 'owner-b' });
    expect((await store.getSession(b2, sb.sessionId)).events).toHaveLength(1);
  });

  it('recovers sessions left recording as incomplete and keeps their chunks', async () => {
    const idbFactory = new IDBFactory();
    const first = await openStore({ idbFactory });
    const ctx = first.store.setOwner({ ownerId: 'owner-a' });
    const s = await first.store.beginSession(ctx, { startedAt: 1 });
    await first.store.appendChunk(ctx, s.sessionId, 0, S.encodeChunk({ epochId: 1, sampleRate: 48000, baseFrame: 0 }, frames(10)), null);
    first.store.close(); // tab closed while recording
    const second = await openStore({ idbFactory });
    const ctx2 = second.store.setOwner({ ownerId: 'owner-a' });
    expect(await second.store.recoverIncomplete(ctx2)).toEqual({ ok: true, recovered: 1 });
    const got = await second.store.getSession(ctx2, s.sessionId);
    expect(got.session.status).toBe('incomplete');
    expect(got.chunks).toHaveLength(1);
  });

  it('withdrawing consent clears the unsent outbox; queued operations carry the epochs', async () => {
    const { store } = await openStore();
    const ctx = store.setOwner({ ownerId: 'owner-a', historyEpoch: 4 });
    await store.enqueue(ctx, { type: 'upload-session', sessionId: 's1' });
    await store.enqueue(ctx, { type: 'upload-session', sessionId: 's2' });
    const rows = await store.outbox(ctx);
    expect(rows.map((r) => [r.sessionId, r.historyEpoch, r.ownerEpochAtQueue])).toEqual([['s1', 4, ctx.ownerEpoch], ['s2', 4, ctx.ownerEpoch]]);
    expect(await store.clearOutbox(ctx)).toEqual({ ok: true, removed: 2 });
    expect(await store.outbox(ctx)).toEqual([]);
  });

  it('a newer (unknown) database version makes the store read-only without wiping it', async () => {
    const idbFactory = new IDBFactory();
    await new Promise((resolve) => {
      const req = idbFactory.open(S.DB_NAME, S.DB_VERSION + 1);
      req.onupgradeneeded = () => req.result.createObjectStore('future');
      req.onsuccess = () => { req.result.close(); resolve(); };
    });
    const store = S.createLocalStore({ idbFactory });
    expect(await store.open()).toMatchObject({ ok: false, status: 'readonly', reason: 'unknown-schema' });
    const ctx = store.setOwner({ ownerId: 'owner-a' });
    expect(await store.beginSession(ctx, { startedAt: 1 })).toMatchObject({ ok: false });
    const names = await new Promise((resolve) => {
      const req = idbFactory.open(S.DB_NAME);
      req.onsuccess = () => { const list = Array.from(req.result.objectStoreNames); req.result.close(); resolve(list); };
    });
    expect(names).toEqual(['future']);
  });

  it('without IndexedDB the store is unavailable and nothing throws', async () => {
    const store = S.createLocalStore({ idbFactory: null });
    const saved = globalThis.indexedDB;
    try {
      delete globalThis.indexedDB;
      expect(await store.open()).toMatchObject({ ok: false, status: 'unavailable' });
    } finally {
      if (saved) globalThis.indexedDB = saved;
    }
    const ctx = store.setOwner({ ownerId: 'x' });
    expect(await store.listSessions(ctx)).toEqual([]);
    expect(await store.enqueue(ctx, {})).toEqual({ ok: false, reason: 'unavailable' });
  });
});
