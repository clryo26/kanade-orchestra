import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const root = process.cwd();
const music = require(path.join(root, 'src/static/js/modules/tuner/music.js'));
const playback = require(path.join(root, 'src/static/js/modules/tuner/playback.js'));

// AudioParam fake that records automation calls.
function param(initial) {
  const events = [];
  return {
    value: initial,
    events,
    cancelScheduledValues: (t) => events.push(['cancel', t]),
    setValueAtTime: (v, t) => events.push(['set', v, t]),
    linearRampToValueAtTime: (v, t) => events.push(['linear', v, t]),
    exponentialRampToValueAtTime: (v, t) => events.push(['exp', v, t]),
  };
}

function fakeAudio() {
  const contexts = [];
  class Ctx {
    constructor() {
      this.state = 'suspended';
      this.currentTime = 1;
      this.resumeCalls = 0;
      this.closed = false;
      this.destination = { kind: 'destination' };
      this.oscillators = [];
      this.gains = [];
      contexts.push(this);
    }
    resume() { this.resumeCalls += 1; this.state = 'running'; return Promise.resolve(); }
    close() { this.closed = true; this.state = 'closed'; return Promise.resolve(); }
    createGain() {
      const node = { gain: param(1), connections: [], connect(t) { node.connections.push(t); }, disconnect() { node.disconnected = true; } };
      this.gains.push(node);
      return node;
    }
    createOscillator() {
      const node = {
        type: 'square', frequency: param(440), startedAt: null, stops: [], connections: [],
        connect(t) { node.connections.push(t); }, disconnect() { node.disconnected = true; },
        start(t) { node.startedAt = t; }, stop(t) { node.stops.push(t); },
      };
      this.oscillators.push(node);
      return node;
    }
  }
  let timers = [];
  let id = 0;
  const env = {
    createContext: () => new Ctx(),
    setTimeout: (fn, ms) => { id += 1; timers.push({ id, fn, ms }); return id; },
    clearTimeout: (tid) => { timers = timers.filter((t) => t.id !== tid); },
    interrupted: 0,
    onInterrupted: () => { env.interrupted += 1; },
  };
  return { env, contexts, runTimers: () => { const due = timers; timers = []; due.forEach((t) => t.fn()); }, pendingTimers: () => timers.length };
}

describe('reference-tone input', () => {
  // Design range 28.0-4,700.0 Hz (C1 at A4 = 390 Hz is 28.99 Hz, C8 at A4 = 480 Hz is 4,566.56 Hz).
  it('accepts 28.0-4700.0 Hz in 0.1 Hz steps and explains rejections', () => {
    expect(playback.parseHzInput('440')).toEqual({ ok: true, value: 440 });
    expect(playback.parseHzInput(' 28.0 ')).toEqual({ ok: true, value: 28 });
    expect(playback.parseHzInput('4700.0')).toEqual({ ok: true, value: 4700 });
    expect(playback.parseHzInput('４４０．５')).toEqual({ ok: true, value: 440.5 }); // full-width
    for (const [text, reason] of [['', 'empty'], ['   ', 'empty'], ['27.9', 'range'], ['4700.1', 'range'], ['440.25', 'format'], ['abc', 'format'], ['-440', 'format'], ['4e2', 'format'], ['440.', 'format']]) {
      const result = playback.parseHzInput(text);
      expect(result.ok, text).toBe(false);
      expect(result.reason, text).toBe(reason);
      expect(result.message.length).toBeGreaterThan(0);
    }
  });

  it('offers C1-C8 and enables every note inside 28-4700 Hz for A4 = 390-480 Hz', () => {
    const at390 = playback.noteOptions(390);
    expect(at390[0].note.label).toBe('C1');
    expect(at390[0].frequency).toBeCloseTo(28.987, 3); // still playable
    expect(at390.every((o) => o.enabled)).toBe(true);
    const at480 = playback.noteOptions(480);
    expect(at480.at(-1).note.label).toBe('C8');
    expect(at480.at(-1).frequency).toBeCloseTo(4566.555, 3);
    expect(at480.every((o) => o.enabled)).toBe(true);
    // A note outside the range is disabled (e.g. a reference beyond the A4 range).
    expect(playback.noteOptions(500).at(-1).enabled).toBe(false); // C8 = 4,756.8 Hz
    expect(playback.noteOptions(370)[0].enabled).toBe(false); // C1 = 27.50 Hz
    expect(playback.DEFAULT_MIDI).toBe(69);
  });

  it('note mode follows A4, Hz mode keeps its exact value', () => {
    const note = { source: 'note', midi: 69 };
    expect(playback.resolveFrequency(note, 442).frequency).toBe(442);
    expect(playback.resolveFrequency(note, 430).frequency).toBe(430);
    const pure = 261.6255653005986 * 5 / 4;
    const hz = { source: 'hz', hz: pure };
    expect(playback.resolveFrequency(hz, 442).frequency).toBe(pure); // not rounded
    expect(playback.resolveFrequency(hz, 450).frequency).toBe(pure);
    expect(playback.resolveFrequency({ source: 'note', midi: 24 }, 370)).toMatchObject({ ok: false, reason: 'range' });
    expect(playback.resolveFrequency({ source: 'hz', hz: 20 }, 442)).toMatchObject({ ok: false, reason: 'range' });
    expect(playback.resolveFrequency({ source: 'hz', hz: 440, error: { reason: 'format', message: 'x' } }, 442)).toMatchObject({ ok: false });
    expect(music.noteFrequency(69, 442)).toBe(442);
  });

  it('maps the volume slider to a restrained gain', () => {
    expect(playback.DEFAULT_VOLUME_PERCENT).toBe(40);
    expect(playback.volumeToGain(40)).toBeCloseTo(0.1, 9);
    expect(playback.volumeToGain(100)).toBeCloseTo(0.25, 9);
    expect(playback.volumeToGain(-5)).toBe(0);
    expect(playback.volumeToGain(500)).toBeCloseTo(0.25, 9);
  });
});

