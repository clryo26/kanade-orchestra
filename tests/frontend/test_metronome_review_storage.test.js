import path from 'node:path';
import { createRequire } from 'node:module';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';

// Regression tests for R-05 (saving generations), R-06 (budget) and R-09
// (30-minute record) at the logic level with fake-indexeddb. H-010 (real
// two-tab browser order) is still open and is not claimed here.
const require = createRequire(import.meta.url);
const dir = path.join(process.cwd(), 'src/static/js/modules/metronome');
const SL = require(path.join(dir, 'storage_local.js'));
const SR = require(path.join(dir, 'storage_remote.js'));
const WS = require(path.join(dir, 'workspace.js'));
const TR = require(path.join(dir, 'trainer.js'));

let seq = 0;
const uuid = () => { seq += 1; return `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`; };
const settle = async () => { for (let i = 0; i < 40; i += 1) await new Promise((r) => setTimeout(r, 0)); };

function deferredIdentity() {
  let release;
  const gate = new Promise((r) => { release = r; });
  return {
    remote: {
      identity: () => gate.then(() => ({ ok: true, data: { accountStorageAvailable: true, ownerId: 'owner-a', historyEpoch: 1, consentRevision: 1, accountConsent: true } })),
      invalidate: () => {},
      getPreferences: () => Promise.resolve({ ok: true, data: { revision: 1 } }),
      putPreferences: () => Promise.resolve({ ok: true }),
    },
    release: () => release(),
  };
}

function practiceResult(attemptId) {
  return { kind: 'practice', attemptId, programRunId: uuid(), startedAt: '2026-10-18T00:00:00Z', endedAt: 'x', status: 'complete', endReason: 'program-end', program: { steps: [{ exercise: 'play' }], repeat: 1 }, steps: [{ index: 0, iteration: 0, endReason: 'bars', bars: 4, activeSeconds: 8, startBpmTenths: 1200, endBpmTenths: 1200, tempoChanges: 0 }] };
}

function workspace(remote, opts = {}) {
  const writes = [];
  const factory = opts.factory || new IDBFactory();
  const local = SL.createLocalHistory({ indexedDB: factory, IDBKeyRange, now: () => opts.clock ? opts.clock.t : Date.now(), budgetBytes: opts.budgetBytes });
  const spyLocal = Object.assign({}, local, {
    saveSession: (...a) => { writes.push('session'); return local.saveSession(...a); },
    appendDetails: (...a) => { writes.push('details'); return local.appendDetails(...a); },
  });
  const ws = WS.createWorkspace({ local: spyLocal, remote, remoteLib: SR, uuid, utcNow: () => new Date(opts.clock ? opts.clock.t : Date.now()).toISOString(), deviceId: () => 'dev' });
  return { ws, local, writes, factory };
}

