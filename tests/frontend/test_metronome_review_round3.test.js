import path from 'node:path';
import { createRequire } from 'node:module';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';

// Regression tests for the third review (P1 1-6, P2 7-10), logic level:
// fake clocks, fake-indexeddb and fake audio contexts. Real two-tab
// browsers, real double sound and real devices are not claimed here
// (MD-17 / MD-19, H-010).
const require = createRequire(import.meta.url);
const root = process.cwd();
const dir = path.join(root, 'src/static/js/modules/metronome');
const R = require(path.join(dir, 'rational.js'));
const SM = require(path.join(dir, 'score_model.js'));
const TM = require(path.join(dir, 'tempo_map.js'));
const EC = require(path.join(dir, 'event_compiler.js'));
const TP = require(path.join(dir, 'transport.js'));
const TA = require(path.join(dir, 'timing_analysis.js'));
const SL = require(path.join(dir, 'storage_local.js'));
const WS = require(path.join(dir, 'workspace.js'));
require(path.join(dir, 'sounds.js'));
require(path.join(dir, 'playback.js'));
const AD = require(path.join(dir, 'tuner_adapter.js'));
const OM = require(path.join(root, 'src/static/js/modules/audio/output_manager.js'));

const BASIC = '00000000-0000-4000-8000-00000000b001';
const settle = async (n = 20) => { for (let i = 0; i < n; i += 1) await Promise.resolve(); };
const macro = async (n = 15) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0)); };

function snap(bpmTenths = 1200, extras = []) {
  const p = SM.defaultBasicPreset(BASIC);
  p.payload.tempo.bpmTenths = bpmTenths;
  const store = { [p.id]: { 1: SM.validatePreset(p).preset } };
  let top = p;
  for (const e of extras) {
    const v = SM.validatePreset(e);
    if (!v.ok) throw new Error(JSON.stringify(v.errors));
    store[e.id] = { 1: v.preset };
    top = e;
  }
  return SM.buildSnapshot(store, top.id, 1);
}

const timerEnv = { setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {} };

describe('1 (P1, R-03): an edit waiting in the chain belongs to its run', () => {
  it('stop and a new start while edit A waits for its ack: the queued edit B never reaches the new run', async () => {
    let frame = 0;
    const replies = [];
    const backend = {
      kind: 'worklet',
      currentFrame: () => frame,
      setGeneration() {},
      schedule: () => 0,
      renewPermit() {},
      stop: () => Promise.resolve({}),
      cancelFrom: () => Promise.resolve({}),
      replaceFrom: (f, events, g) => new Promise((resolve) => replies.push({ frame: f, g, resolve })),
    };
    const tp = TP.createTransport({ backend, sampleRate: 48000, setTimeout: () => 1, clearTimeout() {} });
    tp.load(snap(), 1);
    tp.start({ countInBars: 0 });
    frame = 28800;
    const editA = tp.edit(snap(900), 2, 'nextPulse');
    const editB = tp.edit(snap(600), 3, 'nextPulse');
    await settle();
    expect(replies).toHaveLength(1);
    tp.stop();
    tp.start({ countInBars: 0 });
    const newGeneration = tp.getGeneration();
    replies[0].resolve({ accepted: true, appliedFrame: replies[0].frame });
    const [a, b] = await Promise.all([editA, editB]);
    expect(a.stale).toBe(true);
    expect(b).toEqual({ stale: true, superseded: true });
    expect(replies).toHaveLength(1); // B never asked the backend
    expect(tp.getGeneration()).toBe(newGeneration);
    expect(tp.getRevision()).toBe(1);
    expect(tp.positionAt(frame + 48000).tempo.bpm).toBeCloseTo(120, 9);
  });

  it('an edit made while stopped still applies to the next start', async () => {
    const backend = { kind: 'main', currentFrame: () => 0, setGeneration() {}, schedule: () => 0, renewPermit() {}, stop: () => Promise.resolve({}), cancelFrom: () => Promise.resolve({}), replaceFrom: () => Promise.resolve({ accepted: true }) };
    const tp = TP.createTransport({ backend, sampleRate: 48000, setTimeout: () => 1, clearTimeout() {} });
    tp.load(snap(), 1);
    expect(await tp.edit(snap(900), 2, 'nextPulse')).toMatchObject({ applied: 'stopped', accepted: true });
    expect(tp.getSnapshot().tempo.bpmTenths).toBe(900);
  });
});

