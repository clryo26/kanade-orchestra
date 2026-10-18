import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { IDBFactory } = require('fake-indexeddb');
const dir = path.join(process.cwd(), 'src/static/js/modules/tuner');
for (const name of ['music', 'temperament', 'target_model', 'onset', 'note_events', 'analysis_stats', 'measurement_store', 'session_coordinator', 'intonation_profile', 'storage_local', 'storage_remote', 'workspace']) {
  require(path.join(dir, `${name}.js`));
}
const L = globalThis.PortalTunerLib;

function memoryStorage() {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k), map };
}

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, text: () => Promise.resolve(JSON.stringify(body)) };
}

function setup(options = {}) {
  const coordinator = L.sessionCoordinator.createSessionCoordinator();
  const opened = [];
  const factory = new IDBFactory();
  const idbFactory = { open: (...args) => { opened.push(args[0]); return factory.open(...args); } };
  const requests = [];
  const playbackStates = [];
  let perf = 1000;
  const storage = options.storage || memoryStorage();
  const ws = L.workspace.createWorkspace({
    lib: L,
    release: 'test',
    body: {
      coordinator,
      setPlaybackState: (s) => playbackStates.push(s),
      getTargetConfig: () => ({ temperament: 'equal' }),
      getPrefs: () => ({ registerProfile: 'full', inputThreshold: { mode: 'manual', dbfs: -60 } }),
      getA4Tenths: () => 4420,
      getInstrument: () => options.instrument || null,
    },
    storage,
    idbFactory,
    request: (url, init) => { requests.push(url); return options.request ? options.request(url, init) : Promise.resolve(response(403, { detail: { code: 'ACCOUNT_STORAGE_UNAVAILABLE' } })); },
    deviceId: () => 'dev',
    now: () => perf,
    utcNow: () => 1_800_000_000_000 + perf,
    setTimeout: (fn) => setTimeout(fn, 0),
    clearTimeout: (id) => clearTimeout(id),
    ensureGroup: () => Promise.resolve(),
    isDocumentHidden: () => false,
  });
  return { ws, coordinator, opened, requests, playbackStates, storage, advance: (ms) => { perf += ms; } };
}

const frame = (f2, extra = {}) => Object.assign({ captureEpoch: 1, effectiveFrame2: f2, analysisEndFrameExclusive: Math.ceil(f2 / 2) + 2048, frequencyHz: 440, confidence: 0.9, rmsDbfs: -30, qualityFlags: 0, invalidReason: 0 }, extra);

