import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

// Regression tests for four review findings, in the reported order of
// operations: (1) auto history of a practice run, (2) a pending save across
// "delete all", (3) analysis against the conditions of each part's own time,
// (4) account sync after "delete all".
const require = createRequire(import.meta.url);
const { IDBFactory } = require('fake-indexeddb');
const pipeline = require('./helpers/tuner_pipeline.cjs');
const dir = path.join(process.cwd(), 'src/static/js/modules/tuner');
for (const name of ['music', 'temperament', 'target_model', 'onset', 'note_events', 'analysis_stats', 'measurement_store', 'session_coordinator', 'intonation_profile', 'storage_local', 'storage_remote', 'trainer', 'workspace', 'view_trainer', 'view_diagnosis', 'view_history']) {
  require(path.join(dir, `${name}.js`));
}
const L = globalThis.PortalTunerLib;
const S = L.storageLocal;
const wait = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const settle = async () => { for (let i = 0; i < 20; i += 1) await wait(0); };

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

// ----- a minimal DOM for the trainer view ------------------------------------
class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.listeners = {};
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.textContent = '';
    this.style = {};
    this.parentNode = null;
    const self = this;
    this.classList = { toggle() {}, add() {}, remove() {}, contains() { return false; }, owner: self };
  }
  get value() {
    if (this._value !== undefined) return this._value;
    if (this.tagName === 'SELECT') {
      const option = this.children.find((c) => c.tagName === 'OPTION');
      return option ? option.value : '';
    }
    return '';
  }
  set value(v) { this._value = String(v); }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  replaceChildren(...items) { this.children = []; items.forEach((c) => c && this.appendChild(c)); }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this); }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  focus() {}
  matches(selector) {
    const m = /^\[([a-z-]+)(?:="([^"]*)")?\]$/.exec(selector);
    if (!m) return false;
    if (!(m[1] in this.attributes)) return false;
    return m[2] === undefined || this.attributes[m[1]] === m[2];
  }
  closest(selector) { let el = this; while (el) { if (el.matches && el.matches(selector)) return el; el = el.parentNode; } return null; }
  find(selector) {
    if (this.matches(selector)) return this;
    for (const c of this.children) { const f = c.find && c.find(selector); if (f) return f; }
    return null;
  }
  click() {
    if (this.disabled) return;
    const event = { target: this, preventDefault() {}, stopPropagation() {} };
    let el = this;
    while (el) { (el.listeners.click || []).forEach((fn) => fn(event)); el = el.parentNode; }
  }
}
globalThis.document = globalThis.document || {
  createElement: (tag) => new FakeElement(tag),
  createTextNode: (text) => Object.assign(new FakeElement('#text'), { textContent: text }),
};

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, text: () => Promise.resolve(body === undefined ? '' : JSON.stringify(body)) };
}

function memoryStorage() {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
}

function workspaceHarness(options = {}) {
  const coordinator = L.sessionCoordinator.createSessionCoordinator();
  const state = { a4Tenths: 4420, target: { temperament: 'equal', rootMidi: 60 }, tolerance: 3 };
  let perf = 1000;
  const ws = L.workspace.createWorkspace({
    lib: L,
    release: 'test',
    body: {
      coordinator,
      setPlaybackState() {},
      getTargetConfig: () => JSON.parse(JSON.stringify(state.target)),
      getPrefs: () => ({ registerProfile: 'full', toleranceCents: state.tolerance, inputThreshold: { mode: 'manual', dbfs: -60 } }),
      getA4Tenths: () => state.a4Tenths,
      getA4: () => state.a4Tenths / 10,
      getInputThreshold: () => -60,
      getInstrument: () => null,
      getInstrumentRange: () => null,
      ensureMeasurementFromTap() {},
      setDisplayHidden() {},
      startVoicesFromTap: () => ({ started: true }),
      stopPlaybackFromTap() {},
    },
    storage: options.storage || memoryStorage(),
    idbFactory: options.idbFactory || new IDBFactory(),
    request: options.request || (() => Promise.resolve(response(403, { detail: { code: 'ACCOUNT_STORAGE_UNAVAILABLE' } }))),
    deviceId: () => 'dev',
    now: () => perf,
    utcNow: () => 1_800_000_000_000 + perf,
    setTimeout: options.setTimeout || ((fn, ms) => setTimeout(fn, Math.min(ms || 0, 5))),
    clearTimeout: (id) => clearTimeout(id),
    ensureGroup: () => Promise.resolve(),
    isDocumentHidden: () => false,
  });
  return { ws, coordinator, state, advance: (ms) => { perf += ms; } };
}