describe('2 (P1, R-05): account sending is checked separately and again before the outbox write', () => {
  function consentWorkspace() {
    let finishDetails;
    let finishPreference;
    let consent = true;
    const finalWrites = [];
    const removed = [];
    let syncStarts = 0;
    const ws = WS.createWorkspace({
      uuid: () => 'uuid',
      utcNow: () => '2026-10-18T00:00:00Z',
      local: {
        setServerState: () => Promise.resolve(),
        beginAttempt: () => Promise.resolve({ ownerId: 'o' }),
        saveSession: (t, r, o) => { finalWrites.push({ status: r.status, enqueue: Boolean(o.enqueue) }); return Promise.resolve({ ok: true }); },
        appendDetails: () => new Promise((r) => { finishDetails = () => r({ ok: true }); }),
        removeOperation: (owner, op) => { removed.push(op); return Promise.resolve(); },
      },
      remote: {
        identity: () => Promise.resolve({ ok: true, data: { accountStorageAvailable: true, ownerId: 'o', historyEpoch: 1, consentRevision: consent ? 1 : 2, accountConsent: consent } }),
        getPreferences: () => new Promise((r) => { finishPreference = () => r({ ok: true, data: { revision: 1 } }); }),
        putPreferences: () => { consent = false; return Promise.resolve({ ok: true }); },
      },
      remoteLib: { syncOutbox: () => { syncStarts += 1; return Promise.resolve({}); } },
    });
    return { ws, finalWrites, removed, syncs: () => syncStarts, finishDetails: () => finishDetails(), finishPreference: () => finishPreference() };
  }

  it('consent withdrawn while the detail rows are written: no outbox entry, no sync while the withdrawal is pending', async () => {
    const h = consentWorkspace();
    await h.ws.setPolicy({ historyMode: 'auto', destination: 'account' });
    await h.ws.beginAttempt('a');
    const writing = h.ws.recordResult({ kind: 'analysis', attemptId: 'a', record: { sessionId: 's', attemptId: 'a', status: 'complete', durationMs: 1000, details: [{ e: 1 }] } });
    await settle();
    const withdrawal = h.ws.setAccountConsent(false);
    await settle();
    h.finishDetails();
    const r = await writing;
    await settle();
    expect(h.finalWrites).toEqual([{ status: 'recording', enqueue: false }, { status: 'complete', enqueue: false }]);
    expect(h.syncs()).toBe(0);
    expect(r).toMatchObject({ ok: true, localOnly: 'no-consent' });
    h.finishPreference();
    await withdrawal;
    expect(h.syncs()).toBe(0);
  });

  it('consent changed while the final row (with its outbox entry) was being written: the entry is removed, no sync', async () => {
    let finishFinal;
    let syncStarts = 0;
    const removed = [];
    const ws = WS.createWorkspace({
      uuid: () => 'op-1',
      utcNow: () => '2026-10-18T00:00:00Z',
      local: {
        setServerState: () => Promise.resolve(),
        beginAttempt: () => Promise.resolve({ ownerId: 'o' }),
        saveSession: () => new Promise((r) => { finishFinal = () => r({ ok: true }); }),
        removeOperation: (owner, op) => { removed.push(op); return Promise.resolve(); },
      },
      remote: {
        identity: () => Promise.resolve({ ok: true, data: { accountStorageAvailable: true, ownerId: 'o', historyEpoch: 1, consentRevision: 1, accountConsent: true } }),
        getPreferences: () => new Promise(() => {}),
        putPreferences: () => Promise.resolve({ ok: true }),
      },
      remoteLib: { syncOutbox: () => { syncStarts += 1; return Promise.resolve({}); } },
    });
    await ws.setPolicy({ historyMode: 'auto', destination: 'account' });
    await ws.beginAttempt('a');
    const writing = ws.recordResult({ kind: 'analysis', attemptId: 'a', record: { sessionId: 's', attemptId: 'a', status: 'complete', durationMs: 1000 } });
    await settle();
    ws.setAccountConsent(false); // pending (preferences never answer)
    finishFinal();
    const r = await writing;
    expect(removed).toEqual(['op-1']);
    expect(syncStarts).toBe(0);
    expect(r).toMatchObject({ ok: true, localOnly: 'consent-changed' });
  });
});