describe('workspace persistence', () => {
  it('history saving "none" (default) opens no IndexedDB and sends nothing', async () => {
    const { ws, opened, requests } = setup();
    const api = ws.api();
    expect(api.historyPrefs().frequency).toBe('none');
    ws.onSession({ captureEpoch: 1, sampleRate: 48000 });
    for (let k = 0; k < 50; k += 1) ws.onPitch(frame(10000 + k * 2400));
    expect(await api.startRecording('free')).toEqual({ ok: false, reason: 'disabled' });
    expect(await api.saveSnapshot('analysis', ws.store.snapshot(), {})).toEqual({ ok: false, reason: 'disabled' });
    expect(api.isRecording()).toBe(false);
    expect(opened).toEqual([]);
    expect(requests).toEqual([]);
  });

  it('manual save stores summaries in the device namespace when account storage is unavailable', async () => {
    const { ws, requests } = setup();
    const api = ws.api();
    api.setHistoryPrefs({ frequency: 'manual' });
    ws.onSession({ captureEpoch: 1, sampleRate: 48000 });
    for (let k = 0; k < 90; k += 1) ws.onPitch(frame(10000 + k * 2400));
    ws.store.flush();
    const res = await api.saveSnapshot('analysis', ws.store.snapshot(), { events: [{ medianCents: 1.5 }], result: { ok: 1 } });
    expect(res).toMatchObject({ ok: true });
    expect(res.queued).toBeUndefined(); // destination "local" never uploads
    expect(requests).toEqual(['/api/tuner/identity']);
    expect(api.identity().status).toBe('device');
    const local = await api.local();
    const owner = await api.getOwner();
    expect(owner.ownerId).toMatch(/^device-/);
    const saved = await local.getSession(owner, res.sessionId);
    expect(saved.session).toMatchObject({ status: 'complete', a4Tenths: 4420, temperament: 'equal' });
    expect(saved.chunks.reduce((s, c) => s + c.frame2.length, 0)).toBe(90);
    expect(saved.events).toHaveLength(1);
  });

  it('logout while a save is in flight: the completion is stale and personal memory is cleared', async () => {
    let release;
    const { ws } = setup({ request: () => new Promise((r) => { release = r; }) });
    const api = ws.api();
    api.setHistoryPrefs({ frequency: 'manual' });
    ws.onSession({ captureEpoch: 1, sampleRate: 48000 });
    ws.onPitch(frame(10000));
    const pending = api.saveSnapshot('analysis', ws.store.snapshot(), {});
    await new Promise((r) => setTimeout(r, 0));
    ws.onLeave('logout');
    release(response(200, { ownerId: 'owner-of-previous-user', accountStorageAvailable: true, historyEpoch: 1 }));
    const res = await pending;
    expect(res.ok).toBe(false);
    expect(ws.store.frameCount()).toBe(0); // in-memory measurements forgotten
    expect(api.identity().status).toBe('unknown');
  });

  it('auto recording keeps measuring when saving stops, and leave interrupts the recording', async () => {
    const { ws, advance } = setup();
    const api = ws.api();
    api.setHistoryPrefs({ frequency: 'auto' });
    ws.onSession({ captureEpoch: 1, sampleRate: 48000 });
    expect(await api.startRecording('free')).toMatchObject({ ok: true });
    const statuses = [];
    api.on((type, p) => { if (type === 'save-status') statuses.push(p.state); });
    for (let k = 0; k < 40; k += 1) { advance(30); ws.onPitch(frame(10000 + k * 2400)); }
    ws.onLeave('tab');
    expect(statuses).toContain('interrupted');
    expect(api.isRecording()).toBe(false);
    ws.onPitch(frame(200000)); // measuring after leave still works (no throw)
    expect(ws.store.frameCount()).toBeGreaterThan(0);
  });

  it('setting history to "none" while recording discards the recording', async () => {
    const { ws } = setup();
    const api = ws.api();
    api.setHistoryPrefs({ frequency: 'auto' });
    ws.onSession({ captureEpoch: 1, sampleRate: 48000 });
    await api.startRecording('free');
    const statuses = [];
    api.on((type, p) => { if (type === 'save-status') statuses.push(p.state); });
    api.setHistoryPrefs({ frequency: 'none' });
    await new Promise((r) => setTimeout(r, 20));
    expect(api.isRecording()).toBe(false);
    expect(statuses).toContain('discarded');
  });

  it('recovers a stale "recording" session as incomplete when the owner is resolved again', async () => {
    const storage = memoryStorage();
    const first = setup({ storage });
    const api = first.ws.api();
    api.setHistoryPrefs({ frequency: 'auto' });
    first.ws.onSession({ captureEpoch: 1, sampleRate: 48000 });
    const started = await api.startRecording('free');
    const local = await api.local();
    // The tab disappears without leave; much later the owner is resolved again.
    first.advance(10 * 60 * 1000);
    first.ws.clearPersonal();
    const owner = await api.getOwner();
    await new Promise((r) => setTimeout(r, 20));
    const saved = await local.getSession(owner, started.sessionId);
    expect(saved.session.status).toBe('incomplete');
  });
});

describe('workspace conditions', () => {
  it('records the chosen instrument and the environment; only the instrument setting changes the key', () => {
    const instrument = { instrumentId: 'ins-1', revision: 2, settingRevision: 3, name: 'Clarinet' };
    const { ws } = setup({ instrument });
    const api = ws.api();
    const before = api.conditionsSnapshot();
    expect(before.conditions).toMatchObject({ instrumentId: 'ins-1', instrumentRevision: 2, settingRevision: 3, environment: null });
    expect(before.instrument.name).toBe('Clarinet');
    api.setEnvironment({ temperatureC: 24, humidityPct: 70, warmup: 'done' });
    const after = api.conditionsSnapshot();
    expect(after.conditions.environment).toEqual({ temperatureC: 24, humidityPct: 70, warmup: 'done', warmupMinutes: null });
    expect(after.conditionKey).toBe(before.conditionKey);
    ws.clearPersonal();
    expect(api.environment()).toBeNull();
  });
});