const frame = (f2, hz = 440) => ({ captureEpoch: 1, effectiveFrame2: f2, analysisEndFrameExclusive: Math.ceil(f2 / 2) + 2048, frequencyHz: hz, confidence: 0.9, rmsDbfs: -30, qualityFlags: 0, invalidReason: 0 });

// ----- 1. practice run and auto history ---------------------------------------
describe('practice runs with automatic history (finding 1)', () => {
  async function startRun() {
    // Practice timers: the countdown passes at once; the end of the exercise
    // never comes by itself, so the test decides when the run ends.
    let longTimers = 0;
    const h = workspaceHarness({
      setTimeout: (fn, ms) => {
        if (ms >= 1000) { longTimers += 1; return longTimers === 1 ? setTimeout(fn, 0) : 0; }
        return setTimeout(fn, Math.min(ms || 0, 5));
      },
    });
    const api = h.ws.api();
    api.setHistoryPrefs({ frequency: 'auto' });
    h.ws.onSession({ captureEpoch: 1, sampleRate: 48000 });
    let f2 = 100000;
    const feed = (n) => { for (let k = 0; k < n; k += 1) { h.advance(34); f2 += 3200; h.ws.onPitch(frame(f2)); } };
    feed(10);
    const panel = new FakeElement('section');
    const view = L.viewTrainer.createTrainerView(panel, api);
    panel.find('[data-tuner-practice-start]').click();
    await settle();
    feed(40);
    return { h, api, panel, view, feed };
  }

  async function sessionsOf(api) {
    const local = await api.local();
    const owner = await api.getOwner();
    return { local, owner, rows: await local.listSessions(owner) };
  }

  it('finishing a run closes its recording: one complete session, nothing recorded afterwards', async () => {
    const { api, panel, view, feed } = await startRun();
    expect(view.session.getState()).toBe('performing');
    expect(api.isRecording()).toBe(true);
    panel.find('[data-tuner-practice-finish]').click();
    expect(api.isRecording()).toBe(false); // stops collecting at once
    await settle();
    await wait(30);
    const { local, owner, rows } = await sessionsOf(api);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('complete');
    const before = (await local.getSession(owner, rows[0].sessionId)).chunks.reduce((s, c) => s + c.frame2.length, 0);
    feed(80); // microphone input after the end
    await settle();
    const after = (await local.getSession(owner, rows[0].sessionId)).chunks.reduce((s, c) => s + c.frame2.length, 0);
    expect(after).toBe(before);
    expect((await local.listSessions(owner))).toHaveLength(1);
  });

  it('cancelling a run closes its recording as one partial session', async () => {
    const { api, panel } = await startRun();
    panel.find('[data-tuner-practice-cancel]').click();
    expect(api.isRecording()).toBe(false);
    await settle();
    await wait(30);
    const { rows } = await sessionsOf(api);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('complete');
    expect(rows[0].summary.result).toEqual({ status: 'cancelled' });
  });

  it('a recording that another flow started is not taken over by the practice run', async () => {
    const h = workspaceHarness();
    const api = h.ws.api();
    api.setHistoryPrefs({ frequency: 'auto' });
    h.ws.onSession({ captureEpoch: 1, sampleRate: 48000 });
    const first = await api.startRecording('free');
    expect(first.existing).toBeUndefined();
    const again = await api.startRecording('longtone');
    expect(again).toMatchObject({ ok: true, sessionId: first.sessionId, existing: true });
  });
});

