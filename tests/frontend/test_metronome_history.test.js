import path from 'node:path';
import { createRequire } from 'node:module';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';

// MT-11 / MT-13 / MT-14 (client side): fixed attempt tokens, deletion vs.
// delayed saves, tombstones, epoch / consent changes, summary-only uploads
// and the history-off default. fake-indexeddb only: the real two-tab browser
// check of H-010 is still open and is not claimed here.
const require = createRequire(import.meta.url);
const dir = path.join(process.cwd(), 'src/static/js/modules/metronome');
const SL = require(path.join(dir, 'storage_local.js'));
const SR = require(path.join(dir, 'storage_remote.js'));
const WS = require(path.join(dir, 'workspace.js'));

let seq = 0;
const uuid = () => {
  seq += 1;
  return `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
};

function history() {
  return SL.createLocalHistory({ indexedDB: new IDBFactory(), IDBKeyRange });
}

const identity = { ownerId: 'owner-a', serverHistoryEpoch: 1, consentRevision: 1, ownerBirthToken: 'birth-1' };

function session(id, extra = {}) {
  return { sessionId: id, attemptId: uuid(), kind: 'practice', status: 'complete', startedAt: `2026-10-18T00:00:0${seq % 10}Z`, activeDurationMs: 1000, durationMs: 1000, counts: { target: 0, valid: 0, localDetail: 0, extraDetail: 0, extraTotal: 0, groups: 0 }, summary: { steps: [] }, contentHash: 'h', ...extra };
}

describe('device history (portalMetronomeHistory)', () => {
  it('fixes the token before collecting and refuses a delayed save after a full deletion', async () => {
    const local = history();
    const tokenA = await local.beginAttempt(identity);
    expect(tokenA.localDeleteGeneration).toBe(1);
    // Saved before the deletion: the deletion removes it.
    expect((await local.saveSession(tokenA, session('s1'))).ok).toBe(true);
    const del = await local.deleteAll('owner-a');
    expect(del.localDeleteGeneration).toBe(2);
    expect(await local.list('owner-a')).toHaveLength(0);
    // A result of the old attempt arriving later is refused, never relabelled.
    const late = await local.saveSession(tokenA, session('s2'));
    expect(late).toEqual({ ok: false, code: 'STALE_LOCAL_GENERATION' });
    expect(await local.list('owner-a')).toHaveLength(0);
    // A new attempt gets the new generation.
    const tokenB = await local.beginAttempt(identity);
    expect(tokenB.localDeleteGeneration).toBe(2);
    expect((await local.saveSession(tokenB, session('s3'))).ok).toBe(true);
  });

  it('keeps a deleted session deleted (tombstone) and removes its details and uploads', async () => {
    const local = history();
    const token = await local.beginAttempt(identity);
    await local.saveSession(token, session('s1', { status: 'recording' }), { enqueue: true, operationId: 'op1' });
    expect((await local.appendDetails(token, 's1', [{ e: 1 }, { e: 2 }], 0)).ok).toBe(true);
    await local.deleteSession('owner-a', 's1', 'now');
    expect(await local.getSession('owner-a', 's1')).toBeNull();
    expect(await local.outbox('owner-a')).toHaveLength(0);
    expect(await local.saveSession(token, session('s1'))).toEqual({ ok: false, code: 'DELETED' });
  });

  it('writes details only in batches of <= 256 into an open recording', async () => {
    const local = history();
    const token = await local.beginAttempt(identity);
    await local.saveSession(token, session('s1', { status: 'recording' }));
    const rows = Array.from({ length: 257 }, (_, i) => ({ e: i }));
    expect((await local.appendDetails(token, 's1', rows, 0)).code).toBe('batch-too-large');
    expect((await local.appendDetails(token, 's1', rows.slice(0, 256), 0)).ok).toBe(true);
    expect((await local.appendDetails(token, 's1', rows.slice(256), 256)).ok).toBe(true);
    expect((await local.appendDetails(token, 's1', [{ e: 1 }], 36000)).code).toBe('too-many-details');
    await local.saveSession(token, session('s1', { status: 'complete' }));
    expect((await local.appendDetails(token, 's1', [{ e: 1 }], 257)).code).toBe('SESSION_CLOSED');
    const got = await local.getSession('owner-a', 's1');
    expect(got.details).toHaveLength(257);
    expect(got.details[256].ordinal).toBe(256);
  });

  it('drops queued uploads of an old server epoch or consent revision (DC-16)', async () => {
    const local = history();
    const token = await local.beginAttempt(identity);
    await local.saveSession(token, session('s1'), { enqueue: true, operationId: 'op1', now: 'a' });
    expect(await local.outbox('owner-a')).toHaveLength(1);
    const r = await local.setServerState('owner-a', 2, 1);
    expect(r.dropped).toBe(1);
    expect(await local.outbox('owner-a')).toHaveLength(0);
    // And the old token cannot write any more.
    expect((await local.saveSession(token, session('s2'))).code).toBe('STALE_LOCAL_GENERATION');
  });

  it('refuses another member generation for the same owner id and limits session size', async () => {
    const local = history();
    await local.beginAttempt(identity);
    await expect(local.beginAttempt({ ...identity, ownerBirthToken: 'birth-2' })).rejects.toMatchObject({ code: 'OWNER_MISMATCH' });
    const token = await local.beginAttempt(identity);
    expect((await local.saveSession(token, session('big', { activeDurationMs: 1800001 }))).code).toBe('too-long');
    expect((await local.saveSession(token, session('big2', { counts: { target: 28801 } }))).code).toBe('too-many-details');
  });

  it('does not touch other owners', async () => {
    const local = history();
    const a = await local.beginAttempt(identity);
    const b = await local.beginAttempt({ ...identity, ownerId: 'owner-b' });
    await local.saveSession(a, session('sa'));
    await local.saveSession(b, session('sb'));
    await local.deleteAll('owner-a');
    expect(await local.list('owner-a')).toHaveLength(0);
    expect((await local.list('owner-b')).map((x) => x.sessionId)).toEqual(['sb']);
  });
});

describe('account upload (summaries only)', () => {
  it('drops unknown fields such as raw onsets or calibration values', () => {
    const s = SR.sanitizeSession({ sessionId: 'x', counts: { target: 1, raw: [1] }, calibration: { offsetMs: 80 }, rawOnsets: [1, 2] });
    expect(s).not.toHaveProperty('calibration');
    expect(s).not.toHaveProperty('rawOnsets');
    expect(s.counts).not.toHaveProperty('raw');
    const g = SR.sanitizeGroup({ ordinal: 0, stats: { medianMs: 3, samples: [1, 2] }, quality: { calibrated: true, offsetMs: 80 }, e: [1, 2] });
    expect(g).not.toHaveProperty('e');
    expect(g.stats).not.toHaveProperty('samples');
    expect(g.quality).not.toHaveProperty('offsetMs');
  });

  it('holds back uploads above the limits instead of truncating them', () => {
    const groups = Array.from({ length: 257 }, (_, i) => ({ ordinal: i }));
    expect(SR.prepareUpload({ sessionId: 'x' }, groups, {}).code).toBe('too-many-groups');
    expect(SR.prepareUpload({ sessionId: 'x', scoreSummary: { big: 'x'.repeat(70000) } }, [], {}).code).toBe('score-summary-too-large');
    const ok = SR.prepareUpload({ sessionId: 'x' }, [{ ordinal: 0 }], { medianMs: 1 });
    expect(ok.ok).toBe(true);
    expect(ok.part.index).toBe(0);
  });

  it('sends create -> part 0 -> finalize and drops operations of another epoch', async () => {
    const local = history();
    const token = await local.beginAttempt(identity);
    await local.saveSession(token, session('s1'), { enqueue: true, operationId: 'op1', now: '1' });
    const calls = [];
    const remote = {
      createSession: (ctx, s) => { calls.push(['create', s.sessionId, ctx.historyEpoch]); return Promise.resolve({ ok: true }); },
      putPart: (ctx, id, part) => { calls.push(['part', id, part.index]); return Promise.resolve({ ok: true }); },
      finalize: (ctx, id, part, summary, status, n) => { calls.push(['finalize', id, status, n]); return Promise.resolve({ ok: true }); },
    };
    const ctx = { ownerId: 'owner-a', historyEpoch: 1, consentRevision: 1 };
    const report = await SR.syncOutbox({ local, remote, ctx, isCurrent: () => true, buildUpload: (row) => SR.prepareUpload(row, row.groups || [], row.summary) });
    expect(report.sent).toBe(1);
    expect(calls).toEqual([['create', 's1', 1], ['part', 's1', 0], ['finalize', 's1', 'complete', 0]]);
    expect(await local.outbox('owner-a')).toHaveLength(0);
    // An operation queued for epoch 1 is not sent with epoch 2.
    await local.saveSession(token, session('s2'), { enqueue: true, operationId: 'op2', now: '2' });
    const r2 = await SR.syncOutbox({ local, remote, ctx: { ...ctx, historyEpoch: 2 }, isCurrent: () => true, buildUpload: (row) => SR.prepareUpload(row, [], row.summary) });
    expect(r2.dropped).toBe(1);
    expect(calls.filter((c) => c[1] === 's2')).toHaveLength(0);
  });

  it('aborts requests and discards their results after the owner changed', async () => {
    let resolveFetch;
    const client = SR.createRemoteClient({
      request: () => new Promise((r) => { resolveFetch = r; }),
      deviceId: () => 'dev',
      setTimeout: () => 0,
      clearTimeout: () => {},
    });
    const pending = client.identity();
    await Promise.resolve();
    client.invalidate();
    resolveFetch({ ok: true, status: 200, text: () => Promise.resolve('{"ownerId":"x"}') });
    expect((await pending).code).toBe('stale-owner');
  });
});

describe('workspace (policy, attempts, owner)', () => {
  function workspaceEnv(opened) {
    const factory = new IDBFactory();
    const spy = { open: (...a) => { opened.push(a[0]); return factory.open(...a); } };
    const local = SL.createLocalHistory({ indexedDB: spy, IDBKeyRange });
    const remote = {
      identity: () => Promise.resolve({ ok: true, data: { accountStorageAvailable: true, ownerId: 'owner-a', historyEpoch: 1, consentRevision: 1, accountConsent: false } }),
      invalidate: () => {},
    };
    return WS.createWorkspace({ local, remote, remoteLib: SR, uuid, utcNow: () => '2026-10-18T00:00:00Z', deviceId: () => 'dev' });
  }

  const practiceResult = (attemptId, status = 'complete') => ({ kind: 'practice', attemptId, programRunId: uuid(), startedAt: '2026-10-18T00:00:00Z', endedAt: 'x', status, endReason: 'program-end', program: { steps: [{ exercise: 'play' }], repeat: 1 }, steps: [{ index: 0, iteration: 0, endReason: 'bars', bars: 4, activeSeconds: 8, startBpmTenths: 1200, endBpmTenths: 1200, tempoChanges: 0 }] });

  it('history off: results stay in memory and no history database is opened', async () => {
    const opened = [];
    const ws = workspaceEnv(opened);
    ws.beginAttempt('a1');
    const r = await ws.recordResult(practiceResult('a1'));
    expect(r.stored).toBe(false);
    expect(ws.memory()).toHaveLength(1);
    expect(opened).toEqual([]);
  });

  it("an older attempt's result is still saved after a newer attempt started (DC-19)", async () => {
    const opened = [];
    const ws = workspaceEnv(opened);
    await ws.setPolicy({ historyMode: 'auto', destination: 'local' });
    ws.beginAttempt('A');
    ws.beginAttempt('B');
    expect((await ws.recordResult(practiceResult('A'))).ok).toBe(true);
    expect((await ws.recordResult(practiceResult('B', 'incomplete'))).ok).toBe(true);
    const list = await ws.listHistory();
    expect(list.items.map((x) => x.attemptId).sort()).toEqual(['A', 'B']);
    expect(opened).toEqual(['portalMetronomeHistory']);
  });

  it('refuses results of attempts started before a deletion or a logout', async () => {
    const ws = workspaceEnv([]);
    await ws.setPolicy({ historyMode: 'auto', destination: 'local' });
    ws.beginAttempt('old');
    await ws.deleteAll('device');
    expect((await ws.recordResult(practiceResult('old'))).code).toBe('STALE_LOCAL_GENERATION');
    ws.beginAttempt('x');
    ws.invalidateOwner();
    await ws.setPolicy({ historyMode: 'auto', destination: 'local' });
    expect(await ws.recordResult(practiceResult('x'))).toMatchObject({ stored: false, reason: 'no-token' });
    expect((await ws.listHistory()).items).toHaveLength(0);
  });

  it('manual mode keeps results pending until the save button', async () => {
    const ws = workspaceEnv([]);
    await ws.setPolicy({ historyMode: 'manual', destination: 'local' });
    ws.beginAttempt('m1');
    expect((await ws.recordResult(practiceResult('m1'))).pending).toBe(true);
    expect(ws.pendingCount()).toBe(1);
    const saved = await ws.savePending();
    expect(saved[0].ok).toBe(true);
    expect((await ws.listHistory()).items).toHaveLength(1);
  });

  it('account destination without consent stays on the device (no upload queued)', async () => {
    const ws = workspaceEnv([]);
    await ws.setPolicy({ historyMode: 'auto', destination: 'account' });
    ws.beginAttempt('c1');
    const r = await ws.recordResult(practiceResult('c1'));
    expect(r.ok).toBe(true);
    expect(r.localOnly).toBe('no-consent');
  });

  it('builds a practice summary without presets or audio', () => {
    const rec = WS.practiceSession(practiceResult('p1'), 's1');
    expect(rec.counts.target).toBe(0);
    expect(rec.summary.steps[0].bars).toBe(4);
    expect(JSON.stringify(rec)).not.toMatch(/pcm|samples|offsetMs/i);
  });
});
