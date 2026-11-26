import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const root = process.cwd();
const dir = path.join(root, 'src/static/js/modules/tuner');
const lib = {
  music: require(path.join(dir, 'music.js')),
  temperament: require(path.join(dir, 'temperament.js')),
  targetModel: require(path.join(dir, 'target_model.js')),
  displayFilter: require(path.join(dir, 'display_filter.js')),
  settings: require(path.join(dir, 'settings.js')),
  playback: require(path.join(dir, 'playback.js')),
  graph: require(path.join(dir, 'graph.js')),
  controller: require(path.join(dir, 'controller.js')),
  releases: {},
};
const { createTunerBody, POST_PLAYBACK_DELAY_MS, MAIN_MODULES } = require(path.join(dir, 'index.js'));
const { createTunerLauncher } = require(path.join(dir, 'launcher.js'));

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
  let clockMs = 0;
  let nextFrameId = 0;
  const animationFrames = new Map();
  const contexts = [];
  class Ctx {
    constructor() { this.state = 'running'; this.currentTime = 0; this.closed = false; this.destination = {}; this.oscillators = []; contexts.push(this); }
    resume() { return Promise.resolve(); }
    close() { this.closed = true; this.state = 'closed'; return Promise.resolve(); }
    createGain() { return { gain: param(1), connect() {}, disconnect() {} }; }
    createOscillator() {
      const osc = { type: '', frequency: param(0), connect() {}, disconnect() {}, start() {}, stop() { osc.stopped = true; } };
      this.oscillators.push(osc);
      return osc;
    }
  }
  let intervals = [];
  let timeouts = [];
  let id = 0;
  const timers = {
    setTimeout: (fn, ms) => { id += 1; timeouts.push({ id, fn, ms }); return id; },
    clearTimeout: (tid) => { timeouts = timeouts.filter((t) => t.id !== tid); },
    setInterval: (fn, ms) => { id += 1; intervals.push({ id, fn, ms }); return id; },
    clearInterval: (tid) => { intervals = intervals.filter((t) => t.id !== tid); },
  };
  const calls = [];
  const graph = {};
  ['setSession', 'setRange', 'setAxis', 'setSpectrum', 'setSilent', 'setMarkers', 'draw', 'clear'].forEach((name) => {
    graph[name] = vi.fn((...args) => calls.push(['graph.' + name, ...args]));
  });
  let lastPlayback = null;
  const view = {
    root: {},
    graph,
    bind: vi.fn(),
    setFixedNoteOptions: vi.fn(),
    setTargetConfig: vi.fn(),
    setJudgment: vi.fn(),
    setRange: vi.fn(),
    setReference: vi.fn(),
    setStatus: vi.fn((info) => calls.push(['status', info.state])),
    showReading: vi.fn((s) => calls.push(['reading', s ? s.state : null])),
    setPlayback: vi.fn((state) => { lastPlayback = state; }),
    announce: vi.fn(),
  };
  const host = { contains: () => true };
  let controllerCallbacks = null;
  const controller = {
    state: 'hidden',
    start: vi.fn(async () => { controller.state = 'measuring'; controllerCallbacks.onState({ state: 'measuring' }); }),
    stop: vi.fn(() => {
      const was = controller.state;
      controller.state = 'hidden';
      if (was !== 'hidden') controllerCallbacks.onState({ state: 'hidden' });
    }),
    getState: () => controller.state,
    getStateCode: () => null,
    getSession: () => null,
    setDisplayRange: vi.fn(() => true),
  };
  const locks = [];
  const pendingLocks = [];
  const storage = { data: { ...(options.stored ? { portalTunerSettings: JSON.stringify(options.stored) } : {}) }, getItem(k) { return this.data[k] ?? null; }, setItem(k, v) { this.data[k] = String(v); } };
  const settingsStore = lib.settings.createSettingsStore(storage);
  const setPrefs = vi.spyOn(settingsStore, 'setPrefs');
  const body = createTunerBody({
    lib: { ...lib, settings: { ...lib.settings, createSettingsStore: () => settingsStore } },
    storage,
    now: () => clockMs,
    requestAnimationFrame: (callback) => {
      const frameId = ++nextFrameId;
      animationFrames.set(frameId, callback);
      return frameId;
    },
    cancelAnimationFrame: (frameId) => animationFrames.delete(frameId),
    isDocumentHidden: () => false,
    reload: vi.fn(),
    wakeLock: {
      request: () => {
        const lock = { released: false, release() { this.released = true; return Promise.resolve(); } };
        locks.push(lock);
        if (!options.deferWakeLock) return Promise.resolve(lock);
        return new Promise((resolve) => pendingLocks.push(() => resolve(lock)));
      },
    },
    createView: () => view,
    createController: (callbacks) => { controllerCallbacks = callbacks; return controller; },
    createPlaybackEngine: (callbacks) => lib.playback.createPlaybackEngine({ createContext: () => new Ctx(), ...timers, ...callbacks }),
    ...timers,
  });
  const state = { active: true };
  const startOptions = {
    host,
    generation: 1,
    guard: () => state.active,
    requestLeave: vi.fn(() => body.stop()),
    onUserRestart: vi.fn(),
    onMeasurementResume: vi.fn(),
    isScreenActive: () => state.active,
  };
  return {
    body, view, graph, controller, contexts, calls, locks, pendingLocks, state, startOptions, timers, storage, setPrefs,
    handlers: body.handlers,
    playbackView: () => lastPlayback,
    runIntervals: () => intervals.forEach((t) => t.fn()),
    runTimeouts: () => { const due = timeouts; timeouts = []; due.forEach((t) => t.fn()); },
    pendingTimeouts: () => timeouts.map((t) => t.ms),
    controllerCallbacks: () => controllerCallbacks,
    advanceTime: (ms) => { clockMs += ms; },
    runAnimationFrame: () => {
      // Run only this frame's callbacks; the body's next frame stays queued.
      const due = [...animationFrames.values()];
      animationFrames.clear();
      due.forEach((callback) => callback(clockMs));
    },
  };
}