// ----- 2. a pending save across "delete all" ------------------------------------
describe('a save waiting for the quota check never lands after "delete all" (finding 2)', () => {
  it('same tab: the pending beginSession is refused and nothing comes back', async () => {
    const estimate = deferred();
    let hold = true;
    const store = S.createLocalStore({ idbFactory: new IDBFactory(), storageEstimate: () => (hold ? estimate.promise : Promise.resolve(null)) });
    await store.open();
    const ctx = store.setOwner({ ownerId: 'owner-a' });
    const pending = store.beginSession(ctx, { startedAt: 1 });
    await wait(5);
    hold = false;
    expect(await store.deleteAll(ctx)).toEqual({ ok: true });
    estimate.resolve(null);
    expect(await pending).toMatchObject({ ok: false, reason: 'deleted-all' });
    expect(await store.listSessions(ctx)).toEqual([]);
    // New saves after the deletion work normally.
    expect((await store.beginSession(ctx, { startedAt: 2 })).ok).toBe(true);
  });

  it('another tab: the generation stored by delete-all refuses the write inside its transaction', async () => {
    const idbFactory = new IDBFactory();
    const estimate = deferred();
    const tabA = S.createLocalStore({ idbFactory, storageEstimate: () => estimate.promise });
    const tabB = S.createLocalStore({ idbFactory });
    await tabA.open();
    await tabB.open();
    const a = tabA.setOwner({ ownerId: 'owner-a' });
    const b = tabB.setOwner({ ownerId: 'owner-a' });
    const pending = tabA.beginSession(a, { startedAt: 1 });
    await wait(5);
    expect(await tabB.deleteAll(b)).toEqual({ ok: true });
    estimate.resolve(null);
    expect(await pending).toMatchObject({ ok: false, reason: 'deleted-all' });
    expect(await tabB.listSessions(b)).toEqual([]);
  });

  it('pending chunks, events and instruments are refused as well', async () => {
    const estimate = deferred();
    let hold = false;
    const store = S.createLocalStore({ idbFactory: new IDBFactory(), storageEstimate: () => (hold ? estimate.promise : Promise.resolve(null)) });
    await store.open();
    const ctx = store.setOwner({ ownerId: 'owner-a' });
    const s = await store.beginSession(ctx, { startedAt: 1 });
    hold = true;
    const chunk = store.appendChunk(ctx, s.sessionId, 0, S.encodeChunk({ epochId: 1, sampleRate: 48000, baseFrame: 0 }, { frame2: [1, 3], hz: [440, 440], conf: [1, 1], rms: [-20, -20], reason: [0, 0], flags: [0, 0] }), null);
    const instrument = store.putInstrument(ctx, { name: 'Cl' });
    await wait(5);
    hold = false;
    await store.deleteAll(ctx);
    estimate.resolve(null);
    expect((await chunk).ok).toBe(false);
    expect(await instrument).toMatchObject({ ok: false, reason: 'deleted-all' });
    expect(await store.listInstruments(ctx, true)).toEqual([]);
  });
});

