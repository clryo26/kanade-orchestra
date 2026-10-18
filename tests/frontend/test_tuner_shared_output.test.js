import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

// A: tuner on the shared output manager (design 4.1), tuner adapters
// (design 2.1) and namespace separation (MT-19, logic level). Real-browser
// two-tab / audible checks are MD-13 / MD-17 / MD-19 (not claimed here).
const require = createRequire(import.meta.url);
const root = process.cwd();
const tunerDir = path.join(root, 'src/static/js/modules/tuner');
const metDir = path.join(root, 'src/static/js/modules/metronome');
require(path.join(tunerDir, 'music.js'));
require(path.join(tunerDir, 'scheduler.js'));
const TPB = require(path.join(tunerDir, 'playback.js'));
const OM = require(path.join(root, 'src/static/js/modules/audio/output_manager.js'));
require(path.join(metDir, 'rational.js'));
require(path.join(metDir, 'score_model.js'));
require(path.join(metDir, 'tempo_map.js'));
require(path.join(metDir, 'event_compiler.js'));
require(path.join(metDir, 'sounds.js'));
require(path.join(metDir, 'playback.js'));
require(path.join(metDir, 'transport.js'));
const TA = require(path.join(metDir, 'tuner_adapter.js'));

function fakeContextClass(log) {
  return class FakeCtx {
    constructor() {
      this.state = 'running';
      this.currentTime = 0;
      this.sampleRate = 48000;
      this.destination = { kind: 'destination' };
      this.onstatechange = null;
      log.contexts.push(this);
    }
    resume() { return Promise.resolve(); }
    close() { this.state = 'closed'; log.closed += 1; return Promise.resolve(); }
    param(v = 1) {
      return {
        value: v,
        targets: [],
        setValueAtTime(x) { this.value = x; },
        linearRampToValueAtTime(x) { this.targets.push(x); this.value = x; },
        exponentialRampToValueAtTime(x) { this.value = x; },
        setTargetAtTime(x) { this.value = x; },
        cancelScheduledValues() {},
        cancelAndHoldAtTime() {},
      };
    }
    createGain() { const g = { gain: this.param(1), out: [], connect(t) { this.out.push(t); return t; }, disconnect() { this.out = []; } }; log.gains.push(g); return g; }
    createOscillator() { return { type: 'sine', frequency: this.param(440), connect() {}, disconnect() {}, start() {}, stop() {}, setPeriodicWave() {} }; }
    createBuffer(ch, len) { return { length: len, getChannelData: () => new Float32Array(len), copyToChannel() {} }; }
    createBufferSource() { return { buffer: null, connect() {}, disconnect() {}, start() {}, stop() {} }; }
  };
}

function timers() {
  let id = 0;
  const to = new Map();
  const iv = new Map();
  return {
    setTimeout: (fn) => { id += 1; to.set(id, fn); return id; },
    clearTimeout: (t) => to.delete(t),
    setInterval: (fn) => { id += 1; iv.set(id, fn); return id; },
    clearInterval: (t) => iv.delete(t),
    flush: () => { const d = [...to.values()]; to.clear(); d.forEach((f) => f()); },
    beat: () => [...iv.values()].forEach((f) => f()),
  };
}

describe('tuner playback engine: own context or shared lease', () => {
  it('without a provider it keeps its own context (previous behaviour) and closes it on dispose', () => {
    const log = { contexts: [], gains: [], closed: 0 };
    const Ctx = fakeContextClass(log);
    const engine = TPB.createPlaybackEngine({ createContext: () => new Ctx(), ...timers() });
    expect(engine.start(440, 0.1).started).toBe(true);
    expect(log.contexts).toHaveLength(1);
    const master = log.gains[0];
    expect(master.out[0]).toBe(log.contexts[0].destination);
    expect(master.gain.targets.at(-1)).toBeCloseTo(0.1, 9); // absolute gain
    engine.dispose();
    expect(log.closed).toBe(1);
  });

  it('with the shared provider it plays into the lease bus at the same absolute level and never closes the context', () => {
    const log = { contexts: [], gains: [], closed: 0 };
    const Ctx = fakeContextClass(log);
    const t = timers();
    const m = OM.createOutputManager({ AudioContext: Ctx, now: () => 0, ...t });
    m.prepareClaim();
    const interrupted = [];
    const output = {
      open: (o) => {
        m.unlockFromGesture();
        const got = m.acquire('tuner', 1, { onRevoke: o.onRevoke });
        return got.ok ? { ok: true, context: got.lease.context, destination: got.lease.bus, close: () => m.release(got.lease) } : { ok: false, code: got.code };
      },
    };
    const engine = TPB.createPlaybackEngine({ createContext: () => { throw new Error('must not create its own context'); }, output, onInterrupted: () => interrupted.push(1), ...t });
    expect(engine.start(440, 0.1).started).toBe(true);
    const tunerGain = log.gains.find((g) => g.gain.targets.length);
    // 0.1 absolute = 0.4 relative to the master limit 0.25 (same sound level).
    expect(tunerGain.gain.targets.at(-1)).toBeCloseTo(0.4, 9);
    expect(m.consumers()).toEqual(['tuner']);
    engine.dispose();
    expect(m.consumers()).toEqual([]);
    expect(log.closed).toBe(0); // the shared context stays (idle close is the manager's)
    // A revoked lease stops the tone like an interruption.
    engine.start(440, 0.1);
    m.shutdown();
    expect(interrupted).toHaveLength(1);
    expect(engine.isActive()).toBe(false);
  });

  it('exclusive by default: the tone is refused while the metronome holds the output', () => {
    const log = { contexts: [], gains: [], closed: 0 };
    const m = OM.createOutputManager({ AudioContext: fakeContextClass(log), now: () => 0, ...timers() });
    m.unlockFromGesture();
    m.acquire('metronome', 2);
    const output = { open: (o) => { const got = m.acquire('tuner', 1, { onRevoke: o.onRevoke }); return got.ok ? { ok: true, context: got.lease.context, destination: got.lease.bus, close: () => m.release(got.lease) } : { ok: false, code: got.code }; } };
    const engine = TPB.createPlaybackEngine({ createContext: () => null, output, ...timers() });
    expect(engine.start(440, 0.1)).toEqual({ started: false, reason: 'OUTPUT_BUSY' });
  });
});

