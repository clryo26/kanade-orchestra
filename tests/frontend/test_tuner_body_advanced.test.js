import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

// Body-level regression tests for the advanced flows: pause,
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

function harness(options = {}) {
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
    bind: vi.fn(), setFixedNoteOptions: vi.fn(), setTargetConfig: vi.fn(), setJudgment: vi.fn(), setRange: vi.fn(), setReference: vi.fn(),
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
  const storage = { data: { ...options.storageData }, getItem(k) { return this.data[k] ?? null; }, setItem(k, v) { this.data[k] = String(v); } };
  let now = 0;
  let renderFrame;
  let workspace;
  const body = createTunerBody({
    lib: L,
    storage,
    now: () => now,
    requestAnimationFrame: (fn) => { renderFrame = fn; return 1; },
    cancelAnimationFrame: () => {},
    isDocumentHidden: () => false,
    reload: vi.fn(),
    wakeLock: { request: () => Promise.resolve({ release: () => Promise.resolve() }) },
    createView: () => view,
    createController: (callbacks) => { cb = callbacks; return controller; },
    createPlaybackEngine: (callbacks) => L.playback.createPlaybackEngine({ createContext: () => new Ctx(), ...timers, ...callbacks }),
    createWorkspace: (bodyApi) => (workspace = L.workspace.createWorkspace({
      lib: L, release: 'test', body: bodyApi, storage, idbFactory: null, request: () => Promise.reject(new Error('no network in tests')),
      deviceId: () => 'dev', now: () => now, utcNow: () => 0, ...timers, ensureGroup: () => Promise.resolve(), isDocumentHidden: () => false, announce: () => {},
    })),
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
  return {
    body, storage, view, controller, contexts, statuses, startOptions, state, workspace,
    pushPitch: (frequency, frames = 40) => {
      for (let i = 0; i < frames; i += 1) {
        now += 50;
        cb.onPitch({ valid: true, frequency });
        renderFrame(now);
      }
    },
    reading: () => view.showReading.mock.calls.at(-1)[0],
    coordinator: () => body.api.coordinator,
    runTimeouts: () => { const due = timeouts; timeouts = []; due.forEach((t) => t.fn()); },
    pendingTimeouts: () => timeouts.length,
  };
}

const flush = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };

describe('tuner body: pause and resume', () => {
  it('releases the microphone when paused and resumes only by a tap', async () => {
    const h = harness();
    expect(h.body.api).toBeTruthy();
    await h.body.start(h.startOptions);
    expect(h.body.handlers.onFreeze).toBeUndefined();
    expect(h.body.handlers.onDetailToggle).toBeUndefined();
    expect(h.controller.stop).not.toHaveBeenCalled();
    expect(h.coordinator().get()).toMatchObject({ displayFrozen: false, capture: 'running' });
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


describe('measurement target compatibility', () => {
  const saved = (judgment) => ({ portalTunerSettings: JSON.stringify({
    schemaVersion: 1, a4Tenths: 4420, persistSettings: true,
    prefs: { judgment, presets: { temperament: [{ id: 'old', name: 'old', data: judgment }] } },
  }) });

  it.each(['minor-third', 'major-third', 'just-major', 'just-minor', 'pythagorean', 'custom'])(
    'restores %s as equal while preserving fixed note and spelling on re-entry', async (temperament) => {
      const old = { temperament, fixedMidi: 60, spelling: 'flat', rootMidi: 65, role: 'third', octaveShift: 2, customOffsets: [0, 25] };
      const h = harness({ storageData: saved(old) });
      const raw = h.storage.data.portalTunerSettings;
      await h.body.start(h.startOptions);
      expect(h.body.api.getTargetConfig()).toEqual(L.targetModel.normalizeConfig({ temperament: 'equal', fixedMidi: 60, spelling: 'flat' }));
      expect(h.storage.data.portalTunerSettings).toBe(raw);
      h.body.stop();
      await h.body.start(h.startOptions);
      expect(h.body.api.getTargetConfig()).toMatchObject({ temperament: 'equal', fixedMidi: 60 });
      expect(h.body.api.getPrefs().presets.temperament[0].data).toEqual(old);
      expect(h.contexts).toHaveLength(0);
    },
  );

  it.each([null, -1, 23, 109, '60', 60.5])('normalizes invalid fixed note %s to auto', async (fixedMidi) => {
    const h = harness({ storageData: saved({ temperament: 'custom', fixedMidi }) });
    await h.body.start(h.startOptions);
    expect(h.body.api.getTargetConfig()).toMatchObject({ temperament: 'equal', fixedMidi: null });
  });

  it('rejects non-equal presets without target, settings, view or playback changes', async () => {
    const h = harness({ storageData: saved({ temperament: 'equal', fixedMidi: 60 }) });
    await h.body.start(h.startOptions);
    h.pushPitch(442);
    const events = [];
    h.workspace.api().on((type) => events.push(type));
    const reading = h.reading();
    const before = h.body.api.getTargetConfig();
    const raw = h.storage.data.portalTunerSettings;
    const calls = h.view.setJudgment.mock.calls.length;
    const readings = h.view.showReading.mock.calls.length;
    for (const config of [undefined, null, [], new Date(0), 'equal', 42, ...['minor-third', 'major-third', 'just-major', 'just-minor', 'pythagorean', 'custom', 'unknown'].map((temperament) => ({ temperament, fixedMidi: 69 }))]) {
      expect(h.body.api.applyTargetConfig(config)).toBe(false);
    }
    expect(h.body.api.getTargetConfig()).toEqual(before);
    expect(h.storage.data.portalTunerSettings).toBe(raw);
    expect(h.view.setJudgment).toHaveBeenCalledTimes(calls);
    expect(h.view.showReading).toHaveBeenCalledTimes(readings);
    expect(h.reading()).toEqual(reading);
    expect(events).toEqual([]); // no target-change / playback-change for other tabs or history
    expect(h.contexts).toHaveLength(0);
    expect(h.body.api.applyTargetConfig({ temperament: 'equal', fixedMidi: 69 })).toBe(true);
    expect(h.body.api.getTargetConfig().fixedMidi).toBe(69);
    expect(h.body.api.applyTargetConfig({ fixedMidi: 62 })).toBe(true);
    expect(h.body.api.getTargetConfig()).toMatchObject({ temperament: 'equal', fixedMidi: 62 });
    h.body.handlers.onTargetOption('temperament', 'custom');
    expect(h.body.api.getTargetConfig().temperament).toBe('equal');
    h.body.handlers.onTargetOption('fixedMidi', 64);
    expect(h.body.api.getTargetConfig().fixedMidi).toBe(64);
    expect(events).toEqual(['target-change', 'target-change', 'target-change']);
    expect(h.contexts).toHaveLength(0);
  });

  it.each([24, 60, 108])('preserves valid fixed MIDI %i and spelling across restart', async (fixedMidi) => {
    const h = harness({ storageData: saved({ temperament: 'custom', fixedMidi, spelling: 'sharp' }) });
    await h.body.start(h.startOptions);
    h.body.stop();
    await h.body.start(h.startOptions);
    expect(h.body.api.getTargetConfig()).toMatchObject({ temperament: 'equal', fixedMidi, spelling: 'sharp' });
    expect(h.view.setTargetConfig.mock.calls.at(-1)[0]).toMatchObject({ fixedMidi });
  });

  it('fixed-note and A4 changes immediately recalculate, render and notify without playing', async () => {
    const h = harness();
    await h.body.start(h.startOptions);
    expect(h.body.api.getTargetConfig()).toMatchObject({ temperament: 'equal', fixedMidi: null });
    h.pushPitch(442);
    expect(h.reading().judgment).toBe('in-tune');
    const events = [];
    h.workspace.api().on((type) => events.push(type));
    h.body.handlers.onTargetOption('fixedMidi', 60);
    expect(h.reading()).toMatchObject({ note: { midi: 69 }, targetNote: { midi: 60 }, judgment: 'sharp', needlePercent: 100 });
    expect(h.reading().cents).toBeCloseTo(900, 6);
    expect(h.reading().frequency).toBeCloseTo(442, 9);
    expect(h.reading().targetFrequency).toBeCloseTo(442 * 2 ** (-9 / 12), 9);
    expect(events).toEqual(['target-change']);
    h.body.handlers.onTargetOption('fixedMidi', null);
    expect(h.reading().judgment).toBe('in-tune');
    h.body.handlers.onStep(10);
    expect(h.reading().cents).toBeCloseTo(1200 * Math.log2(442 / 443), 6);
    expect(h.reading().judgment).toBe('flat');
    expect(events).toEqual(['target-change', 'target-change', 'a4-change']);
    expect(h.contexts).toHaveLength(0);
  });

  it('meter scale updates reach the view without changing frequency, target, cents or tolerance', async () => {
    const h = harness();
    h.view.setMeterScale = vi.fn();
    await h.body.start(h.startOptions);
    // The reference positions are deliberately outside the default pass band.
    for (const cents of [-13.7, 15.6]) {
      h.pushPitch(442 * 2 ** (cents / 1200), 80);
      const before = h.reading();
      expect(before.judgment).toBe(cents < 0 ? 'flat' : 'sharp');
      for (const range of [10, 25, 50, 100]) {
        h.body.api.setPrefs({ meterRangeCents: range });
        h.pushPitch(442 * 2 ** (cents / 1200), 1);
        const after = h.reading();
        for (const key of ['frequency', 'targetFrequency', 'cents']) expect(after[key]).toBeCloseTo(before[key], 6);
        expect(after.judgment).toBe(before.judgment);
        expect(after.toleranceCents).toBe(3);
        expect(after.needlePercent).toBeCloseTo(50 + 50 * Math.max(-range, Math.min(range, after.cents)) / range, 6);
        expect(h.view.setMeterScale).toHaveBeenLastCalledWith(range, 3);
      }
    }
  });

  it('measurement edits preserve saved non-equal presets and sound presets', async () => {
    const old = { temperament: 'just-major', fixedMidi: 60 };
    const storageData = saved(old);
    const payload = JSON.parse(storageData.portalTunerSettings);
    payload.prefs.presets.sound = [{ id: 'sound', name: 'Sound', savedAt: 123, data: { voices: [{ source: 'hz', hz: 333.3 }] } }];
    storageData.portalTunerSettings = JSON.stringify(payload);
    const h = harness({ storageData });
    await h.body.start(h.startOptions);
    const presets = h.body.api.getPrefs().presets;
    h.body.handlers.onTargetOption('fixedMidi', 62);
    h.body.handlers.onStep(10);
    const after = JSON.parse(h.storage.data.portalTunerSettings);
    expect(after.schemaVersion).toBe(1);
    expect(after.persistSettings).toBe(true);
    expect(after.prefs.presets).toEqual(presets);
    expect(after.prefs.judgment).toMatchObject({ temperament: 'equal', fixedMidi: 62 });
  });

  it('legacy copy handlers cannot overwrite direct Hz settings or retune playing audio', async () => {
    const h = harness({ storageData: saved({ temperament: 'just-major', fixedMidi: 60 }) });
    await h.body.start(h.startOptions);
    const handlers = h.body.handlers;
    handlers.onPlaybackSource('hz');
    handlers.onPlaybackHzInput('333.3');
    const before = h.view.setPlayback.mock.calls.at(-1)[0];
    handlers.onSetPlaybackFromRoot();
    handlers.onSetPlaybackFromTarget();
    expect(h.view.setPlayback.mock.calls.at(-1)[0]).toEqual(before);
    expect(h.contexts).toHaveLength(0);
    handlers.onPlay();
    expect(h.body.api.isPlaying()).toBe(true);
    const frequency = h.contexts[0].oscillators[0].frequency.events;
    const initialEvents = frequency.slice();
    expect(initialEvents[0][1]).toBe(333.3);
    handlers.onTargetOption('fixedMidi', 62);
    handlers.onStep(10);
    handlers.onSetPlaybackFromRoot();
    handlers.onSetPlaybackFromTarget();
    expect(frequency).toEqual(initialEvents);
    expect(h.view.setPlayback.mock.calls.at(-1)[0]).toMatchObject({ source: 'hz', hzText: '333.3', playing: true });
    expect(h.view.setJudgment.mock.calls.at(-1)[0]).toMatchObject({ mode: 'equal', just: null });
    handlers.onStop();
    expect(h.body.api.isPlaying()).toBe(false);
  });

  it('records fixed-note and A4 condition boundaries but adds none for a rejected preset', async () => {
    const h = harness();
    await h.body.start(h.startOptions);
    h.workspace.onSession({ captureEpoch: 1, sampleRate: 48000 });
    const initial = h.workspace.store.snapshot();
    expect(initial.conditions).toHaveLength(1);
    expect(initial.conditions[0].conditions).toMatchObject({ a4Tenths: 4420, targetConfig: { temperament: 'equal', fixedMidi: null } });
    expect(h.body.api.applyTargetConfig({ temperament: 'just-major', fixedMidi: 69 })).toBe(false);
    expect(h.workspace.store.snapshot()).toEqual(initial);
    h.body.handlers.onTargetOption('fixedMidi', 60);
    h.body.handlers.onStep(10);
    const after = h.workspace.store.snapshot();
    expect(after.boundaries.map((boundary) => boundary.type)).toEqual(['targetChange', 'targetChange']);
    expect(after.conditions.map(({ conditions }) => [conditions.a4Tenths, conditions.targetConfig.fixedMidi])).toEqual([
      [4420, null], [4420, 60], [4430, 60],
    ]);
    expect(after.conditions[0]).toEqual(initial.conditions[0]); // earlier conditions are not rewritten
    const beforeReject = h.workspace.store.snapshot();
    expect(h.body.api.applyTargetConfig({ temperament: 'custom', fixedMidi: 62 })).toBe(false);
    expect(h.workspace.store.snapshot()).toEqual(beforeReject);
  });

  it('with saving off, fixed-note and display edits stay in memory and A4 saves no preferences', async () => {
    const h = harness();
    await h.body.start(h.startOptions);
    expect(h.body.api.isPersistingSettings()).toBe(false);
    expect(h.body.api.applyTargetConfig({ temperament: 'equal', fixedMidi: 60 })).toBe(true);
    h.body.api.setPrefs({ meterRangeCents: 25, toleranceCents: 10 });
    expect(h.storage.data.portalTunerSettings).toBeUndefined();
    expect(h.body.api.getTargetConfig().fixedMidi).toBe(60);
    h.body.handlers.onStep(10);
    expect(JSON.parse(h.storage.data.portalTunerSettings)).toEqual({ schemaVersion: 1, a4Tenths: 4430, persistSettings: false });
    h.body.stop();
    await h.body.start(h.startOptions);
    expect(h.body.api.getTargetConfig()).toMatchObject({ temperament: 'equal', fixedMidi: null });
    expect(h.body.api.getPrefs()).toMatchObject({ meterRangeCents: 50, toleranceCents: 3 });
    expect(h.body.api.getA4()).toBe(443);
    expect(h.contexts).toHaveLength(0);
  });

  it('keeps unknown saved schemas untouched even after measurement edits', async () => {
    const raw = JSON.stringify({ schemaVersion: 999, a4Tenths: 4420, persistSettings: true, prefs: { judgment: { temperament: 'custom', fixedMidi: 60 } } });
    const h = harness({ storageData: { portalTunerSettings: raw } });
    await h.body.start(h.startOptions);
    h.body.handlers.onTargetOption('fixedMidi', 62);
    h.body.handlers.onStep(10);
    h.body.api.setPersistSettings(true);
    expect(h.storage.data.portalTunerSettings).toBe(raw);
    expect(h.body.api.getTargetConfig().temperament).toBe('equal');
    expect(h.contexts).toHaveLength(0);
  });
});