describe('reference-tone engine', () => {
  it('creates and resumes its own context synchronously, with a sine and a fade-in', () => {
    const { env, contexts } = fakeAudio();
    const engine = playback.createPlaybackEngine(env);
    const result = engine.start(442, 0.1);
    expect(result.started).toBe(true);
    expect(contexts).toHaveLength(1);
    const ctx = contexts[0];
    expect(ctx.resumeCalls).toBe(1); // inside the same call (the tap)
    const osc = ctx.oscillators[0];
    const gain = ctx.gains[0];
    expect(osc.type).toBe('sine');
    expect(osc.frequency.events).toEqual([['set', 442, 1]]);
    expect(gain.gain.events).toEqual([['set', 0, 1], ['linear', 0.1, 1 + playback.FADE_IN_SECONDS]]);
    expect(osc.connections[0]).toBe(gain);
    expect(gain.connections[0]).toBe(ctx.destination); // audible output, not the capture path
    expect(engine.isPlaying()).toBe(true);
  });

  it('never starts a second oscillator on repeated taps; it updates the running one', () => {
    const { env, contexts } = fakeAudio();
    const engine = playback.createPlaybackEngine(env);
    engine.start(442, 0.1);
    const again = engine.start(330, 0.2);
    expect(again).toMatchObject({ started: false, reason: 'already-playing' });
    expect(contexts).toHaveLength(1);
    expect(contexts[0].oscillators).toHaveLength(1);
    const freqEvents = contexts[0].oscillators[0].frequency.events;
    expect(freqEvents.at(-1)).toEqual(['exp', 330, 1 + playback.FREQUENCY_GLIDE_SECONDS]);
  });

  it('glides frequency and volume changes', () => {
    const { env, contexts } = fakeAudio();
    const engine = playback.createPlaybackEngine(env);
    engine.start(442, 0.1);
    contexts[0].currentTime = 2;
    expect(engine.setFrequency(500)).toBe(true);
    expect(engine.setFrequency(10)).toBe(false); // out of range never reaches the oscillator
    expect(contexts[0].oscillators[0].frequency.events.slice(-3)).toEqual([['cancel', 2], ['set', 440, 2], ['exp', 500, 2 + playback.FREQUENCY_GLIDE_SECONDS]]);
    engine.setGain(0.2);
    expect(contexts[0].gains[0].gain.events.at(-1)).toEqual(['linear', 0.2, 2 + playback.VOLUME_RAMP_SECONDS]);
  });

  it('fades out on stop, stops the oscillator after the fade and closes its context later (idempotent)', () => {
    const { env, contexts, runTimers, pendingTimers } = fakeAudio();
    const engine = playback.createPlaybackEngine(env);
    engine.start(442, 0.1);
    contexts[0].currentTime = 3;
    expect(engine.stop()).toBe(true);
    expect(engine.stop()).toBe(false);
    expect(engine.isPlaying()).toBe(false);
    expect(engine.isActive()).toBe(true); // fading
    expect(contexts[0].gains[0].gain.events.at(-1)).toEqual(['linear', 0, 3 + playback.FADE_OUT_SECONDS]);
    expect(contexts[0].oscillators[0].stops[0]).toBeCloseTo(3 + playback.FADE_OUT_SECONDS + 0.01, 9);
    expect(contexts[0].closed).toBe(false);
    expect(pendingTimers()).toBe(1);
    runTimers();
    expect(contexts[0].closed).toBe(true);
    expect(engine.isActive()).toBe(false);
    engine.dispose();
    engine.dispose();
  });

  it('a stale close timer never touches a newer session', () => {
    const { env, contexts, runTimers } = fakeAudio();
    const engine = playback.createPlaybackEngine(env);
    engine.start(442, 0.1);
    engine.stop(); // timer pending for session 1
    engine.start(330, 0.1); // new session while the old fade runs: old one released at once
    expect(contexts[0].closed).toBe(true);
    expect(contexts).toHaveLength(2);
    runTimers(); // old timer was cleared; if it fired it must not close session 2
    expect(contexts[1].closed).toBe(false);
    expect(engine.isPlaying()).toBe(true);
  });

  it('dispose releases immediately (leave/background) and reports nothing as playing', () => {
    const { env, contexts } = fakeAudio();
    const engine = playback.createPlaybackEngine(env);
    engine.start(442, 0.1);
    engine.dispose();
    expect(contexts[0].closed).toBe(true);
    expect(contexts[0].oscillators[0].stops.length).toBeGreaterThan(0);
    expect(contexts[0].gains[0].disconnected).toBe(true);
    expect(engine.isActive()).toBe(false);
    expect(engine.setFrequency(500)).toBe(false);
  });

  it('treats an interrupted context (phone call) as a stop and reports it once', () => {
    const { env, contexts } = fakeAudio();
    const engine = playback.createPlaybackEngine(env);
    engine.start(442, 0.1);
    contexts[0].state = 'interrupted';
    contexts[0].onstatechange();
    expect(env.interrupted).toBe(1);
    expect(engine.isActive()).toBe(false);
    expect(contexts[0].closed).toBe(true);
  });

  it('rejects an unplayable frequency without creating audio', () => {
    const { env, contexts } = fakeAudio();
    const engine = playback.createPlaybackEngine(env);
    expect(engine.start(20, 0.1)).toMatchObject({ started: false, reason: 'range' });
    expect(contexts).toHaveLength(0);
  });
});