describe('3 (P1, R-05 / IC-14 rev.): the deletion order comes from IndexedDB, not from the clock', () => {
  const id = { ownerId: 'owner', serverHistoryEpoch: 1, consentRevision: 1 };

  async function openHistory(clock) {
    const local = SL.createLocalHistory({ indexedDB: new IDBFactory(), IDBKeyRange, now: () => clock.t });
    await local.beginAttempt(id); // opens the database
    return local;
  }

  it('attempt started in the same millisecond as a later deletion: its late token is refused', async () => {
    const clock = { t: 1000 };
    const local = await openHistory(clock);
    const ticket = local.ticket(); // the attempt starts
    await local.deleteAll('owner'); // same millisecond, after the start
    await expect(local.beginAttempt(id, await ticket)).rejects.toMatchObject({ code: 'STALE_LOCAL_GENERATION' });
    // A start time instead of a ticket is refused (it cannot be ordered).
    await expect(local.beginAttempt(id, clock.t)).rejects.toMatchObject({ code: 'INVALID_TICKET' });
    local.close();
  });

  it('clock set back after a deletion: a new attempt is still accepted', async () => {
    const clock = { t: 5000 };
    const local = await openHistory(clock);
    await local.deleteAll('owner');
    clock.t = 900;
    const ticket = await local.ticket();
    expect(ticket.ordered).toBe(true);
    const token = await local.beginAttempt(id, ticket);
    expect(token.localDeleteGeneration).toBe(2);
    local.close();
  });

  it('a ticket taken before the database was open is marked unordered (practice does not trust it)', async () => {
    const local = SL.createLocalHistory({ indexedDB: new IDBFactory(), IDBKeyRange, now: () => 0 });
    expect((await local.ticket()).ordered).toBe(false);
    expect((await local.ticket()).ordered).toBe(true);
    local.close();
  });
});

