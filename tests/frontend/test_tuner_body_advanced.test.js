import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

// Body-level regression tests for the advanced flows: pause / freeze,
// exclusive vs. simultaneous output and leaving while outputs are planned.
// Real modules (coordinator, workspace, playback, scheduler); fake audio.
const require = createRequire(import.meta.url);
const dir = path.join(process.cwd(), 'src/static/js/modules/tuner');
for (const name of ['music', 'temperament', 'target_model', 'display_filter', 'settings', 'errors', 'audio', 'scheduler', 'playback', 'graph', 'controller', 'onset', 'note_events', 'analysis_stats', 'measurement_store', 'session_coordinator', 'intonation_profile', 'storage_local', 'storage_remote', 'workspace']) {
  require(path.join(dir, `${name}.js`));
}
const L = globalThis.PortalTunerLib;
const { createTunerBody } = require(path.join(dir, 'index.js'));

function param(initial) {
  const events = [];
  return {
    value: initial, events,
    cancelScheduledValues: (t) => events.push(['cancel', t]),
    setValueAtTime: (v, t) => events.push(['set', v, t]),
    linearRampToValueAtTime: (v, t) => events.push(['linear', v, t]),
    exponentialRampToValueAtTime: (v, t) => events.push(['exp', v, t]),
  };
}

function harness() {
  const contexts = [];
  class Ctx {
    constructor() { this.state = 'running'; this.currentTime = 0; this.sampleRate = 48000; this.closed = false; this.destination = {}; this.oscillators = []; contexts.push(this); }
    resume() { return Promise.resolve(); }
    close() { this.closed = true; this.state = 'closed'; return Promise.resolve(); }
    createGain() { return { gain: param(1), connect() {}, disconnect() {} }; }
    createOscillator() {
      const osc = { type: 'sine', frequency: param(0), connect() {}, disconnect() {}, start() {}, stop() { osc.stopped = true; }, setPeriodicWave() {} };
      this.oscillators.push(osc);
      return osc;
    }
    createPeriodicWave() { return {}; }
  }
  let timeouts = [];
  let intervals = [];
  let id = 0;
  const timers = {
    setTimeout: (fn, ms) => { id += 1; timeouts.push({ id, fn, ms }); return id; },
    clearTimeout: (tid) => { timeouts = timeouts.filter((t) => t.id !== tid); },
    setInterval: (fn, ms) => { id += 1; intervals.push({ id, fn, ms }); return id; },
    clearInterval: (tid) => { intervals = intervals.filter((t) => t.id !== tid); },
  };
  const graph = {};
  ['setSession', 'setRange', 'setAxis', 'setSpectrum', 'setSilent', 'setMarkers', 'draw', 'clear'].forEach((n) => { graph[n] = vi.fn(); });
  const statuses = [];
  const view = {
    root: {}, graph,
    bind: vi.fn(), setRootOptions: vi.fn(), setJudgment: vi.fn(), setRange: vi.fn(), setReference: vi.fn(),
    setStatus: vi.fn((info) => statuses.push(info.state)), showReading: vi.fn(), setPlayback: vi.fn(), announce: vi.fn(),
  };
  let cb = null;
  const controller = {
    state: 'hidden',
    start: vi.fn(async () => { controller.state = 'measuring'; cb.onState({ state: 'measuring' }); }),
    stop: vi.fn(() => { const was = controller.state; controller.state = 'hidden'; if (was !== 'hidden') cb.onState({ state: 'hidden' }); }),
    getState: () => controller.state,
    getStateCode: () => null,
    getSession: () => null,
    setDisplayRange: vi.fn(() => true),
    setPlaybackState: vi.fn(),
    configure: vi.fn(),
  };
  const storage = { data: {}, getItem(k) { return this.data[k] ?? null; }, setItem(k, v) { this.data[k] = String(v); } };
  const body = createTunerBody({
    lib: L,
    storage,
    now: () => 0,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    isDocumentHidden: () => false,
    reload: vi.fn(),
    wakeLock: { request: () => Promise.resolve({ release: () => Promise.resolve() }) },
    createView: () => view,
    createController: (callbacks) => { cb = callbacks; return controller; },
    createPlaybackEngine: (callbacks) => L.playback.createPlaybackEngine({ createContext: () => new Ctx(), ...timers, ...callbacks }),
    createWorkspace: (bodyApi) => L.workspace.createWorkspace({
      lib: L, release: 'test', body: bodyApi, storage, idbFactory: null, request: () => Promise.reject(new Error('no network in tests')),
      deviceId: () => 'dev', now: () => 0, utcNow: () => 0, ...timers, ensureGroup: () => Promise.resolve(), isDocumentHidden: () => false, announce: () => {},
    }),
    ...timers,
  });
  const state = { active: true };
  const startOptions = {
    host: { contains: () => true },
    generation: 1,
    guard: () => state.active,
    requestLeave: vi.fn(() => body.stop('guard')),
    onUserRestart: vi.fn(),
    onMeasurementResume: vi.fn(),
    cancelMeasurementResume: vi.fn(),
    isScreenActive: () => state.active,
  };
  return { body, controller, contexts, statuses, startOptions, state, coordinator: () => body.api.coordinator, runTimeouts: () => { const due = timeouts; timeouts = []; due.forEach((t) => t.fn()); }, pendingTimeouts: () => timeouts.length };
}