describe('tuner exercise clicks on the metronome engine (trainer adapter)', () => {
  it('one click stream: a lease of its own, refused while the metronome plays, released on stop', async () => {
    const log = { contexts: [], gains: [], closed: 0 };
    const t = timers();
    const m = OM.createOutputManager({ AudioContext: fakeContextClass(log), now: () => Date.now(), ...t });
    await m.prepareClaim();
    const clicks = TA.createTrainerClicks({ manager: () => m, ...t });
    const outputs = [];
    const r = clicks.start({ attemptId: 'a1', bpmTenths: 1200, beatsPerBar: 4, beats: 8, audible: true, onBeat: () => {}, onOutput: (e) => outputs.push(e.type) });
    expect(r.ok).toBe(true);
    expect(m.consumers()).toEqual(['tuner-trainer']);
    clicks.stop('other-attempt'); // another attempt id: no effect
    expect(m.consumers()).toEqual(['tuner-trainer']);
    clicks.stop('a1');
    expect(m.consumers()).toEqual([]);
    m.acquire('metronome', 1);
    expect(clicks.start({ attemptId: 'a2', bpmTenths: 1200, beatsPerBar: 4, beats: 8, audible: true }).code).toBe('OUTPUT_BUSY');
  });

  it('builds a valid snapshot of the old fixed-tempo exercise', () => {
    const s = TA.snapshotFor(905, 3);
    expect(s.ok).toBe(true);
    expect(s.snapshot.tempo.bpmTenths).toBe(905);
    expect(s.snapshot.barTemplate.pulseCount).toBe(3);
  });
});

describe('tuner display adapter', () => {
  function fakeDocument() {
    const make = (tag) => ({
      tag,
      children: [],
      attrs: {},
      listeners: {},
      textContent: '',
      setAttribute(k, v) { this.attrs[k] = v; },
      addEventListener(k, fn) { this.listeners[k] = fn; },
      appendChild(c) { this.children.push(c); return c; },
      replaceChildren(...c) { this.children = c; },
    });
    return { createElement: make };
  }

  it('mounting starts nothing; the explicit tap starts the tuner; unmount ends only its own run', async () => {
    globalThis.document = fakeDocument();
    const calls = [];
    let generation = 5;
    const launcher = {
      prime: () => { calls.push('prime'); generation += 1; return generation; },
      enter: (host) => { calls.push(['enter', host.tag]); return Promise.resolve(); },
      leave: (reason) => calls.push(['leave', reason]),
      getGeneration: () => generation,
    };
    const host = globalThis.document.createElement('host');
    const d = TA.createTunerDisplay({ host, launcher: () => launcher });
    await d.mount();
    expect(calls).toEqual([]); // no microphone on mount
    const button = host.children[0].children[1];
    button.listeners.click();
    expect(calls).toEqual(['prime', ['enter', 'host']]);
    d.unmount('close');
    expect(calls.at(-1)).toEqual(['leave', 'close']);
    // A tuner run started elsewhere later (other generation) is not ended.
    await d.mount();
    host.children[0].children[1].listeners.click();
    generation += 10;
    calls.length = 0;
    d.unmount('close');
    expect(calls).toEqual([]);
    delete globalThis.document;
  });
});

describe('MT-19 namespaces, releases and URLs do not collide', () => {
  it('separate libraries, release prefixes, processor names and asset URLs', () => {
    expect(globalThis.PortalTunerLib.playback).not.toBe(globalThis.PortalMetronomeLib.playback);
    const tunerLauncher = fs.readFileSync(path.join(tunerDir, 'launcher.js'), 'utf8');
    const metLauncher = fs.readFileSync(path.join(metDir, 'launcher.js'), 'utf8');
    const audio = fs.readFileSync(path.join(root, 'src/static/js/modules/audio/output_manager.js'), 'utf8');
    const tunerId = /TUNER_RELEASE_ID = '(t-[0-9a-f]{12})'/.exec(tunerLauncher)[1];
    const tunerAudio = /TUNER_AUDIO_RELEASE_ID = '(a-[0-9a-f]{12})'/.exec(tunerLauncher)[1];
    const metAudio = /METRONOME_AUDIO_RELEASE_ID = '(a-[0-9a-f]{12})'/.exec(metLauncher)[1];
    const audioId = /AUDIO_RELEASE_ID = '(a-[0-9a-f]{12})'/.exec(audio)[1];
    expect(tunerId.startsWith('t-')).toBe(true);
    expect(tunerAudio).toBe(audioId); // the same shared module for both consumers
    expect(metAudio).toBe(audioId);
    expect(fs.readFileSync(path.join(metDir, 'click_processor.js'), 'utf8')).toContain("'portal-metronome-click-v1-'");
    expect(fs.readFileSync(path.join(metDir, 'capture_processor.js'), 'utf8')).toContain("'portal-metronome-capture-v1-'");
    expect(tunerLauncher).toContain("'/static/js/modules/tuner/'");
    expect(metLauncher).toContain("'/static/js/modules/metronome/'");
    // The tuner's own modules never touch the claim database.
    expect(fs.readFileSync(path.join(tunerDir, 'index.js'), 'utf8')).not.toMatch(/indexedDB/);
  });
});