describe('workspace simultaneous mode', () => {
  it('flags frames inside an output interval (bit 16) only in simultaneous mode', () => {
    const { ws, coordinator } = setup();
    ws.onSession({ captureEpoch: 1, sampleRate: 48000 });
    ws.onClock({ captureEpoch: 1, contextTime: 1, performanceTime: 1000, sampleRate: 48000 });
    const seen = [];
    ws.api().on((type, f) => { if (type === 'pitch') seen.push(f.qualityFlags); });
    // Exclusive mode: output events are ignored.
    ws.onOutput({ type: 'start', frequencies: [440] });
    ws.onPitch(frame(100000));
    coordinator.setSimultaneous(true, true);
    coordinator.setCapture('running');
    ws.onOutput({ type: 'start', frequencies: [440] });
    ws.onPitch(frame(102400));
    ws.onOutput({ type: 'end' });
    ws.onPitch(frame(500000));
    expect(seen).toEqual([0, 16, 0]);
    ws.store.flush();
    const intervals = ws.store.snapshot().intervals;
    expect(intervals).toHaveLength(1);
    expect(intervals[0].kind).toBe('output');
    expect(intervals[0].endFrame2).toBeGreaterThan(intervals[0].startFrame2); // includes the after-sound margin
  });
});

describe('workspace external output (metronome clicks beside the tuner)', () => {
  it('excludes reported metronome clicks while measuring, also without the simultaneous declaration', () => {
    const { ws, coordinator, playbackStates } = setup();
    ws.onSession({ captureEpoch: 1, sampleRate: 48000 });
    ws.onClock({ captureEpoch: 1, contextTime: 1, performanceTime: 1000, sampleRate: 48000 });
    coordinator.setCapture('running');
    ws.onOutput({ type: 'click', external: true, frequencies: [] });
    ws.store.flush();
    const intervals = ws.store.snapshot().intervals;
    expect(intervals).toHaveLength(1);
    expect(intervals[0].kind).toBe('output');
    expect(intervals[0].endFrame2).toBeGreaterThan(intervals[0].startFrame2);
    expect(playbackStates).toEqual([]); // the tuner's own playback state is not touched
  });
});

describe('statistics client', () => {
  it('falls back to the same pure functions without a Worker and supersedes older requests', async () => {
    const client = L.workspace.createStatsClient({ release: 'x' });
    const ev = (s, m) => ({ sessionId: s, midi: 69, conditionsKey: 'k', durationSeconds: 1, observationCount: 20, coverage: 1, meanCents: m, medianCents: m, sdCents: 1, engineVersion: 'e', statsVersion: 1, startedAt: 1 });
    const first = client.request('diagnose', { events: [ev('a', 1)], conditionKey: 'k' });
    const second = client.request('diagnose', { events: ['a', 'b', 'c', 'd'].flatMap((s) => [ev(s, 6), ev(s, 6.2)]), conditionKey: 'k' });
    expect(await first).toEqual({ superseded: true });
    const res = await second;
    expect(res.notes['69']).toMatchObject({ nSessions: 4, tendency: 'high' });
    expect(client.usesWorker()).toBe(false);
  });

  it('a worker of another release is not trusted (falls back)', async () => {
    let posted = null;
    const fake = { postMessage: (m) => { posted = m; if (m.type === 'hello') setTimeout(() => fake.onmessage({ data: { type: 'ready', release: 'old' } }), 0); }, terminate() {} };
    const client = L.workspace.createStatsClient({ release: 'new', createWorker: () => fake });
    const res = await client.request('diagnose', { events: [], conditionKey: 'k' });
    expect(posted.type).toBe('hello');
    expect(res.notes).toEqual({});
    expect(client.usesWorker()).toBe(false);
  });
});