const flush = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };

describe('tuner body: pause and freeze', () => {
  it('"表示固定" keeps measuring; "測定一時停止" releases the microphone and resumes only by a tap', async () => {
    const h = harness();
    expect(h.body.api).toBeTruthy();
    await h.body.start(h.startOptions);
    h.body.handlers.onFreeze();
    expect(h.controller.stop).not.toHaveBeenCalled();
    expect(h.coordinator().get()).toMatchObject({ displayFrozen: true, capture: 'running' });
    h.body.handlers.onPauseToggle();
    expect(h.controller.stop).toHaveBeenCalledTimes(1);
    expect(h.coordinator().get().capture).toBe('paused');
    expect(h.statuses.at(-1)).toBe('paused');
    expect(h.startOptions.cancelMeasurementResume).toHaveBeenCalled();
    h.runTimeouts();
    expect(h.startOptions.onMeasurementResume).not.toHaveBeenCalled(); // no automatic resume
    h.body.handlers.onPauseToggle();
    expect(h.startOptions.onMeasurementResume).toHaveBeenCalledWith(0);
  });
});

describe('tuner body: exclusive and simultaneous output', () => {
  it('exclusive (default): starting voices stops the microphone', async () => {
    const h = harness();
    await h.body.start(h.startOptions);
    const res = h.body.api.startVoicesFromTap([{ frequency: 440 }, { frequency: 660 }], { kind: 'hold' });
    expect(res.started).toBe(true);
    expect(h.controller.stop).toHaveBeenCalled();
    expect(h.coordinator().get()).toMatchObject({ capture: 'stopped', output: 'playing' });
    expect(h.startOptions.cancelMeasurementResume).toHaveBeenCalled();
  });

  it('simultaneous mode keeps measuring while playing; leave stops all and resets the mode', async () => {
    const h = harness();
    await h.body.start(h.startOptions);
    h.body.api.setSimultaneous(true);
    const res = h.body.api.startVoicesFromTap([{ frequency: 440 }], { kind: 'repeat', seconds: 0.5, gapSeconds: 0.5, repeats: null });
    expect(res.started).toBe(true);
    expect(h.controller.stop).not.toHaveBeenCalled();
    expect(h.coordinator().get()).toMatchObject({ capture: 'running', output: 'playing', simultaneous: true });
    h.body.stop('background');
    expect(h.contexts.every((c) => c.closed)).toBe(true);
    expect(h.coordinator().get()).toMatchObject({ capture: 'stopped', output: 'idle', simultaneous: false, earphonesDeclared: false });
    const before = h.contexts.length;
    h.runTimeouts(); // planned notes after leave must not create or play anything
    expect(h.contexts.length).toBe(before);
    expect(h.body.api.isPlaying()).toBe(false);
    // Returning does not play by itself and the mode must be chosen again.
    await h.body.start(h.startOptions);
    expect(h.body.api.isPlaying()).toBe(false);
    expect(h.coordinator().get().simultaneous).toBe(false);
  });

  it('voices are refused when the tuner screen is not active (no audio created)', async () => {
    const h = harness();
    await h.body.start(h.startOptions);
    h.state.active = false;
    expect(h.body.api.startVoicesFromTap([{ frequency: 440 }], { kind: 'hold' }).started).toBe(false);
    expect(h.contexts).toHaveLength(0);
  });

  it('a pattern that ends by itself in exclusive mode asks for a tap instead of restarting the microphone', async () => {
    const h = harness();
    await h.body.start(h.startOptions);
    h.body.api.startVoicesFromTap([{ frequency: 440 }], { kind: 'timed', seconds: 0.05 });
    h.contexts[0].currentTime = 5;
    for (let i = 0; i < 5; i += 1) h.runTimeouts();
    expect(h.body.api.isPlaying()).toBe(false);
    expect(h.statuses.at(-1)).toBe('resume-required');
    expect(h.startOptions.onMeasurementResume).not.toHaveBeenCalled();
    h.body.api.stopPlaybackFromTap(); // the next tap resumes measuring
    expect(h.startOptions.onMeasurementResume).toHaveBeenCalledWith(0);
  });
});