describe('4 (P1, R-02): the stop ack is written only after the old output really stopped', () => {
  async function takeoverPair(onLostOld) {
    let wall = 0;
    const factory = new IDBFactory();
    const old = OM.createIdbClaim({ indexedDB: factory, tabId: 'old', now: () => wall, ...timerEnv, onLost: onLostOld });
    const next = OM.createIdbClaim({ indexedDB: factory, tabId: 'next', now: () => wall, ...timerEnv });
    await old.acquire();
    wall = 16001;
    const observed = await next.acquire();
    next.takeover(observed.observed);
    await macro();
    return { old, next };
  }

  it('stop never completes: no ack, the new tab is not allowed to sound', async () => {
    const { old, next } = await takeoverPair(() => new Promise(() => {}));
    await old.verify();
    await macro();
    await next.verify();
    expect(next.isHeld()).toBe(false);
    expect(next.isPending()).toBe(true);
    old.release();
    next.release();
  });

  it('stop completes: the ack follows and the new tab becomes the owner', async () => {
    let finish;
    const { old, next } = await takeoverPair(() => new Promise((r) => { finish = r; }));
    await old.verify();
    await macro();
    await next.verify();
    expect(next.isHeld()).toBe(false);
    finish();
    await macro();
    await next.verify();
    expect(next.isHeld()).toBe(true);
    old.release();
    next.release();
  });

  it('the manager mutes the master and resolves the loss only when the context suspension is confirmed', async () => {
    let finishSuspend;
    class Ctx {
      constructor() { this.state = 'running'; this.currentTime = 0; this.sampleRate = 48000; this.destination = {}; }
      resume() { this.state = 'running'; return Promise.resolve(); }
      suspend() { return new Promise((r) => { finishSuspend = () => { this.state = 'suspended'; if (this.onstatechange) this.onstatechange(); r(); }; }); }
      close() { this.state = 'closed'; return Promise.resolve(); }
      createGain() { return { gain: { value: 1, cancelScheduledValues() {}, setTargetAtTime(v) { this.value = v; } }, connect() {}, disconnect() {} }; }
    }
    let wall = 0;
    const factory = new IDBFactory();
    const interrupted = [];
    const m = OM.createOutputManager({ AudioContext: Ctx, indexedDB: factory, tabId: 'old', now: () => wall, ...timerEnv });
    m.on('interrupted', (s) => interrupted.push(s));
    await m.prepareClaim();
    m.unlockFromGesture();
    const revoked = [];
    m.acquire('metronome', 1, { onRevoke: (why) => { revoked.push(why); } });
    await macro(); // the permit renewal (a heartbeat) commits before the old tab hangs
    const next = OM.createIdbClaim({ indexedDB: factory, tabId: 'next', now: () => wall, ...timerEnv });
    wall = 16001;
    const observed = await next.acquire();
    next.takeover(observed.observed);
    await macro();
    await m.verifyClaim();
    await macro();
    expect(revoked).toEqual(['claim-lost']);
    expect(m.context().state).toBe('running'); // suspension not confirmed yet
    await next.verify();
    expect(next.isHeld()).toBe(false);
    finishSuspend();
    await macro();
    await next.verify();
    expect(next.isHeld()).toBe(true);
    expect(interrupted).toEqual([]); // the loss is reported once, as "lost"
    // A new tap restores the master level.
    m.unlockFromGesture();
    next.release();
  });
});

describe('5 (P1, R-04): long layer periods are checked over the whole period', () => {
  it('a 100-whole-note layer with 17 beats at 160 s is refused, whatever the display grid size', () => {
    const adv = {
      schemaVersion: 1,
      id: '00000000-0000-4000-8000-00000000a001',
      revision: 1,
      kind: 'advanced',
      title: 'long cycle',
      payload: {
        basePresetId: BASIC,
        baseRevision: 1,
        layers: [{ id: 'l1', cycle: { n: 100, d: 1 }, pulses: 64, phase: { n: 0, d: 1 }, soundId: 'wood', volume: 1, rhythm: Array.from({ length: 17 }, (_, i) => ({ offset: R.make(8000 + i, 100), duration: { n: 1, d: 100 }, rest: false, velocity: 1, accentLevel: 'pulse' })) }],
      },
    };
    const s = snap(1200, [adv]);
    expect(EC.polyGrid([{ cycle: s.barTemplate.length, pulses: s.barTemplate.pulseCount }, { cycle: s.layers[0].cycle, pulses: s.layers[0].pulses }]).perLayer).toBe(true);
    const actual = EC.compile({ snapshot: s, tempoMap: TM.fromSnapshot(s), origin: { score: R.ZERO, frame: 0 }, sampleRate: 48000, from: R.make(79, 1), to: R.make(81, 1) }).events.filter((e) => TA.isTargetEvent(e, ['l1']));
    expect(actual).toHaveLength(17);
    const rate = TA.targetRate(s, ['l1']);
    expect(rate.ok).toBe(false);
    expect(rate.code).toBe('ANALYSIS_TARGET_RATE_EXCEEDED');
    expect(rate.at).toBeGreaterThanOrEqual(160);
  });
});