// ----- 3. analysis against the conditions of each part's own time ---------------
describe('each part is judged against the conditions of its own time (finding 3)', () => {
  function loadStatsWorker() {
    const posted = [];
    const timers = [];
    const read = (name) => fs.readFileSync(path.join(dir, name), 'utf8');
    const context = vm.createContext({
      Float32Array, Float64Array, Uint32Array, Uint8Array, Uint16Array, ArrayBuffer, Math, Number, Object, Array, Error, Promise, Infinity, NaN, JSON, String,
      location: { search: `?rev=${pipeline.RELEASE}` },
      postMessage: (m) => posted.push(m),
      close() {},
      setTimeout: (fn) => timers.push(fn),
    });
    context.self = context;
    context.importScripts = (...urls) => { for (const url of urls) vm.runInContext(read(url.split('?')[0]), context); };
    vm.runInContext(read('stats.worker.js'), context);
    return { send: (data) => context.self.onmessage({ data }), flush: () => { while (timers.length) timers.shift()(); }, posted };
  }

  // A4 = 440 Hz while 440 Hz is played; then A4 = 442 Hz while 442 Hz is played.
  function measure() {
    const sr = 48000;
    const a = pipeline.synth({ sampleRate: sr, seconds: 1.2, f0: () => 440, seed: 5 });
    const gap = new Float32Array(Math.round(0.4 * sr));
    const b = pipeline.synth({ sampleRate: sr, seconds: 1.2, f0: () => 442, seed: 6 });
    const samples = new Float32Array(a.length + gap.length + b.length);
    samples.set(a, 0);
    samples.set(b, a.length + gap.length);
    const posted = pipeline.runWorker(samples);
    const h = workspaceHarness();
    h.state.a4Tenths = 4400;
    h.ws.onSession({ captureEpoch: 7, sampleRate: sr });
    const changeAt = a.length + gap.length / 2;
    let changed = false;
    for (const m of posted) {
      const end = m.frame && m.frame.analysisEndFrameExclusive;
      if (!changed && m.type === 'pitch' && end > changeAt) {
        h.state.a4Tenths = 4420; // the user changes A4 during the silence
        h.ws.emit('a4-change', null);
        changed = true;
      }
      if (m.type === 'pitch') h.ws.onPitch(m.frame);
      else if (m.type === 'envelope') h.ws.onEnvelope(m.frames, 7);
    }
    h.ws.store.flush();
    const snapshot = h.ws.store.snapshot({ epoch: 7 });
    snapshot.series.sampleRate = sr;
    snapshot.series.expectedHop2 = (2 * sr) / 30;
    const request = {
      snapshot,
      segmentOptions: { thresholdDbfs: -50, a4Hz: 442 },
      // The current (latest) conditions, as the views send them.
      targetConfig: Object.assign({}, h.state.target, { a4Tenths: 4420 }),
      toleranceCents: 3,
    };
    return { h, request };
  }

  it('the stored conditions carry the A4 of each part', () => {
    const { request } = measure();
    expect(request.snapshot.conditions.map((c) => c.conditions.a4Tenths)).toEqual([4400, 4420]);
    expect(request.snapshot.boundaries.map((b) => b.type)).toEqual(['targetChange']);
  });

  it('worker and fallback both give about 0 cent for both notes (not −7.85 for the first)', async () => {
    const { request } = measure();
    const fallback = await L.workspace.createStatsClient({ release: 'x' }).request('segment', request);
    const w = loadStatsWorker();
    w.send(Object.assign({ type: 'analyze', kind: 'segment', requestId: 1 }, request));
    w.flush();
    const fromWorker = w.posted[0].result;
    for (const result of [fallback, fromWorker]) {
      expect(result.events).toHaveLength(2);
      const [first, second] = result.events;
      expect(first.target.a4Tenths).toBe(4400);
      expect(second.target.a4Tenths).toBe(4420);
      expect(Math.abs(first.stats.medianCents)).toBeLessThan(1);
      expect(Math.abs(second.stats.medianCents)).toBeLessThan(1);
    }
    expect(JSON.parse(JSON.stringify(fromWorker))).toEqual(JSON.parse(JSON.stringify(fallback)));
  });

  it('a tolerance change is recorded too and used for the later part only', async () => {
    const h = workspaceHarness();
    h.ws.onSession({ captureEpoch: 1, sampleRate: 48000 });
    h.ws.onPitch(frame(100000));
    h.state.tolerance = 10;
    h.ws.emit('prefs', null);
    h.ws.emit('prefs', null); // no change: no second boundary
    h.ws.store.flush();
    const conds = h.ws.store.snapshot({ epoch: 1 }).conditions;
    expect(conds.map((c) => c.conditions.toleranceCents)).toEqual([3, 10]);
  });

  it('saved events of the earlier part get their own condition key; the later part keeps the session key', async () => {
    const { h, request } = measure();
    const api = h.ws.api();
    api.setHistoryPrefs({ frequency: 'manual' });
    const result = await L.workspace.createStatsClient({ release: 'x' }).request('segment', request);
    const events = result.events.map((ev, i) => ({ ordinal: i, target: ev.target, stats: ev.stats }));
    const res = await api.saveSnapshot('free', request.snapshot, { events }, {});
    expect(res.ok).toBe(true);
    const local = await api.local();
    const owner = await api.getOwner();
    const saved = await local.getSession(owner, res.sessionId);
    const byOrdinal = saved.events.sort((x, y) => x.ordinal - y.ordinal);
    expect(byOrdinal[0].target.conditionKey).toBeTruthy();
    expect(byOrdinal[0].target.conditionKey).not.toBe(saved.session.conditionKey);
    expect(byOrdinal[1].target.conditionKey).toBeUndefined();
    // Diagnosis input keeps them apart.
    require(path.join(dir, 'view_diagnosis.js'));
    const profileEvents = L.viewDiagnosis.toProfileEvents ? L.viewDiagnosis.toProfileEvents([saved]) : null;
    if (profileEvents) expect(new Set(profileEvents.map((e) => e.conditionsKey)).size).toBe(2);
  });
});

