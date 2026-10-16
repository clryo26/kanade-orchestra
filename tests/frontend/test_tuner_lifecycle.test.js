import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const root = process.cwd();
const { createTunerController } = require(path.join(root, 'src/static/js/modules/tuner/controller.js'));
const { createTunerLauncher } = require(path.join(root, 'src/static/js/modules/tuner/launcher.js'));

const RELEASE = 't-test-release';
const flush = async (rounds = 6) => { for (let i = 0; i < rounds; i += 1) await Promise.resolve(); };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function domError(name) {
  const error = new Error(name);
  error.name = name;
  return error;
}

// ----- Fake browser audio environment ----------------------------------

function createFakeEnv(options = {}) {
  const log = { contexts: [], streams: [], workers: [], nodes: [], channels: [], gumCalls: [], wakeLocks: [] };
  let now = 0;
  let timers = [];
  let timerId = 0;
  const clock = {
    now: () => now,
    setTimeout: (fn, ms) => { timerId += 1; timers.push({ id: timerId, at: now + ms, fn }); return timerId; },
    clearTimeout: (id) => { timers = timers.filter((t) => t.id !== id); },
    setInterval: (fn, ms) => { timerId += 1; timers.push({ id: timerId, at: now + ms, fn, every: ms }); return timerId; },
    clearInterval: (id) => { timers = timers.filter((t) => t.id !== id); },
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        now = due.at;
        if (due.every) due.at += due.every; else timers = timers.filter((t) => t !== due);
        due.fn();
        await flush();
      }
      now = target;
      await flush();
    },
  };

  class FakePort {
    constructor() { this.onmessage = null; this.closed = false; this.sent = []; }
    postMessage(message) { this.sent.push(message); }
    close() { this.closed = true; }
    deliver(data) { if (this.onmessage && !this.closed) this.onmessage({ data }); }
  }

  class FakeAudioContext {
    constructor() {
      this.state = 'suspended';
      this.sampleRate = 48000;
      this.resumeCalls = 0;
      this.closeCalls = 0;
      this.onstatechange = null;
      this.destination = { kind: 'destination' };
      this.audioWorklet = {
        addModule: () => (options.addModule ? options.addModule() : Promise.resolve()),
      };
      log.contexts.push(this);
    }
    resume() {
      this.resumeCalls += 1;
      if (options.resumeBlocked) return new Promise(() => {});
      if (this.state !== 'closed') this.state = 'running';
      return Promise.resolve();
    }
    close() { this.closeCalls += 1; this.state = 'closed'; return Promise.resolve(); }
    createGain() {
      const node = { gain: { value: 1 }, connections: [], connect(target) { node.connectedWhenGainWas = node.gain.value; node.connections.push(target); }, disconnect() { node.disconnected = true; } };
      return node;
    }
    createMediaStreamSource(stream) {
      return { stream, connect() {}, disconnect() { this.disconnected = true; } };
    }
  }

  class FakeAudioWorkletNode {
    constructor(ctx, name, opts) {
      this.ctx = ctx;
      this.name = name;
      this.options = opts;
      this.port = new FakePort();
      this.disconnected = false;
      log.nodes.push(this);
      const processorOptions = opts.processorOptions;
      if (!options.workletSilent) {
        queueMicrotask(() => this.port.deliver({
          type: options.workletMismatch ? 'version-mismatch' : 'ready',
          release: options.workletMismatch ? 'other' : processorOptions.release,
          protocol: processorOptions.protocol,
          generation: processorOptions.generation,
        }));
      }
    }
    connect() {}
    disconnect() { this.disconnected = true; }
  }

  class FakeWorker {
    constructor(url) {
      this.url = url;
      this.onmessage = null;
      this.onerror = null;
      this.terminated = false;
      this.sent = [];
      log.workers.push(this);
    }
    postMessage(message) {
      this.sent.push(message);
      if (message.type === 'init' && !options.workerSilent) {
        queueMicrotask(() => this.emit({
          type: options.workerMismatch ? 'version-mismatch' : 'ready',
          release: options.workerMismatch ? 'other' : message.release,
          protocol: message.protocol,
          generation: message.generation,
          session: { sampleRate: message.sampleRate, fftSize: 16384, window: 'hann' },
        }));
      }
    }
    emit(data) { if (this.onmessage && !this.terminated) this.onmessage({ data }); }
    terminate() { this.terminated = true; }
  }

  class FakeMessageChannel {
    constructor() { this.port1 = new FakePort(); this.port2 = new FakePort(); log.channels.push(this); }
  }

  function makeStream() {
    const track = {
      readyState: 'live',
      stopCalls: 0,
      onended: null,
      onmute: null,
      stop() { this.stopCalls += 1; this.readyState = 'ended'; },
      getSettings: () => ({ echoCancellation: false, noiseSuppression: true }),
    };
    const stream = { track, getTracks: () => [track], getAudioTracks: () => [track] };
    log.streams.push(stream);
    return stream;
  }

  const mediaDevices = {
    getUserMedia(constraints) {
      log.gumCalls.push(constraints);
      if (options.getUserMedia) return options.getUserMedia(makeStream);
      return Promise.resolve(makeStream());
    },
  };

  const env = {
    isSecureContext: options.isSecureContext !== false,
    mediaDevices,
    AudioContext: FakeAudioContext,
    AudioWorkletNode: options.noWorklet ? undefined : FakeAudioWorkletNode,
    Worker: FakeWorker,
    MessageChannel: FakeMessageChannel,
    wakeLock: {
      request: () => {
        const lock = { released: false, release() { this.released = true; return Promise.resolve(); } };
        log.wakeLocks.push(lock);
        return options.wakeLockFails ? Promise.reject(domError('NotAllowedError')) : Promise.resolve(lock);
      },
    },
    ...clock,
  };
  return { env, log, clock, FakeAudioContext };
}