const flush = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };

const legacyJudgments = [
  { temperament: 'major-third', rootMidi: 65 },
  { temperament: 'minor-third', rootMidi: 66 },
  { temperament: 'pythagorean', rootMidi: 60, pythagoreanStart: -3 },
  { temperament: 'custom', rootMidi: 60, customOffsets: [0, 0, 0, 0, 0, 0, 0, 0, 0, 20, 0, 0] },
];

function savedSettings(judgment, a4Tenths = 4400) {
  return { schemaVersion: 1, a4Tenths, persistSettings: true, prefs: { judgment, displayMode: 'detail' } };
}

function feedPitch(h, frequency) {
  for (let i = 0; i < 60; i += 1) {
    h.advanceTime(50); // allow the real display smoothing to settle across frames
    h.controllerCallbacks().onPitch({ valid: true, frequency, reason: 'ok' });
    h.runAnimationFrame(); // pitch delivery and rendering use separate callbacks in production
  }
  const [reading] = h.view.showReading.mock.calls.at(-1);
  expect(reading).toBeTruthy();
  return reading;
}

describe('equal-temperament measurement and fixed-note regression', () => {
  it.each(legacyJudgments)('restores $temperament settings as equal temperament', async (judgment) => {
    const h = harness({ stored: savedSettings(judgment) });
    await h.body.start(h.startOptions);
    expect(h.body.api.getA4()).toBe(440); // proves the valid saved settings were read
    expect(h.body.api.getPrefs().displayMode).toBe('detail');
    expect(h.view.setJudgment).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'equal', just: null }));
    expect(h.body.api.getTargetConfig().temperament).toBe('equal');
    const reading = feedPitch(h, 440);
    expect(Math.abs(reading.cents)).toBeLessThanOrEqual(0.5);
    expect(reading.judgment).toBe('in-tune');
    h.body.api.applyTargetConfig({ temperament: 'pythagorean' });
    expect(h.body.api.getTargetConfig().temperament).toBe('equal');
    expect(Math.abs(feedPitch(h, 440).cents)).toBeLessThanOrEqual(0.5);
    for (const name of ['onMode', 'onFreeze', 'onDetailToggle']) expect(h.handlers[name]).toBeUndefined();
  });

  it('selects, saves and clears a fixed equal-tempered note and builds its options once', async () => {
    const h = harness({ stored: savedSettings({ temperament: 'equal', fixedMidi: null }, 4420) });
    await h.body.start(h.startOptions);
    expect(feedPitch(h, 460).cents).toBeCloseTo(-30.9, 0);
    h.handlers.onTargetOption('fixedMidi', 69);
    expect(h.body.api.getTargetConfig()).toMatchObject({ temperament: 'equal', fixedMidi: 69 });
    expect(h.view.setTargetConfig).toHaveBeenLastCalledWith(expect.objectContaining({ fixedMidi: 69 }), expect.objectContaining({ perNote: true }));
    expect(h.setPrefs).toHaveBeenLastCalledWith(expect.objectContaining({ judgment: expect.objectContaining({ temperament: 'equal', fixedMidi: 69 }) }));
    expect(feedPitch(h, 460).cents).toBeCloseTo(69.1, 0);
    expect(JSON.parse(h.storage.data.portalTunerSettings).prefs.judgment.fixedMidi).toBe(69);
    const restored = harness({ stored: JSON.parse(h.storage.data.portalTunerSettings) });
    await restored.body.start(restored.startOptions);
    expect(restored.body.api.getTargetConfig()).toMatchObject({ temperament: 'equal', fixedMidi: 69 });
    expect(feedPitch(restored, 460).cents).toBeCloseTo(69.1, 0);
    h.handlers.onTargetOption('fixedMidi', null);
    expect(h.body.api.getTargetConfig().fixedMidi).toBeNull();
    expect(h.setPrefs).toHaveBeenLastCalledWith(expect.objectContaining({ judgment: expect.objectContaining({ fixedMidi: null }) }));
    expect(JSON.parse(h.storage.data.portalTunerSettings).prefs.judgment.fixedMidi).toBeNull();
    expect(feedPitch(h, 460).cents).toBeCloseTo(-30.9, 0);
    // Reusing this view must not rebuild the options.
    await h.body.start(h.startOptions);
    expect(h.view.setFixedNoteOptions).toHaveBeenCalledTimes(1);
    const [notes] = h.view.setFixedNoteOptions.mock.calls[0];
    expect(notes.map((note) => note.midi)).toEqual(Array.from({ length: lib.targetModel.MAX_MIDI - lib.targetModel.MIN_MIDI + 1 }, (_, i) => lib.targetModel.MIN_MIDI + i));
    expect(notes.find((note) => note.midi === 69).label).toBe('A4（ラ）');
  });

  it.each(legacyJudgments)('keeps saved fixedMidi when normalizing $temperament', async (judgment) => {
    const h = harness({ stored: savedSettings({ ...judgment, fixedMidi: 69 }, 4420) });
    await h.body.start(h.startOptions);
    expect(h.body.api.getTargetConfig()).toMatchObject({ temperament: 'equal', fixedMidi: 69 });
    expect(feedPitch(h, 460).cents).toBeCloseTo(69.1, 0);
  });

  it.each([10, 25, 50, 100])('preserves equal-temperament cents, tolerance and needle scale at ±%i', async (range) => {
    const stored = savedSettings({ temperament: 'equal' }, 4400);
    stored.prefs.meterRangeCents = range;
    const h = harness({ stored });
    await h.body.start(h.startOptions);
    const centered = feedPitch(h, 440);
    expect(centered).toMatchObject({ judgment: 'in-tune', centsRounded: 0 });
    expect(centered.needlePercent).toBeCloseTo(50, 8);
    const cents = 8;
    const reading = feedPitch(h, 440 * 2 ** (cents / 1200));
    expect(reading.cents).toBeCloseTo(cents, 6);
    expect(reading.judgment).toBe('sharp');
    expect(reading.needlePercent).toBeCloseTo(50 + 50 * cents / range, 6);
    expect(h.graph.setMarkers.mock.calls.at(-1)[0].equalTarget).toBe(0);
  });

  it.each([3, 5, 10])('keeps the ±%i cent tolerance and its one-cent exit hysteresis on both sides', async (tolerance) => {
    for (const direction of [-1, 1]) {
      const stored = savedSettings({ temperament: 'equal' });
      stored.prefs.toleranceCents = tolerance;
      const h = harness({ stored });
      await h.body.start(h.startOptions);
      const at = (cents) => feedPitch(h, 440 * 2 ** (direction * cents / 1200));
      const outside = direction < 0 ? 'flat' : 'sharp';
      expect(at(tolerance + 2).judgment).toBe(outside);
      expect(at(tolerance - 0.2).judgment).toBe('in-tune');
      expect(at(tolerance + 0.8).judgment).toBe('in-tune');
      expect(at(tolerance + 1.2).judgment).toBe(outside);
    }
  });

  it.each([-1, 1])('clamps only the needle, not fixed-note cents outside the meter (direction %i)', async (direction) => {
    const stored = savedSettings({ temperament: 'equal', fixedMidi: 69 });
    stored.prefs.meterRangeCents = 10;
    const h = harness({ stored });
    await h.body.start(h.startOptions);
    const reading = feedPitch(h, 440 * 2 ** (direction * 70 / 1200));
    expect(reading.cents).toBeCloseTo(direction * 70, 6);
    expect(reading.needleCents).toBe(direction * 10);
    expect(reading.needlePercent).toBe(direction < 0 ? 0 : 100);
    expect(reading.targetFrequency).toBe(440);
  });

  it('recalculates a fixed note after an A4 change without changing or losing the selection', async () => {
    const h = harness({ stored: savedSettings({ temperament: 'equal', fixedMidi: 69 }, 4420) });
    await h.body.start(h.startOptions);
    expect(feedPitch(h, 460).cents).toBeCloseTo(1200 * Math.log2(460 / 442), 6);
    h.handlers.onStep(1);
    const reading = h.view.showReading.mock.calls.at(-1)[0];
    expect(reading.targetFrequency).toBe(443);
    expect(reading.cents).toBeCloseTo(1200 * Math.log2(460 / 443), 6);
    expect(h.body.api.getA4Tenths()).toBe(4430);
    expect(h.body.api.getTargetConfig()).toMatchObject({ temperament: 'equal', fixedMidi: 69 });
    expect(JSON.parse(h.storage.data.portalTunerSettings)).toMatchObject({
      schemaVersion: 1, a4Tenths: 4430,
      prefs: { judgment: { temperament: 'equal', fixedMidi: 69 } },
    });
    expect(h.controller.start).toHaveBeenCalledTimes(1);
    expect(h.controller.stop).not.toHaveBeenCalled();
  });

  it('keeps fixed-note changes in memory when preference saving is off, while still saving A4', async () => {
    const h = harness();
    await h.body.start(h.startOptions);
    h.handlers.onTargetOption('fixedMidi', 69);
    expect(h.body.api.getTargetConfig().fixedMidi).toBe(69);
    expect(h.storage.data.portalTunerSettings).toBeUndefined();
    h.handlers.onStep(1);
    const saved = JSON.parse(h.storage.data.portalTunerSettings);
    expect(saved).toMatchObject({ schemaVersion: 1, a4Tenths: 4430, persistSettings: false });
    expect(saved.prefs).toBeUndefined();
    const restored = harness({ stored: saved });
    await restored.body.start(restored.startOptions);
    expect(restored.body.api.getA4()).toBe(443);
    expect(restored.body.api.getTargetConfig()).toMatchObject({ temperament: 'equal', fixedMidi: null });
  });
});