// ----- 4. account sync after "delete all" ----------------------------------------
describe('saves after "delete all" are synced with the new history epoch (finding 4)', () => {
  function server() {
    const s = { epoch: 1, accepted: [], refused: 0 };
    s.request = (url, init) => {
      const body = init.body ? JSON.parse(init.body) : null;
      if (url.endsWith('/identity')) return Promise.resolve(response(200, { schemaVersion: 1, accountStorageAvailable: true, ownerId: 'owner-x', historyEpoch: s.epoch }));
      if (url.endsWith('/history') && init.method === 'DELETE') { s.epoch += 1; return Promise.resolve(response(200, { data: { historyEpoch: s.epoch } })); }
      if (body && body.historyEpoch !== undefined && body.historyEpoch !== s.epoch) { s.refused += 1; return Promise.resolve(response(409, { detail: { code: 'HISTORY_EPOCH' } })); }
      if (url.endsWith('/sessions') && init.method === 'POST') s.accepted.push(body.historyEpoch);
      return Promise.resolve(response(200, { ok: true }));
    };
    return s;
  }

  async function saveOne(api, ws) {
    ws.onPitch(frame(100000 + Math.floor(Math.random() * 1000) * 2));
    ws.store.flush();
    const res = await api.saveSnapshot('free', ws.store.snapshot(), { events: [] }, {});
    await settle();
    await api.syncNow();
    return res;
  }

  it('delete all, then save: the new session is sent with the new epoch and accepted', async () => {
    const srv = server();
    const h = workspaceHarness({ request: srv.request });
    const api = h.ws.api();
    api.setHistoryPrefs({ frequency: 'manual', destination: 'local+account' });
    h.ws.onSession({ captureEpoch: 1, sampleRate: 48000 });
    expect((await saveOne(api, h.ws)).queued).toBe(true);
    expect(srv.accepted).toEqual([1]);
    const del = await api.deleteAllHistory();
    expect(del).toMatchObject({ ok: true, remote: true });
    expect((await api.getOwner()).historyEpoch).toBe(2);
    await saveOne(api, h.ws);
    expect(srv.accepted).toEqual([1, 2]);
    expect(srv.refused).toBe(0);
  });

  it('a deletion from another device (epoch conflict) refreshes the owner so the next save is accepted', async () => {
    const srv = server();
    const h = workspaceHarness({ request: srv.request });
    const api = h.ws.api();
    api.setHistoryPrefs({ frequency: 'manual', destination: 'local+account' });
    h.ws.onSession({ captureEpoch: 1, sampleRate: 48000 });
    await saveOne(api, h.ws);
    srv.epoch = 5; // deleted elsewhere
    await saveOne(api, h.ws); // refused once (queued with the old epoch)
    expect(srv.refused).toBe(1);
    expect((await api.getOwner()).historyEpoch).toBe(5);
    await saveOne(api, h.ws);
    expect(srv.accepted).toEqual([1, 5]);
  });
});