describe('R-05 saving generations', () => {
  it('saving turned off while the identity is still loading: no write starts afterwards', async () => {
    const d = deferredIdentity();
    const { ws, writes } = workspace(d.remote);
    ws.setPolicy({ historyMode: 'auto', destination: 'local' });
    ws.beginAttempt('a1');
    const saving = ws.recordResult(practiceResult('a1'));
    await ws.setPolicy({ historyMode: 'none', destination: 'local' });
    d.release();
    const r = await saving;
    expect(r.ok).toBe(false);
    expect(['SAVE_CANCELLED', 'no-token']).toContain(r.code || r.reason);
    await settle();
    expect(writes).toEqual([]);
  });

  it('a deletion (e.g. in another tab) after the attempt started but before its token: the old attempt is never saved with the new generation', async () => {
    const d = deferredIdentity();
    const { ws, local } = workspace(d.remote);
    d.release();
    await ws.setPolicy({ historyMode: 'auto', destination: 'local' }); // opens the database
    await local.beginAttempt({ ownerId: 'owner-a', serverHistoryEpoch: 1, consentRevision: 1 });
    // The attempt starts (its deletion ticket is taken at once) ...
    const begun = ws.beginAttempt('old', { observing: true });
    // ... and another tab deletes everything before this tab fixed its token.
    await local.deleteAll('owner-a');
    expect(await begun).toEqual({ ok: false, code: 'STALE_LOCAL_GENERATION' });
    const r = await ws.recordResult(practiceResult('old'));
    expect(r.ok).toBe(false);
    expect((await local.list('owner-a'))).toHaveLength(0);
    // A new attempt after the deletion is saved normally.
    await ws.beginAttempt('new', { observing: true });
    expect((await ws.recordResult(practiceResult('new'))).ok).toBe(true);
  });

  it('consent withdrawn during an attempt: the result stays on the device, no upload is queued', async () => {
    const d = deferredIdentity();
    d.release();
    const { ws, local } = workspace(d.remote);
    await ws.setPolicy({ historyMode: 'auto', destination: 'account' });
    ws.beginAttempt('c1');
    await ws.setAccountConsent(false); // consent epoch changes
    const r = await ws.recordResult(practiceResult('c1'));
    expect(r.ok).toBe(true);
    expect(r.localOnly).toBeTruthy();
    expect(await local.outbox('owner-a')).toHaveLength(0);
  });

  it('logout while the token is pending: nothing is written for the old owner', async () => {
    const d = deferredIdentity();
    const { ws, writes } = workspace(d.remote);
    ws.setPolicy({ historyMode: 'auto', destination: 'local' });
    ws.beginAttempt('l1');
    const saving = ws.recordResult(practiceResult('l1'));
    ws.invalidateOwner();
    d.release();
    expect((await saving).ok).toBe(false);
    await settle();
    expect(writes).toEqual([]);
  });

  it('a newer attempt does not cancel the save of an older one (DC-19)', async () => {
    const d = deferredIdentity();
    const { ws } = workspace(d.remote);
    ws.setPolicy({ historyMode: 'auto', destination: 'local' });
    ws.beginAttempt('A');
    ws.beginAttempt('B');
    const a = ws.recordResult(practiceResult('A'));
    d.release();
    expect((await a).ok).toBe(true);
  });

  it('manual mode: the waiting results are capped (count and size)', async () => {
    const d = deferredIdentity();
    d.release();
    const { ws } = workspace(d.remote);
    await ws.setPolicy({ historyMode: 'manual', destination: 'local' });
    const results = [];
    for (let i = 0; i < 12; i += 1) {
      ws.beginAttempt(`m${i}`);
      results.push(await ws.recordResult(practiceResult(`m${i}`)));
    }
    expect(results.filter((r) => r.pending)).toHaveLength(10);
    expect(results[11]).toMatchObject({ ok: false, code: 'PENDING_FULL' });
  });
});