function createHarness(options = {}) {
  const fake = createFakeEnv(options);
  const events = { states: [], pitches: [], gaps: 0, leaves: [] };
  let allowed = true;
  const controller = createTunerController({
    env: fake.env,
    release: RELEASE,
    urls: { worklet: '/w.js', worker: '/a.js' },
    guard: () => allowed,
    requestLeave: (reason) => { events.leaves.push(reason); controller.stop(); },
    onState: (info) => events.states.push(info.code ? `${info.state}:${info.code}` : info.state),
    onPitch: (frame) => events.pitches.push(frame),
    onGap: () => { events.gaps += 1; },
  });
  return { ...fake, controller, events, setAllowed: (value) => { allowed = value; } };
}

function expectAllReleased(log) {
  for (const stream of log.streams) expect(stream.track.stopCalls).toBeGreaterThanOrEqual(1);
  for (const ctx of log.contexts) expect(ctx.state).toBe('closed');
  for (const worker of log.workers) expect(worker.terminated).toBe(true);
  for (const node of log.nodes) expect(node.disconnected).toBe(true);
  for (const lock of log.wakeLocks) expect(lock.released).toBe(true);
}

// ----- Controller -------------------------------------------------------

describe('tuner controller lifecycle', () => {
  it('starts, builds a silent graph, and releases everything on stop (idempotent)', async () => {
    const h = createHarness();
    await h.controller.start({ generation: 1 });
    expect(h.controller.getState()).toBe('measuring');
    expect(h.events.states).toEqual(['starting', 'measuring']);
    const constraints = h.log.gumCalls[0].audio;
    expect(constraints).toMatchObject({ echoCancellation: false, noiseSuppression: false, autoGainControl: false });
    const node = h.log.nodes[0];
    expect(node.options).toMatchObject({ numberOfOutputs: 1 });
    // Worklet and Worker each received one end of the same channel.
    const channel = h.log.channels[0];
    expect(node.port.sent[0]).toMatchObject({ type: 'connect', port: channel.port1 });
    expect(h.log.workers[0].sent[0]).toMatchObject({ type: 'init', port: channel.port2, generation: 1, release: RELEASE });
    // Only confirmed microphone settings are reported as disabled.
    expect(h.controller.getSession().microphone).toMatchObject({ echoCancellation: 'disabled', noiseSuppression: 'enabled', autoGainControl: 'unconfirmed' });
    expect(h.log.wakeLocks).toHaveLength(1);
    h.controller.stop();
    h.controller.stop();
    expect(h.controller.getState()).toBe('hidden');
    expectAllReleased(h.log);
    expect(channel.port1.closed && channel.port2.closed).toBe(true);
    expect(h.events.states.filter((s) => s === 'hidden')).toHaveLength(1);
  });

  it('keeps the gain at zero before connecting it', async () => {
    const h = createHarness();
    const original = h.FakeAudioContext.prototype.createGain;
    let gainNode;
    h.FakeAudioContext.prototype.createGain = function () { gainNode = original.call(this); return gainNode; };
    await h.controller.start({ generation: 1 });
    expect(gainNode.connectedWhenGainWas).toBe(0);
    expect(gainNode.connections[0]).toMatchObject({ kind: 'destination' });
    h.controller.stop();
  });

  it('uses the AudioContext primed by the tap instead of creating one', async () => {
    const h = createHarness();
    const primed = new h.FakeAudioContext();
    await h.controller.start({ generation: 1, audioContext: primed });
    expect(h.log.contexts).toHaveLength(1);
    expect(h.controller.getState()).toBe('measuring');
    h.controller.stop();
    expect(primed.state).toBe('closed');
  });

  it('stops a microphone granted after the user already left', async () => {
    const gum = deferred();
    const h = createHarness({ getUserMedia: (make) => gum.promise.then(() => make()) });
    const starting = h.controller.start({ generation: 1 });
    await flush();
    expect(h.controller.getState()).toBe('starting');
    h.controller.stop(); // leave while the permission prompt is open
    gum.resolve();
    await starting;
    await flush();
    expect(h.controller.getState()).toBe('hidden');
    expect(h.log.streams).toHaveLength(1);
    expect(h.log.streams[0].track.stopCalls).toBe(1);
    expectAllReleased(h.log);
    expect(h.log.nodes).toHaveLength(0);
  });

  it('ignores a duplicate start of the same generation', async () => {
    const h = createHarness();
    const first = h.controller.start({ generation: 1 });
    const second = h.controller.start({ generation: 1 });
    await Promise.all([first, second]);
    expect(h.log.gumCalls).toHaveLength(1);
    expect(h.log.contexts).toHaveLength(1);
    expect(h.log.workers).toHaveLength(1);
    h.controller.stop();
  });

  it('re-entering during start releases the older run, including its late microphone', async () => {
    const pending = [];
    const h = createHarness({ getUserMedia: (make) => { const d = deferred(); pending.push(d); return d.promise.then(() => make()); } });
    const older = h.controller.start({ generation: 1 });
    await flush();
    const newer = h.controller.start({ generation: 2 });
    await flush();
    pending[1].resolve();
    await newer;
    pending[0].resolve();
    await older;
    await flush();
    expect(h.controller.getState()).toBe('measuring');
    expect(h.controller.getGeneration()).toBe(2);
    expect(h.log.streams[0].track.stopCalls + h.log.streams[1].track.stopCalls).toBe(1);
    expect(h.log.contexts[0].state).toBe('closed');
    expect(h.log.workers[0].terminated).toBe(true);
    h.controller.stop();
  });

  it('drops analysis results from an older generation or another release', async () => {
    const h = createHarness();
    await h.controller.start({ generation: 5 });
    const worker = h.log.workers[0];
    worker.emit({ type: 'pitch', release: RELEASE, protocol: 1, generation: 4, frame: { valid: true } });
    expect(h.events.pitches).toHaveLength(0);
    worker.emit({ type: 'pitch', release: RELEASE, protocol: 1, generation: 5, frame: { valid: true, frequency: 440 } });
    expect(h.events.pitches).toHaveLength(1);
    worker.emit({ type: 'gap', release: RELEASE, protocol: 1, generation: 5, droppedFrames: 128 });
    expect(h.events.gaps).toBe(1);
    worker.emit({ type: 'pitch', release: 'other-release', protocol: 1, generation: 5, frame: {} });
    expect(h.controller.getState()).toBe('unavailable');
    expect(h.controller.getStateCode()).toBe('version-mismatch');
    expectAllReleased(h.log);
  });

  it.each([
    ['NotAllowedError', 'denied'],
    ['NotFoundError', 'not-found'],
    ['NotReadableError', 'unreadable'],
    ['AbortError', 'unreadable'],
    ['OverconstrainedError', 'not-found'],
  ])('maps getUserMedia %s to "%s" and releases resources', async (name, code) => {
    const h = createHarness({ getUserMedia: () => Promise.reject(domError(name)) });
    await h.controller.start({ generation: 1 });
    expect(h.controller.getState()).toBe('unavailable');
    expect(h.controller.getStateCode()).toBe(code);
    expectAllReleased(h.log);
  });

  it('reports failures at each preparation stage and releases resources', async () => {
    const cases = [
      [{ addModule: () => Promise.reject(domError('AbortError')) }, 'load-failed'],
      [{ workletMismatch: true }, 'version-mismatch'],
      [{ workerMismatch: true }, 'version-mismatch'],
      [{ isSecureContext: false }, 'insecure'],
      [{ noWorklet: true }, 'unsupported'],
    ];
    for (const [options, code] of cases) {
      const h = createHarness(options);
      await h.controller.start({ generation: 1 });
      expect(h.controller.getStateCode(), JSON.stringify(options)).toBe(code);
      expectAllReleased(h.log);
    }
  });

  it('times out when the worklet or worker never becomes ready', async () => {
    for (const option of ['workletSilent', 'workerSilent']) {
      const h = createHarness({ [option]: true });
      const starting = h.controller.start({ generation: 1 });
      await flush(40); // let start() reach its ready timeout before moving the clock
      await h.clock.advance(7000);
      await starting;
      expect(h.controller.getStateCode(), option).toBe('load-failed');
      expectAllReleased(h.log);
    }
  });

  it('asks for a tap instead of failing when the browser keeps audio suspended', async () => {
    const h = createHarness({ resumeBlocked: true });
    const starting = h.controller.start({ generation: 1 });
    await flush(40);
    await h.clock.advance(1500);
    await starting;
    expect(h.controller.getState()).toBe('resume-required');
    expect(h.events.states.at(-1)).toBe('resume-required:resume-required');
    expectAllReleased(h.log);
  });

  it('leaves through the guard when the screen is no longer valid during start', async () => {
    const gum = deferred();
    const h = createHarness({ getUserMedia: (make) => gum.promise.then(() => make()) });
    const starting = h.controller.start({ generation: 1 });
    await flush();
    h.setAllowed(false); // e.g. hidden panel, logged out, lost admin rights
    gum.resolve();
    await starting;
    await flush();
    expect(h.events.leaves).toContain('guard');
    expect(h.controller.getState()).toBe('hidden');
    expectAllReleased(h.log);
  });

  it('safety net: the watchdog releases resources when the guard fails while measuring', async () => {
    const h = createHarness();
    await h.controller.start({ generation: 1 });
    h.setAllowed(false);
    await h.clock.advance(600);
    expect(h.events.leaves).toContain('guard');
    expectAllReleased(h.log);
  });

  it('safety net: every worker message re-checks the guard', async () => {
    const h = createHarness();
    await h.controller.start({ generation: 1 });
    h.setAllowed(false);
    h.log.workers[0].emit({ type: 'status', release: RELEASE, protocol: 1, generation: 1 });
    expect(h.events.leaves).toContain('guard');
    expectAllReleased(h.log);
  });

  it('treats stalled audio and interruptions as "tap to resume" without automatic retries', async () => {
    const stalled = createHarness();
    await stalled.controller.start({ generation: 1 });
    await stalled.clock.advance(3600);
    expect(stalled.controller.getState()).toBe('resume-required');
    expectAllReleased(stalled.log);

    const ended = createHarness();
    await ended.controller.start({ generation: 1 });
    ended.log.streams[0].track.onended();
    expect(ended.controller.getState()).toBe('resume-required');
    await ended.clock.advance(10000);
    expect(ended.log.gumCalls).toHaveLength(1);
    expectAllReleased(ended.log);

    const interrupted = createHarness();
    await interrupted.controller.start({ generation: 1 });
    const ctx = interrupted.log.contexts[0];
    ctx.state = 'interrupted';
    ctx.onstatechange();
    expect(interrupted.controller.getState()).toBe('resume-required');
  });

  it('never touches audio or the microphone when the guard already fails at start', async () => {
    const h = createHarness();
    h.setAllowed(false); // e.g. parent panel hidden while the tab itself is "shown"
    const primed = new h.FakeAudioContext();
    await h.controller.start({ generation: 1, audioContext: primed });
    expect(h.log.gumCalls).toHaveLength(0);
    expect(h.log.workers).toHaveLength(0);
    expect(h.log.contexts).toHaveLength(1); // only the primed one, now closed
    expect(primed.state).toBe('closed');
    expect(h.events.leaves).toContain('guard');
  });

  it('keeps measuring when Wake Lock is refused', async () => {
    const h = createHarness({ wakeLockFails: true });
    await h.controller.start({ generation: 1 });
    await flush();
    expect(h.controller.getState()).toBe('measuring');
    h.controller.stop();
  });
});