// ----- 5. an older analysis never acts on the next practice run ------------------
describe('a late analysis of the previous run never touches the next run (finding 5)', () => {
  it('run 1 is finalized with its own session; run 2 keeps recording and performing', async () => {
    // Each run: the countdown (first long timer after a start tap) passes at
    // once; the end of the exercise never comes by itself.
    let allowCountdown = false;
    const h = workspaceHarness({
      setTimeout: (fn, ms) => {
        if (ms >= 1000) { if (!allowCountdown) return 0; allowCountdown = false; return setTimeout(fn, 0); }
        return setTimeout(fn, Math.min(ms || 0, 5));
      },
    });
    const real = h.ws.api();
    const gated = [];
    let hold = true;
    // Analysis requests wait until the test releases them.
    const api = Object.assign({}, real, {
      stats: { request: (kind, payload) => (hold ? new Promise((resolve) => gated.push({ kind, payload, resolve })) : real.stats.request(kind, payload)) },
    });
    Object.defineProperty(api, 'remote', { get: () => real.remote });
    real.setHistoryPrefs({ frequency: 'auto' });
    h.ws.onSession({ captureEpoch: 1, sampleRate: 48000 });
    let f2 = 100000;
    const feed = (n) => {
      for (let k = 0; k < n; k += 1) {
        h.advance(34);
        f2 += 3200;
        h.ws.onEnvelope([{ effectiveFrame2: f2, rmsDbfs: -30, peak: 0.1 }], 1);
        h.ws.onPitch(frame(f2));
      }
    };
    feed(10);
    const panel = new FakeElement('section');
    const view = L.viewTrainer.createTrainerView(panel, api);

    allowCountdown = true;
    panel.find('[data-tuner-practice-start]').click();
    await settle();
    feed(30);
    const run1 = real.recordingSessionId();
    expect(run1).toBeTruthy();
    panel.find('[data-tuner-practice-finish]').click(); // analysis of run 1 is now pending
    await settle();
    expect(gated.length).toBe(1);

    allowCountdown = true;
    panel.find('[data-tuner-practice-start]').click(); // run 2 starts before that analysis ends
    await settle();
    feed(30);
    const run2 = real.recordingSessionId();
    expect(run2).toBeTruthy();
    expect(run2).not.toBe(run1);
    expect(view.session.getState()).toBe('performing');

    // The analysis of run 1 completes now.
    hold = false;
    while (gated.length) { const g = gated.shift(); g.resolve(await real.stats.request(g.kind, g.payload)); await settle(); }
    await settle();
    await wait(30);
    expect(view.session.getState()).toBe('performing');
    expect(real.isRecording()).toBe(true);
    expect(real.recordingSessionId()).toBe(run2);

    const local = await real.local();
    const owner = await real.getOwner();
    const rows = await local.listSessions(owner);
    const byId = Object.fromEntries(rows.map((r) => [r.sessionId, r]));
    expect(byId[run1].status).toBe('complete');
    expect(byId[run2].status).toBe('recording');

    // Run 2 ends normally: two sessions, each complete, nothing else.
    panel.find('[data-tuner-practice-finish]').click();
    await settle();
    await wait(30);
    const after = await local.listSessions(owner);
    expect(after.map((r) => r.status).sort()).toEqual(['complete', 'complete']);
    expect(real.isRecording()).toBe(false);
  });
});

// ----- 6. history comparisons per note-level condition ---------------------------
describe('history comparisons never mix notes of other conditions (finding 6)', () => {
  const H = L.viewHistory;
  const ev = (median, key) => ({ target: Object.assign({ midi: 69 }, key ? { conditionKey: key, a4Tenths: 4400 } : {}), stats: { medianCents: median } });
  const prev = { session: { sessionId: 'p', conditionKey: 'K442', startedAt: 1, conditions: { a4Tenths: 4420 } }, events: [ev(0), ev(0), ev(0)] };
  const cur = { session: { sessionId: 'c', conditionKey: 'K442', startedAt: 2, conditions: { a4Tenths: 4420 } }, events: [ev(0), ev(30, 'K440'), ev(30, 'K440'), ev(30, 'K440')] };

  it('"same condition" compares the notes of each condition separately (0 → 0, not 0 → 30)', () => {
    const cmp = H.sameConditionComparison([prev, cur], cur);
    const main = cmp.find((c) => c.key === 'K442');
    expect(main).toMatchObject({ isSessionCondition: true, previous: 0, current: 0, events: 1 });
    const other = cmp.find((c) => c.key === 'K440');
    expect(other).toMatchObject({ isSessionCondition: false, previous: null, current: 30, events: 3 });
    expect(other.conditions.a4Tenths).toBe(4400);
    expect(cmp[0].key).toBe('K442'); // the session's own condition first
  });

  it('the growth series of a condition uses only its notes; condition keys list both', () => {
    expect(H.growthSeries([cur, prev], 'K442').map((p) => p.value)).toEqual([0, 0]);
    expect(H.growthSeries([cur, prev], 'K440').map((p) => p.value)).toEqual([30]);
    expect(H.conditionKeys([prev, cur]).map((k) => [k.key, k.sessions, k.events])).toEqual([['K442', 2, 4], ['K440', 1, 3]]);
  });
});