describe('tuner body: playback and measurement switching', () => {
  it('playing pauses measurement, releases the microphone path and clears old readings', async () => {
    const h = harness();
    await h.body.start(h.startOptions);
    expect(h.body.getState()).toBe('measuring');
    h.calls.length = 0;
    h.handlers.onPlay();
    expect(h.contexts).toHaveLength(1); // created synchronously in the tap
    expect(h.controller.stop).toHaveBeenCalled();
    expect(h.body.getState()).toBe('playing');
    expect(h.calls).toContainEqual(['graph.clear']);
    // Status "playing" is set after the measurement's own reset, then the
    // readout is cleared again so it shows the playing state.
    const statusAt = h.calls.findIndex((c) => c[0] === 'status' && c[1] === 'playing');
    expect(statusAt).toBeGreaterThan(-1);
    expect(h.calls.slice(statusAt).some((c) => c[0] === 'reading' && c[1] === null)).toBe(true);
    expect(h.playbackView().playing).toBe(true);
    await flush();
    expect(h.locks).toHaveLength(1); // wake lock while the tone plays
  });

  it('repeated play taps keep a single oscillator and context', async () => {
    const h = harness();
    await h.body.start(h.startOptions);
    h.handlers.onPlay();
    h.handlers.onPlay();
    h.handlers.onPlay();
    expect(h.contexts).toHaveLength(1);
    expect(h.contexts[0].oscillators).toHaveLength(1);
  });

  it('stop fades out and asks the launcher to resume measurement after the reverb delay', async () => {
    const h = harness();
    await h.body.start(h.startOptions);
    h.handlers.onPlay();
    await flush();
    h.handlers.onStop();
    expect(h.startOptions.onMeasurementResume).toHaveBeenCalledWith(POST_PLAYBACK_DELAY_MS);
    expect(POST_PLAYBACK_DELAY_MS).toBe(250);
    expect(h.body.getState()).toBe('hidden'); // measurement restart is the launcher's job
    expect(h.locks[0].released).toBe(true);
    expect(h.contexts[0].closed).toBe(false); // still fading
    h.runTimeouts();
    expect(h.contexts[0].closed).toBe(true);
    h.handlers.onStop(); // idempotent
    expect(h.startOptions.onMeasurementResume).toHaveBeenCalledTimes(1);
  });

  it('does not play when the tuner screen is not active', async () => {
    const h = harness();
    await h.body.start(h.startOptions);
    h.state.active = false;
    h.handlers.onPlay();
    expect(h.contexts).toHaveLength(0);
  });

  it('never plays an invalid frequency and keeps a playing tone on its last valid value', async () => {
    const h = harness();
    await h.body.start(h.startOptions);
    h.handlers.onPlaybackSource('hz');
    expect(h.playbackView().hzText).toBe('442.0'); // starts from the selected note (A4)
    h.handlers.onPlaybackHzInput('9999');
    expect(h.playbackView().error).toContain('28.0～4,700.0 Hz'); // design range
    h.handlers.onPlay();
    expect(h.contexts).toHaveLength(0);
    h.handlers.onPlaybackHzInput('');
    h.handlers.onPlay();
    expect(h.contexts).toHaveLength(0);
    h.handlers.onPlaybackHzInput('500.5');
    h.handlers.onPlay();
    expect(h.contexts).toHaveLength(1);
    const freq = h.contexts[0].oscillators[0].frequency.events;
    const before = freq.length;
    h.handlers.onPlaybackHzInput('abc');
    expect(freq.length).toBe(before); // invalid input never reaches the oscillator
    h.handlers.onPlaybackHzInput('600');
    expect(freq.at(-1)).toEqual(['exp', 600, lib.playback.FREQUENCY_GLIDE_SECONDS]);
  });

  it('note mode follows A4 changes while playing; Hz mode does not', async () => {
    const h = harness();
    await h.body.start(h.startOptions);
    h.handlers.onPlay(); // A4 note, 442 Hz
    const freq = h.contexts[0].oscillators[0].frequency.events;
    h.handlers.onStep(1); // A4 = 443 Hz
    expect(freq.at(-1)).toEqual(['exp', 443, lib.playback.FREQUENCY_GLIDE_SECONDS]);
    h.handlers.onPlaybackSource('hz'); // starts from the current note value 443.0
    const count = freq.length;
    h.handlers.onStep(1); // A4 = 444 Hz: Hz mode keeps 443.0
    expect(freq.length).toBe(count);
    expect(h.playbackView().summary).toContain('443.000 Hz');
  });

  it.each([28, 4700, 442.5])('preserves Hz playback at %s Hz, its decimal display and independence from A4', async (frequency) => {
    const h = harness();
    await h.body.start(h.startOptions);
    h.handlers.onPlaybackSource('hz');
    h.handlers.onPlaybackHzInput(frequency.toFixed(1));
    expect(h.playbackView().error).toBeFalsy();
    expect(h.playbackView().hzText).toBe(frequency.toFixed(1));
    h.handlers.onPlay();
    const events = h.contexts[0].oscillators[0].frequency.events;
    expect(events[0][1]).toBe(frequency);
    const before = events.length;
    h.handlers.onStep(1);
    expect(events).toHaveLength(before);
    expect(h.playbackView().summary).toContain(frequency.toFixed(3) + ' Hz');
    h.handlers.onStop();
    h.runTimeouts();
    expect(h.contexts[0].closed).toBe(true);
  });

  it.each(['27.9', '4700.1', '442.25'])('refuses invalid Hz playback %s without stopping measurement', async (text) => {
    const h = harness();
    await h.body.start(h.startOptions);
    h.handlers.onPlaybackSource('hz');
    h.handlers.onPlaybackHzInput(text);
    h.handlers.onPlay();
    expect(h.playbackView().error).toBeTruthy();
    expect(h.contexts).toHaveLength(0);
    expect(h.controller.stop).not.toHaveBeenCalled();
    expect(h.body.getState()).toBe('measuring');
  });

  it('a full stop (leave, background, logout) ends tone and measurement and is idempotent', async () => {
    const h = harness();
    await h.body.start(h.startOptions);
    h.handlers.onPlay();
    await flush();
    h.body.stop();
    h.body.stop();
    expect(h.contexts[0].closed).toBe(true);
    expect(h.body.getState()).toBe('hidden');
    expect(h.locks[0].released).toBe(true);
  });

  it('safety net: a playing tone is released when the screen stops showing', async () => {
    const h = harness();
    await h.body.start(h.startOptions);
    h.handlers.onPlay();
    h.state.active = false;
    h.runIntervals();
    expect(h.startOptions.requestLeave).toHaveBeenCalledWith('guard');
    expect(h.contexts[0].closed).toBe(true);
  });

  it('an interrupted tone (phone call) leads to "tap to resume" without restarting by itself', async () => {
    const h = harness();
    await h.body.start(h.startOptions);
    h.handlers.onPlay();
    h.contexts[0].state = 'interrupted';
    h.contexts[0].onstatechange();
    expect(h.view.setStatus).toHaveBeenLastCalledWith({ state: 'resume-required' });
    expect(h.startOptions.onMeasurementResume).not.toHaveBeenCalled();
    expect(h.body.getState()).toBe('hidden');
  });

  it('switching the display range informs the graph at once and the worker with a new axis id', async () => {
    const h = harness();
    await h.body.start(h.startOptions);
    h.handlers.onRange('full');
    const [request] = h.controller.setDisplayRange.mock.calls.at(-1);
    expect(request).toMatchObject({ min: 25, max: 16000 });
    expect(h.graph.setRange).toHaveBeenLastCalledWith('full', request.axisId);
    h.handlers.onRange('harmonics');
    const [second] = h.controller.setDisplayRange.mock.calls.at(-1);
    expect(second).toMatchObject({ min: 500, max: 16000 });
    expect(second.axisId).toBeGreaterThan(request.axisId);
    expect(h.controllerCallbacks().getDisplayRange()).toEqual(second); // used by the next start
  });

  it('a late wake-lock answer from an earlier playback is released at once', async () => {
    const h = harness({ deferWakeLock: true });
    await h.body.start(h.startOptions);
    h.handlers.onPlay(); // request 1 pending
    h.handlers.onStop();
    h.handlers.onPlay(); // request 2 pending
    expect(h.locks).toHaveLength(2);
    h.pendingLocks[0](); // request 1 resolves late: its playback is over
    await flush();
    expect(h.locks[0].released).toBe(true);
    h.pendingLocks[1]();
    await flush();
    expect(h.locks[1].released).toBe(false); // held for the current playback
    h.body.stop();
    expect(h.locks.map((lock) => lock.released)).toEqual([true, true]);
  });

  it('a wake-lock answer arriving after the playback ended is released', async () => {
    const h = harness({ deferWakeLock: true });
    await h.body.start(h.startOptions);
    h.handlers.onPlay();
    h.body.stop(); // leave before the wake lock is granted
    h.pendingLocks[0]();
    await flush();
    expect(h.locks[0].released).toBe(true);
  });

  it('an A4 change re-judges against the new target instead of keeping "in tune"', async () => {
    const h = harness();
    await h.body.start(h.startOptions);
    const target442 = 442;
    expect(feedPitch(h, target442).judgment).toBe('in-tune');
    h.handlers.onStep(1); // A4 442 -> 443 Hz
    const shown = h.view.showReading.mock.calls.filter((c) => c[0]).at(-1)[0];
    expect(shown.cents).toBeCloseTo(1200 * Math.log2(target442 / 443), 6);
    expect(shown.cents).toBeCloseTo(-3.91, 2);
    expect(shown.judgment).toBe('flat'); // beyond ±3 for the new target
  });
});