describe('R-06 budget of the metronome history', () => {
  const identity = { ownerId: 'owner-a', serverHistoryEpoch: 1, consentRevision: 1 };
  const session = (id, extra = {}) => ({ sessionId: id, attemptId: uuid(), kind: 'analysis', status: 'recording', startedAt: '2026-10-18T00:00:00Z', activeDurationMs: 1000, durationMs: 1000, counts: { target: 0, valid: 0, localDetail: 0, extraDetail: 0, extraTotal: 0, groups: 0 }, summary: {}, ...extra });
  const detail = (i) => ({ kind: 'target', eventId: `3:meter:${i}:0`, layerId: 'meter', beatKey: `b${i % 4}`, conditionKey: 'r3|4-4,g1.1.1.1,p1-4,s0|Lmeter|route:speaker|cal:c1|onset-rise-v1|out:worklet@48000', expectedMs: 123456.78, e: 12.34, ratio: 2.47, ioiRatio: 1.0012, reason: null });

  it('books every write and deletion; refuses a write beyond the budget before storing it', async () => {
    const local = SL.createLocalHistory({ indexedDB: new IDBFactory(), IDBKeyRange, budgetBytes: 40 * 1024 });
    const token = await local.beginAttempt(identity);
    expect((await local.saveSession(token, session('s1'))).ok).toBe(true);
    const u1 = await local.usage('owner-a');
    expect(u1.totalBytes).toBeGreaterThan(0);
    const rows = Array.from({ length: 256 }, (_, i) => detail(i));
    expect((await local.appendDetails(token, 's1', rows, 0)).ok).toBe(true);
    const u2 = await local.usage('owner-a');
    const perRow = (u2.totalBytes - u1.totalBytes) / 256;
    expect(perRow).toBeGreaterThan(20); // packed batch: a few dozen bytes per beat (estimate)
    expect(perRow).toBeLessThan(291);
    // Fill until the budget refuses; the refused batch is not stored.
    let refused = null;
    for (let k = 1; k < 40 && !refused; k += 1) {
      const r = await local.appendDetails(token, 's1', rows.map((x, i) => ({ ...x, eventId: `k${k}:${i}` })), k * 256);
      if (!r.ok) refused = { r, k };
    }
    expect(refused.r.code).toBe('BUDGET');
    const before = await local.usage('owner-a');
    expect(before.totalBytes).toBeLessThanOrEqual(40 * 1024);
    const stored = await local.getSession('owner-a', 's1');
    expect(stored.details).toHaveLength(refused.k * 256);
    expect(stored.details[300]).toMatchObject({ ordinal: 300, kind: 'target', layerId: 'meter', e: 12.34 }); // packed rows come back whole
    // Deleting frees the booked bytes.
    await local.deleteSession('owner-a', 's1', 'now');
    expect((await local.usage('owner-a')).totalBytes).toBeLessThan(1024);
    expect((await local.canStore(36000)).code).toBe('BUDGET'); // 36000 x 256 B > 40 KiB
  });

  it('measures the stored size per detail row (estimate input for the 64 MiB budget)', async () => {
    const local = SL.createLocalHistory({ indexedDB: new IDBFactory(), IDBKeyRange });
    const token = await local.beginAttempt(identity);
    await local.saveSession(token, session('s1'));
    const u0 = await local.usage(null);
    await local.appendDetails(token, 's1', Array.from({ length: 256 }, (_, i) => detail(i)), 0);
    const per = ((await local.usage(null)).totalBytes - u0.totalBytes) / 256;
    // Packed batches (R-06): 5 full records plus metadata stay within 64 MiB
    // only if per <= (64 MiB - 4 MiB - 5 x 2 MiB) / (5 x 36000) = 291 B.
    // The value is an estimate of this implementation, not the browser's
    // real usage (MT-13 in a real browser is still open).
    const allowed = (64 * 1024 * 1024 - 4 * 1024 * 1024 - 5 * 2 * 1024 * 1024) / (5 * 36000);
    expect(Math.round(allowed)).toBe(291);
    expect(per).toBeLessThan(allowed);
    expect(per).toBeGreaterThan(20);
    globalThis.__metronomeBytesPerDetail = per;
  });

  it('an existing version 1 database is upgraded with its sizes counted (no data loss)', async () => {
    const factory = new IDBFactory();
    await new Promise((resolve) => {
      const r = factory.open(SL.DB_NAME, 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        db.createObjectStore('ownerState', { keyPath: 'ownerId' });
        const s = db.createObjectStore('sessions', { keyPath: ['ownerId', 'sessionId'] });
        s.createIndex('owner_start', ['ownerId', 'startedAt']);
        db.createObjectStore('dictionaries', { keyPath: ['ownerId', 'sessionId', 'kind', 'index'] });
        db.createObjectStore('timingEvents', { keyPath: ['ownerId', 'sessionId', 'ordinal'] });
        db.createObjectStore('syncOutbox', { keyPath: ['ownerId', 'operationId'] });
        db.createObjectStore('tombstones', { keyPath: ['ownerId', 'entityType', 'entityId'] });
      };
      r.onsuccess = () => {
        const tx = r.result.transaction(['ownerState', 'sessions'], 'readwrite');
        tx.objectStore('ownerState').put({ ownerId: 'owner-a', localDeleteGeneration: 1, serverHistoryEpoch: 1, consentRevision: 1 });
        tx.objectStore('sessions').put({ ownerId: 'owner-a', sessionId: 'old', startedAt: 'x', status: 'complete' });
        tx.oncomplete = () => { r.result.close(); resolve(); };
      };
    });
    const local = SL.createLocalHistory({ indexedDB: factory, IDBKeyRange });
    expect(await local.list('owner-a')).toHaveLength(1);
    expect((await local.usage('owner-a')).totalBytes).toBeGreaterThan(0);
  });

  it('the export contains this owner\'s history only, without internal fields', async () => {
    const local = SL.createLocalHistory({ indexedDB: new IDBFactory(), IDBKeyRange });
    const a = await local.beginAttempt(identity);
    const b = await local.beginAttempt({ ...identity, ownerId: 'owner-b' });
    await local.saveSession(a, session('sa'));
    await local.saveSession(b, session('sb'));
    const out = await local.exportOwner('owner-a');
    expect(out.sessions.map((x) => x.session.sessionId)).toEqual(['sa']);
    expect(JSON.stringify(out)).not.toMatch(/__bytes|owner-b|ownerId/);
  });
});

