import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const root = process.cwd();
const dir = path.join(root, 'src/static/js/modules/tuner');
const lib = {
  music: require(path.join(dir, 'music.js')),
  temperament: require(path.join(dir, 'temperament.js')),
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
    setFixedNoteOptions: vi.fn(), setTargetConfig: vi.fn(),
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
  const storage = { data: { ...options.storageData }, getItem(k) { return this.data[k] ?? null; }, setItem(k, v) { this.data[k] = String(v); } };
  const body = createTunerBody({
    lib,
    storage,
    now: () => 0,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
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
    body, storage, view, graph, controller, contexts, calls, locks, pendingLocks, state, startOptions, timers,
    handlers: body.handlers,
    playbackView: () => lastPlayback,
    runIntervals: () => intervals.forEach((t) => t.fn()),
    runTimeouts: () => { const due = timeouts; timeouts = []; due.forEach((t) => t.fn()); },
    pendingTimeouts: () => timeouts.map((t) => t.ms),
    controllerCallbacks: () => controllerCallbacks,
  };
}

const flush = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };

describe('tuner body: playback and measurement switching', () => {
  it('starts measuring with saved detail preferences and rounds the stored A4', async () => {
    const h = harness({ storageData: {
      portalTunerSettings: JSON.stringify({ schemaVersion: 1, a4Tenths: 4425, persistSettings: true, prefs: { displayMode: 'detail' } }),
    } });
    await h.body.start(h.startOptions);
    expect(h.controller.getState()).toBe('measuring');
    expect(h.view.setReference.mock.calls.at(-1)[0]).toBe(443);
    expect(h.body.api.getA4()).toBe(443);
    expect(h.body.api.getA4Tenths()).toBe(4430);
    expect(h.body.handlers.onDetailToggle).toBeUndefined();
    expect(h.body.handlers.onFreeze).toBeUndefined();
  });

  it('announces A4 changes in integer Hz', async () => {
    const h = harness();
    await h.body.start(h.startOptions);
    h.body.handlers.onStep(10);
    expect(h.view.announce).toHaveBeenCalledWith('基準周波数 A4 = 443 Hz');
  });

  it('keeps note playback following rounded A4 and fractional Hz playback independent', async () => {
    const h = harness({ storageData: {
      portalTunerSettings: JSON.stringify({ schemaVersion: 1, a4Tenths: 4425 }),
    } });
    await h.body.start(h.startOptions);
    // The sound tab keeps its existing one-decimal A4 summary.
    expect(h.playbackView().summary).toContain('A4基準 443.0 Hz');
    h.handlers.onPlay();
    const freq = h.contexts[0].oscillators[0].frequency.events;
    expect(freq[0][1]).toBe(443);
    h.handlers.onStep(10);
    expect(freq.at(-1)).toEqual(['exp', 444, lib.playback.FREQUENCY_GLIDE_SECONDS]);
    expect(h.playbackView().summary).toContain('A4基準 444.0 Hz');
    h.handlers.onPlaybackSource('hz');
    h.handlers.onPlaybackHzInput('500.5');
    expect(freq.at(-1)).toEqual(['exp', 500.5, lib.playback.FREQUENCY_GLIDE_SECONDS]);
    expect(h.playbackView().error).toBeNull();
    const count = freq.length;
    h.handlers.onStep(10);
    expect(freq).toHaveLength(count);
    expect(h.playbackView().summary).toContain('500.500 Hz');
  });

  it('refused measuring A4 input leaves the reference and playing note unchanged', async () => {
    const h = harness();
    await h.body.start(h.startOptions);
    h.handlers.onPlay();
    const freq = h.contexts[0].oscillators[0].frequency.events;
    const count = freq.length;
    for (const text of ['389', '481', '442.5', '442.0']) {
      h.handlers.onA4Input(text);
      expect(h.body.api.getA4()).toBe(442);
      expect(h.body.api.getA4Tenths()).toBe(4420);
      expect(h.view.setReference.mock.calls.at(-1)[0]).toBe(442);
      expect(freq).toHaveLength(count);
      expect(h.playbackView().summary).toContain('A4基準 442.0 Hz');
    }
    h.handlers.onA4Input('４４３');
    expect(h.body.api.getA4Tenths()).toBe(4430);
    expect(freq.at(-1)).toEqual(['exp', 443, lib.playback.FREQUENCY_GLIDE_SECONDS]);
    expect(h.playbackView().summary).toContain('A4基準 443.0 Hz');
  });

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
    h.handlers.onStep(10); // A4 = 443.0 (ten 0.1 Hz steps)
    expect(freq.at(-1)).toEqual(['exp', 443, lib.playback.FREQUENCY_GLIDE_SECONDS]);
    h.handlers.onPlaybackSource('hz'); // starts from the current note value 443.0
    const count = freq.length;
    h.handlers.onStep(10); // A4 = 444.0: Hz mode keeps 443.0
    expect(freq.length).toBe(count);
    expect(h.playbackView().summary).toContain('443.000 Hz');
  });

  it('keeps direct Hz independent of A4 and leaves legacy copy handlers inert', async () => {
    const h = harness();
    await h.body.start(h.startOptions);
    h.handlers.onPlaybackSource('hz');
    h.handlers.onPlaybackHzInput('333.3');
    h.handlers.onSetPlaybackFromTarget();
    h.handlers.onSetPlaybackFromRoot();
    expect(h.contexts).toHaveLength(0);
    expect(h.playbackView().summary).toContain('333.300 Hz');
    h.handlers.onPlay();
    const events = h.contexts[0].oscillators[0].frequency.events;
    expect(events[0][1]).toBe(333.3);
    h.handlers.onStep(10);
    expect(events).toHaveLength(1);
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

  it('passes equal judgment on first start and restart without a target model', async () => {
    expect(lib.targetModel).toBeUndefined();
    const globalModel = globalThis.PortalTunerLib.targetModel;
    delete globalThis.PortalTunerLib.targetModel;
    const setJudgment = vi.fn();
    const setTarget = vi.fn();
    const original = lib.displayFilter.createDisplayFilter;
    const spy = vi.spyOn(lib.displayFilter, 'createDisplayFilter').mockImplementation((options) => {
      const filter = original(options);
      const apply = filter.setJudgment;
      filter.setJudgment = (...args) => { setJudgment(...args); return apply(...args); };
      const applyTarget = filter.setTarget;
      filter.setTarget = (...args) => { setTarget(...args); return applyTarget(...args); };
      return filter;
    });
    try {
      const h = harness({ storageData: {
        portalTunerSettings: JSON.stringify({ schemaVersion: 1, a4Tenths: 4420, persistSettings: true, prefs: { judgment: { mode: 'major-third', temperament: 'minor-third', rootMidi: 65 } } }),
      } });
      expect(globalThis.PortalTunerLib.targetModel).toBeUndefined();
      expect(h.body.api.getTargetConfig().temperament).toBe('equal'); // constructor restoration
      await h.body.start(h.startOptions);
      expect(setJudgment.mock.calls.at(-1)[0].mode).toBe('equal');
      expect(setTarget).not.toHaveBeenCalled(); // proves the model-backed branch was not used
      h.body.stop();
      h.storage.data.portalTunerSettings = JSON.stringify({ schemaVersion: 1, a4Tenths: 4420, persistSettings: true,
        prefs: { judgment: { mode: 'minor-third', temperament: 'major-third', rootMidi: 57 } },
      });
      await h.body.start(h.startOptions);
      expect(setJudgment).toHaveBeenCalledTimes(2);
      expect(setJudgment.mock.calls.every(([config]) => config.mode === 'equal')).toBe(true);
      expect(setTarget).not.toHaveBeenCalled();
      expect(h.body.api.getTargetConfig().temperament).toBe('equal');
      expect(h.view.setJudgment.mock.calls.at(-1)[0]).toMatchObject({ mode: 'equal', just: null });
      for (const name of ['onMode', 'onTemperament', 'onRoot', 'onCustomOffset']) expect(h.handlers[name]).toBeUndefined();
    } finally {
      spy.mockRestore();
      if (globalModel !== undefined) globalThis.PortalTunerLib.targetModel = globalModel;
    }
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
    let now = 0;
    for (let i = 0; i < 40; i += 1) {
      now += 50;
      h.controllerCallbacks().onPitch({ valid: true, frequency: target442, reason: 'ok' });
    }
    h.handlers.onStep(10); // A4 442.0 -> 443.0 (ten 0.1 Hz steps)
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