describe('tuner body + launcher: playback and the delayed measurement restart', () => {
  function combined() {
    const h = harness();
    // The launcher verifies every main module release before starting the body.
    MAIN_MODULES.forEach((name) => { lib.releases[name] = h.body.release; });
    const primed = [];
    class PrimedContext {
      constructor() { this.state = 'suspended'; primed.push(this); }
      resume() { this.state = 'running'; return Promise.resolve(); }
      close() { this.state = 'closed'; return Promise.resolve(); }
    }
    const launcher = createTunerLauncher({
      release: h.body.release,
      isAllowed: () => true,
      AudioContext: PrimedContext,
      getBody: () => h.body,
      loadAssets: () => Promise.resolve(),
      hostVisible: () => true,
      isDocumentVisible: () => true,
      renderFallback: () => {},
      setTimeout: h.timers.setTimeout,
      clearTimeout: h.timers.clearTimeout,
    });
    return { ...h, launcher, primed, host: { contains: () => true } };
  }

  it('playing again within 250 ms of stop cancels the restart: tone plays, microphone stays off', async () => {
    const c = combined();
    c.launcher.prime();
    await c.launcher.enter(c.host);
    expect(c.controller.start).toHaveBeenCalledTimes(1);
    c.handlers.onPlay();
    expect(c.body.getState()).toBe('playing');
    c.handlers.onStop(); // schedules the restart and primes a context
    expect(c.pendingTimeouts()).toContain(POST_PLAYBACK_DELAY_MS);
    const stopTapContext = c.primed.at(-1);
    c.handlers.onPlay(); // within the delay
    expect(c.pendingTimeouts()).not.toContain(POST_PLAYBACK_DELAY_MS);
    expect(stopTapContext.state).toBe('closed');
    c.runTimeouts(); // whatever is left (playback fade clean-up) runs
    await flush();
    expect(c.body.getState()).toBe('playing');
    expect(c.controller.start).toHaveBeenCalledTimes(1);
    expect(c.controller.state).toBe('hidden');
  });

  it('even a start reaching the body while the tone plays does not start measurement', async () => {
    const c = combined();
    c.launcher.prime();
    await c.launcher.enter(c.host);
    c.handlers.onPlay();
    const handed = { state: 'running', close() { this.state = 'closed'; return Promise.resolve(); } };
    await c.body.start({ ...c.startOptions, generation: 99, audioContext: handed });
    expect(c.controller.start).toHaveBeenCalledTimes(1);
    expect(handed.state).toBe('closed');
    expect(c.body.getState()).toBe('playing');
  });

  it('stop without playing again still restarts measurement after the delay', async () => {
    const c = combined();
    c.launcher.prime();
    await c.launcher.enter(c.host);
    c.handlers.onPlay();
    c.handlers.onStop();
    c.runTimeouts();
    await flush();
    expect(c.controller.start).toHaveBeenCalledTimes(2);
    expect(c.body.getState()).toBe('measuring');
  });
});