// ----- 7. the previous run is uploaded even after the next run started -----------
describe('each practice run is synced on its own (finding 7)', () => {
  it('account saving on: run A waits for its analysis, run B starts, A completes -> A and B are both uploaded', async () => {
    const server = { uploaded: [], refused: 0 };
    const request = (url, init) => {
      const body = init.body ? JSON.parse(init.body) : null;
      if (url.endsWith('/identity')) return Promise.resolve(response(200, { schemaVersion: 1, accountStorageAvailable: true, ownerId: 'owner-sync', historyEpoch: 1 }));
      if (body && body.historyEpoch !== undefined && body.historyEpoch !== 1) { server.refused += 1; return Promise.resolve(response(409, { detail: { code: 'HISTORY_EPOCH' } })); }
      if (url.endsWith('/sessions') && init.method === 'POST') server.uploaded.push(body.session.sessionId);
      return Promise.resolve(response(200, { ok: true }));
    };
    let allowCountdown = false;
    const h = workspaceHarness({
      request,
      setTimeout: (fn, ms) => {
        if (ms >= 1000) { if (!allowCountdown) return 0; allowCountdown = false; return setTimeout(fn, 0); }
        return setTimeout(fn, Math.min(ms || 0, 5));
      },
    });
    const real = h.ws.api();
    const gated = [];
    let hold = true;
    const api = Object.assign({}, real, {
      stats: { request: (kind, payload) => (hold ? new Promise((resolve) => gated.push({ kind, payload, resolve })) : real.stats.request(kind, payload)) },
    });
    Object.defineProperty(api, 'remote', { get: () => real.remote });
    real.setHistoryPrefs({ frequency: 'auto', destination: 'local+account' });
    h.ws.onSession({ captureEpoch: 1, sampleRate: 48000 });
    let f2 = 100000;
    const feed = (n) => {
      for (let k = 0; k < n; k += 1) {
        h.advance(34);
        f2 += 3200;
        h.ws.onEnvelope([{ effectiveFrame2: f2, rmsDbfs: -30, peak: 0.1 }], 1);
        h.ws.onPitch(frame(f2));
      }
    };
    feed(10);
    const panel = new FakeElement('section');
    L.viewTrainer.createTrainerView(panel, api);

    allowCountdown = true;
    panel.find('[data-tuner-practice-start]').click();
    await settle();
    feed(30);
    const runA = real.recordingSessionId();
    panel.find('[data-tuner-practice-finish]').click(); // A: analysis pending
    await settle();

    allowCountdown = true;
    panel.find('[data-tuner-practice-start]').click(); // B starts
    await settle();
    feed(30);
    const runB = real.recordingSessionId();
    expect(runA).toBeTruthy();
    expect(runB).toBeTruthy();

    hold = false; // A's analysis completes now
    while (gated.length) { const g = gated.shift(); g.resolve(await real.stats.request(g.kind, g.payload)); await settle(); }
    await settle();
    await wait(30);
    expect(server.uploaded).toContain(runA);

    panel.find('[data-tuner-practice-finish]').click(); // B ends
    await settle();
    await wait(30);
    await real.syncNow();
    await settle();
    expect(server.uploaded.filter((id) => id === runA)).toHaveLength(1);
    expect(server.uploaded).toContain(runB);
    expect(server.refused).toBe(0);
    const local = await real.local();
    const owner = await real.getOwner();
    expect(await local.outbox(owner)).toEqual([]); // nothing left unsent
  });

  it('a save that completes after logout is not uploaded under the next account', async () => {
    const uploads = [];
    let who = 'owner-1';
    const request = (url, init) => {
      if (url.endsWith('/identity')) return Promise.resolve(response(200, { schemaVersion: 1, accountStorageAvailable: true, ownerId: who, historyEpoch: 1 }));
      if (url.endsWith('/sessions') && init.method === 'POST') uploads.push(who);
      return Promise.resolve(response(200, { ok: true }));
    };
    const h = workspaceHarness({ request });
    const api = h.ws.api();
    api.setHistoryPrefs({ frequency: 'manual', destination: 'local+account' });
    h.ws.onSession({ captureEpoch: 1, sampleRate: 48000 });
    h.ws.onPitch(frame(100000));
    h.ws.store.flush();
    await api.getOwner();
    const pending = api.saveSnapshot('free', h.ws.store.snapshot(), { events: [] }, {});
    h.ws.onLeave('logout');
    who = 'owner-2';
    const res = await pending;
    expect(res.ok).toBe(false);
    await api.getOwner();
    await api.syncNow();
    await settle();
    expect(uploads).toEqual([]);
  });
});