describe('6 (P1, R-03/R-08): look-ahead beats are withdrawn when they will not sound', () => {
  it('withdrawFrom removes only open beats from the given time', () => {
    const al = TA.createAligner();
    [0, 500, 1000, 1500].forEach((t, i) => al.addTarget({ timeMs: t, eventId: 'e' + i, layerId: 'meter', beatKey: 'b0', conditionKey: 'c' }));
    al.addAttack({ timeMs: 2, quality: 'ok' });
    al.advance(300); // 0 is final (window 150 ms)
    expect(al.withdrawFrom(1000)).toBe(2);
    expect(al.withdrawFrom(-100)).toBe(1); // only the open beat at 500; the final one stays
    const r = al.finish();
    expect(r.rows.map((x) => x.target.eventId)).toEqual(['e0']);
    expect(al.targetCount()).toBe(1);
  });
});

describe('7 (P2, R-02): an IndexedDB acquire that commits after release does not hold the claim', () => {
  it('release right after acquire: not held, and another tab can take the output', async () => {
    const factory = new IDBFactory();
    const c = OM.createIdbClaim({ indexedDB: factory, tabId: 'a', now: () => 0, ...timerEnv });
    const acquiring = c.acquire();
    c.release();
    expect(await acquiring).toEqual({ ok: false, reason: 'released' });
    expect(c.isHeld()).toBe(false);
    await macro();
    const other = OM.createIdbClaim({ indexedDB: factory, tabId: 'b', now: () => 0, ...timerEnv });
    expect((await other.acquire()).ok).toBe(true);
    other.release();
  });
});

describe('8 (P2, A): tuner side by side: click reports and explicit concurrency', () => {
  it('the display adapter reports every metronome click that sounded to the tuner as external output', () => {
    let listener = null;
    const timeline = [{ frame: 1000, emit: true }, { frame: 2000, emit: false }, { frame: 3000, emit: true }, { frame: 9000, emit: true }];
    const api = {
      on: (fn) => { listener = fn; return () => { listener = null; }; },
      transport: () => ({ eventsBetween: (a, b) => timeline.filter((e) => e.frame >= a && e.frame < b) }),
      state: () => 'running',
      sampleRate: () => 48000,
    };
    const reports = [];
    const d = AD.createTunerDisplay({ api, host: { replaceChildren() {} }, tunerBody: () => ({ reportOutput: (e) => reports.push(e) }) });
    expect(d.reportClicks(500)).toBe(0); // first tick: start point
    expect(d.reportClicks(3500)).toBe(2);
    expect(d.reportClicks(3600)).toBe(0); // never twice
    expect(reports.every((e) => e.type === 'click' && e.external === true)).toBe(true);
    expect(reports.map((e) => e.contextTime)).toEqual([1000 / 48000, 3000 / 48000]);
    expect(listener).toBeNull(); // listening starts only with the tuner
  });

  it('the shared output mixes only after the explicit choice; turning it off leaves one consumer', () => {
    class Ctx {
      constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
      resume() { return Promise.resolve(); }
      close() { return Promise.resolve(); }
      createGain() { return { gain: { value: 1, setTargetAtTime(v) { this.value = v; } }, connect() {}, disconnect() {} }; }
    }
    const m = OM.createOutputManager({ AudioContext: Ctx, now: () => 0, ...timerEnv });
    m.unlockFromGesture();
    const revoked = [];
    expect(m.acquire('metronome', 1, { concurrent: true, onRevoke: (w) => revoked.push(['metronome', w]) }).ok).toBe(true);
    expect(m.acquire('tuner', 1, { concurrent: true }).code).toBe('OUTPUT_BUSY');
    m.setConcurrentAllowed(true);
    expect(m.acquire('tuner', 1, { concurrent: true, onRevoke: (w) => revoked.push(['tuner', w]) }).ok).toBe(true);
    expect(m.consumers().sort()).toEqual(['metronome', 'tuner']);
    m.setConcurrentAllowed(false);
    expect(m.consumers()).toEqual(['metronome']);
    expect(revoked).toEqual([['tuner', 'concurrency-off']]);
  });
});