describe('R-09 the 30-minute record closes once; the program continues; a new record needs a tap', () => {
  function fakeApi() {
    const listeners = [];
    let state = 'stopped';
    let draft = { bpmTenths: 1200 };
    const api = {
      on: (fn) => { listeners.push(fn); return () => {}; },
      emit: (type, payload) => listeners.forEach((fn) => fn(type, payload)),
      state: () => state,
      setState: (s) => { state = s; },
      play: () => { state = 'running'; },
      stop: () => { state = 'stopped'; api.emit('stopped', {}); },
      setDraft: (n) => { draft = { ...draft, ...n }; return Promise.resolve({ ok: true }); },
      getDraft: () => ({ ...draft }),
      setPractice: () => {},
      setConcealTempo: () => {},
      sampleRate: () => 1000,
      transport: () => ({ getSnapshot: () => ({ loop: true }) }),
      showMessage: () => {},
      announce: () => {},
    };
    return api;
  }

  it('closes the record at 1800 s of playing time even when display ticks were sparse', () => {
    const api = fakeApi();
    const results = [];
    const runner = TR.createProgramRunner({ api, uuid, utcNow: () => 't', setTimeout: () => 0, clearTimeout: () => {}, resolvePreset: () => ({}), onResult: (r) => results.push(r) });
    runner.start({ steps: [{ id: uuid(), presetId: TR.CURRENT_PRESET_ID, presetRevision: 1, end: { kind: 'activeSeconds', value: 3600 }, exercise: 'play' }] });
    const tick = (occ, frame) => api.emit('tick', { position: { occurrence: occ, score: { n: occ, d: 1 } }, frame });
    tick(0, 0);
    tick(10, 1000 * 900); // a 15-minute gap without display (background-free, audio running)
    tick(20, 1000 * 1800);
    expect(results).toHaveLength(1);
    expect(results[0].endReason).toBe('record-limit');
    expect(results[0].steps[0].activeSeconds).toBe(1800);
    expect(api.state()).toBe('running'); // the click goes on
    expect(runner.view().recording).toBe(false);
    // The rest of the program is not recorded until the user starts a new record.
    tick(30, 1000 * 2400);
    expect(results).toHaveLength(1);
    const again = runner.startNewRecord();
    expect(again.attemptId).not.toBe(results[0].attemptId);
    tick(40, 1000 * 3000);
    tick(50, 1000 * 3700);
    expect(results).toHaveLength(2); // program end closes the second record
    expect(results[1].steps[0].activeSeconds).toBeCloseTo(1300, 0); // from the new record (2400 s) to the step end (3700 s)
  });
});