// ----- Launcher -------------------------------------------------------

function createLauncherHarness(options = {}) {
  const contexts = [];
  class PrimedContext {
    constructor() { this.state = 'suspended'; this.resumeCalls = 0; contexts.push(this); }
    resume() { this.resumeCalls += 1; return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
  }
  let bodyLoaded = false;
  const loads = [];
  const fallbacks = [];
  const state = { allowed: true, visible: true, hostVisible: true, bodyState: 'hidden' };
  const body = {
    starts: [],
    stops: 0,
    errors: [],
    verifyRelease: vi.fn(() => ({ ok: !options.mismatch })),
    start: vi.fn(async (opts) => { body.starts.push(opts); state.bodyState = 'measuring'; }),
    stop: vi.fn(() => { body.stops += 1; state.bodyState = 'hidden'; }),
    showError: vi.fn((host, code) => body.errors.push(code)),
    getState: () => state.bodyState,
  };
  const launcher = createTunerLauncher({
    release: RELEASE,
    isAllowed: () => state.allowed,
    AudioContext: PrimedContext,
    getBody: () => (bodyLoaded ? body : null),
    loadAssets: () => {
      const d = deferred();
      loads.push(d);
      return d.promise.then(() => { bodyLoaded = true; });
    },
    hostVisible: () => state.hostVisible,
    isDocumentVisible: () => state.visible,
    renderFallback: (host, kind) => fallbacks.push(kind),
  });
  return { launcher, contexts, loads, fallbacks, body, state, host: { id: 'host' } };
}

describe('tuner launcher (first tap and generations)', () => {
  it('creates and resumes the AudioContext synchronously inside the tap', () => {
    const h = createLauncherHarness();
    const generation = h.launcher.prime();
    // No await happened: the context exists and resume() was already called.
    expect(h.contexts).toHaveLength(1);
    expect(h.contexts[0].resumeCalls).toBe(1);
    expect(generation).toBe(1);
  });

  it('does not prime without permission and never during preload', async () => {
    const h = createLauncherHarness();
    h.state.allowed = false;
    expect(h.launcher.prime()).toBeNull();
    h.state.allowed = true;
    const preloading = h.launcher.preload();
    h.loads[0].resolve();
    expect(await preloading).toBe(true);
    expect(h.contexts).toHaveLength(0);
  });

  it('hands the primed context and generation to the lazily loaded body', async () => {
    const h = createLauncherHarness();
    const generation = h.launcher.prime();
    const entering = h.launcher.enter(h.host);
    expect(h.fallbacks).toEqual(['loading']);
    h.loads[0].resolve();
    await entering;
    expect(h.body.starts).toHaveLength(1);
    expect(h.body.starts[0]).toMatchObject({ generation, audioContext: h.contexts[0], host: h.host });
    expect(h.body.starts[0].guard(generation)).toBe(true);
    h.state.visible = false;
    expect(h.body.starts[0].guard(generation)).toBe(false);
    h.state.visible = true;
    expect(h.body.starts[0].guard(generation - 1)).toBe(false);
  });

  it('repeated taps create one AudioContext and one start', async () => {
    const h = createLauncherHarness();
    h.launcher.prime();
    const entering = h.launcher.enter(h.host);
    h.launcher.prime();
    void h.launcher.enter(h.host);
    h.loads[0].resolve();
    await entering;
    await flush();
    h.launcher.prime();
    await h.launcher.enter(h.host);
    expect(h.contexts).toHaveLength(1);
    expect(h.body.starts).toHaveLength(1);
  });

  it('leaving while the body loads closes the context immediately, even if loading never finishes', async () => {
    const h = createLauncherHarness();
    h.launcher.prime();
    void h.launcher.enter(h.host);
    await flush();
    h.launcher.leave('tab');
    // The load promise is deliberately left pending (stalled network).
    expect(h.contexts[0].state).toBe('closed');
    expect(h.launcher.isActive()).toBe(false);
    h.loads[0].resolve();
    await flush(10);
    expect(h.body.starts).toHaveLength(0);
  });

  it('never enters a screen that is not showing (parent panel hidden) and closes the primed context', async () => {
    const h = createLauncherHarness();
    h.launcher.prime();
    h.state.hostVisible = false;
    await h.launcher.enter(h.host);
    expect(h.contexts[0].state).toBe('closed');
    expect(h.loads).toHaveLength(0);
    expect(h.body.starts).toHaveLength(0);
  });

  it('does not start when the screen was hidden while the body loaded', async () => {
    const h = createLauncherHarness();
    h.launcher.prime();
    const entering = h.launcher.enter(h.host);
    h.state.hostVisible = false; // e.g. moved to the member panel, tab element still unhidden
    h.loads[0].resolve();
    await entering;
    expect(h.body.starts).toHaveLength(0);
    expect(h.contexts[0].state).toBe('closed');
  });

  it('adopts an AudioContext prepared by the laboratory tap before the launcher loaded', async () => {
    const h = createLauncherHarness();
    const external = { state: 'running', resumeCalls: 0, resume() { this.resumeCalls += 1; return Promise.resolve(); }, close() { this.state = 'closed'; return Promise.resolve(); } };
    const generation = h.launcher.adoptPrimed(external);
    const entering = h.launcher.enter(h.host);
    h.loads[0].resolve();
    await entering;
    expect(h.contexts).toHaveLength(0); // nothing new created
    expect(h.body.starts[0]).toMatchObject({ generation, audioContext: external });
    h.state.allowed = false;
    const other = { state: 'running', resume() {}, close() { this.state = 'closed'; } };
    expect(h.launcher.adoptPrimed(other)).toBeNull();
    expect(other.state).toBe('closed');
  });

  it('leave closes a primed context that was never entered and is idempotent', () => {
    const h = createLauncherHarness();
    h.launcher.prime();
    h.launcher.leave('tab');
    h.launcher.leave('tab');
    expect(h.contexts[0].state).toBe('closed');
  });

  it('a failed load releases the context, shows retry, and can be retried cleanly', async () => {
    const h = createLauncherHarness();
    h.launcher.prime();
    const entering = h.launcher.enter(h.host);
    h.loads[0].reject(new Error('404'));
    await entering;
    expect(h.contexts[0].state).toBe('closed');
    expect(h.fallbacks.at(-1)).toBe('load-failed');
    h.launcher.restartFromGesture();
    expect(h.contexts).toHaveLength(2); // created synchronously in the retry tap
    expect(h.loads).toHaveLength(2); // the rejected promise was discarded
    h.loads[1].resolve();
    await flush(10);
    expect(h.body.starts).toHaveLength(1);
  });

  it('a release mismatch releases the context and shows the reload guidance', async () => {
    const h = createLauncherHarness({ mismatch: true });
    h.launcher.prime();
    const entering = h.launcher.enter(h.host);
    h.loads[0].resolve();
    await entering;
    expect(h.contexts[0].state).toBe('closed');
    expect(h.body.errors).toEqual(['version-mismatch']);
    expect(h.body.starts).toHaveLength(0);
  });

  it('losing permission makes enter leave instead of starting', async () => {
    const h = createLauncherHarness();
    h.launcher.prime();
    h.state.allowed = false;
    await h.launcher.enter(h.host);
    expect(h.contexts[0].state).toBe('closed');
    expect(h.body.starts).toHaveLength(0);
  });

  it('background releases and returning tries one automatic, non-gesture restart', async () => {
    const h = createLauncherHarness();
    h.launcher.prime();
    const entering = h.launcher.enter(h.host);
    h.loads[0].resolve();
    await entering;
    h.launcher.suspendForBackground();
    expect(h.body.stops).toBeGreaterThanOrEqual(1);
    expect(h.launcher.isActive()).toBe(false);
    await h.launcher.resumeAfterVisible();
    await flush();
    expect(h.body.starts).toHaveLength(2);
    expect(h.body.starts[1].audioContext).toBeNull();
    h.launcher.resumeAfterVisible(); // a second call does nothing
    await flush();
    expect(h.body.starts).toHaveLength(2);
  });
});