describe('8 (P2, A): product wiring of the explicit simultaneous choice', () => {
  it('the tuner body passes its simultaneous choice to the shared output and resets it on leave', () => {
    const fs = require('node:fs');
    const src = fs.readFileSync(path.join(root, 'src/static/js/modules/tuner/index.js'), 'utf8');
    const setSim = src.slice(src.indexOf('setSimultaneous: function (enabled)'), src.indexOf('startVoicesFromTap'));
    expect(setSim).toContain('deps.setOutputConcurrency(Boolean(enabled))');
    const stop = src.slice(src.indexOf('function stop(reason)'), src.indexOf('function showError'));
    expect(stop).toContain('deps.setOutputConcurrency(false)');
    expect(src).toContain('setOutputConcurrency: output ? output.setConcurrent : null');
    const met = fs.readFileSync(path.join(dir, 'index.js'), 'utf8');
    expect(met.slice(met.indexOf("m.acquire('metronome'"), met.indexOf("m.acquire('metronome'") + 300)).toContain('concurrent: true');
  });
});

describe('9 (P2, R-06): deleting the same record again does not change the totals', () => {
  it('repeated deletion books the tombstone once', async () => {
    const local = SL.createLocalHistory({ indexedDB: new IDBFactory(), IDBKeyRange, now: () => 0 });
    const token = await local.beginAttempt({ ownerId: 'owner', serverHistoryEpoch: 1, consentRevision: 1 });
    await local.saveSession(token, { sessionId: 's', startedAt: '2026-10-18', status: 'complete', activeDurationMs: 1000, counts: {} }, {});
    await local.deleteSession('owner', 's', 1000);
    const first = await local.usage('owner');
    await local.deleteSession('owner', 's', 2000);
    await local.deleteSession('owner', 's', 3000);
    const again = await local.usage('owner');
    expect(again.totalBytes).toBe(first.totalBytes);
    expect(again.ownerBytes).toBe(first.ownerBytes);
    local.close();
  });
});

describe('10 (P2, R-01): the batch API keeps every correct attack', () => {
  it('includes an attack on the right window edge before finalizing that beat', () => {
    const targets = [1000, 1100].map((timeMs) => ({ timeMs, layerId: 'meter', beatKey: 'b0', conditionKey: 'c', bpm: 120 }));
    // The first matching window ends at 1000 + 0.45 * 100 = 1045 ms.
    const obs = [{ timeMs: 1045, quality: 'ok' }];
    expect(TA.align(targets, obs).matches.map((m) => m.obs)).toEqual(TA.alignExact(targets, obs).map((m) => m.obs));
    const result = TA.analyze(targets, obs, { valid: true });
    expect(result.counts.valid).toBe(1);
    expect(result.counts.extraTotal).toBe(0);
  });

  it('considers every same-time attack at the right window edge for ambiguity', () => {
    const targets = [1000, 1100].map((timeMs) => ({ timeMs, layerId: 'meter', beatKey: 'b0', conditionKey: 'c', bpm: 120 }));
    const obs = [{ timeMs: 1045, quality: 'ok' }, { timeMs: 1045, quality: 'ok' }];
    const aligned = TA.align(targets, obs);
    expect(aligned.matches[0].obs).not.toBeNull();
    expect(aligned.matches[0].ambiguous).toBe(true);
    expect(aligned.extraTotal).toBe(1);
    const result = TA.analyze(targets, obs, { valid: true });
    expect(result.summary.excluded.ambiguous).toBe(1);
    expect(result.counts.extraTotal).toBe(1);
  });

  it('3000 beats, 3000 exact attacks: 3000 valid, no extras', () => {
    const targets = Array.from({ length: 3000 }, (_, i) => ({ timeMs: 1000 + i * 500, layerId: 'meter', beatKey: 'b0', conditionKey: 'c', bpm: 120 }));
    const obs = targets.map((x) => ({ timeMs: x.timeMs, quality: 'ok' }));
    const res = TA.analyze(targets, obs, { valid: true });
    expect(res.counts.target).toBe(3000);
    expect(res.counts.valid).toBe(3000);
    expect(res.counts.extraTotal).toBe(0);
    const a = TA.align(targets, obs);
    expect(a.matches.filter((m) => m.obs !== null)).toHaveLength(3000);
    expect(a.extraTotal).toBe(0);
  });
});
