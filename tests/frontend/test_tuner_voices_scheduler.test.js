import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const dir = path.join(process.cwd(), 'src/static/js/modules/tuner');
const scheduler = require(path.join(dir, 'scheduler.js'));
const playback = require(path.join(dir, 'playback.js'));

// AudioParam fake with a small evaluator so the sum of the gains can be
// checked at any time (linear ramps and set values only).
function param(initial) {
  const events = [];
  const p = {
    value: initial,
    events,
    cancelScheduledValues: (t) => { for (let i = events.length - 1; i >= 0; i -= 1) if (events[i][2] >= t) events.splice(i, 1); },
    setValueAtTime: (v, t) => events.push(['set', v, t]),
    linearRampToValueAtTime: (v, t) => events.push(['linear', v, t]),
    exponentialRampToValueAtTime: (v, t) => events.push(['exp', v, t]),
    at: (t) => {
      let value = initial;
      let lastT = 0;
      const sorted = events.slice().sort((a, b) => a[2] - b[2]);
      for (const [kind, v, et] of sorted) {
        if (et > t) {
          if (kind === 'linear') return value + (v - value) * ((t - lastT) / Math.max(1e-9, et - lastT));
          return value;
        }
        value = v;
        lastT = et;
      }
      return value;
    },
  };
  return p;
}

function fakeAudio() {
  const contexts = [];
  class Ctx {
    constructor() { this.state = 'running'; this.currentTime = 1; this.sampleRate = 48000; this.destination = {}; this.osc = []; this.gains = []; this.waves = []; contexts.push(this); }
    resume() { return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
    createGain() { const g = { gain: param(1), out: [], connect(t) { g.out.push(t); return t; }, disconnect() { g.disconnected = true; } }; this.gains.push(g); return g; }
    createOscillator() {
      const o = { type: 'sine', frequency: param(0), out: [], connect(t) { o.out.push(t); return t; }, disconnect() {}, start(t) { o.startedAt = t; }, stop(t) { o.stops = (o.stops || []).concat([t]); }, setPeriodicWave(w) { o.wave = w; } };
      this.osc.push(o);
      return o;
    }
    createPeriodicWave(real, imag) { const w = { real, imag }; this.waves.push(w); return w; }
  }
  let timers = [];
  let id = 0;
  const env = {
    createContext: () => new Ctx(),
    setTimeout: (fn, ms) => { id += 1; timers.push({ id, fn, ms }); return id; },
    clearTimeout: (tid) => { timers = timers.filter((t) => t.id !== tid); },
    outputs: [],
    onOutput: (e) => env.outputs.push(e),
  };
  return { env, contexts, runTimers: () => { const due = timers; timers = []; due.forEach((t) => t.fn()); }, pending: () => timers.length };
}

describe('scheduler (pure pattern events)', () => {
  it('produces hold, timed, repeat, alternate and metronome events on the audio clock', () => {
    const p = scheduler.normalizePattern;
    expect(scheduler.eventAt(p({ kind: 'hold' }), 1, 0)).toMatchObject({ type: 'on', time: 1 });
    expect(scheduler.eventAt(p({ kind: 'hold' }), 1, 1)).toBeNull();
    expect(scheduler.eventAt(p({ kind: 'timed', seconds: 2.5 }), 1, 1)).toMatchObject({ type: 'off', time: 3.5, last: true });
    const rep = p({ kind: 'repeat', seconds: 1, gapSeconds: 0.5, repeats: 3 });
    const evs = [];
    for (let k = 0; scheduler.eventAt(rep, 0, k); k += 1) evs.push(scheduler.eventAt(rep, 0, k));
    expect(evs.map((e) => [e.type, e.time])).toEqual([['on', 0], ['off', 1], ['on', 1.5], ['off', 2.5], ['on', 3], ['off', 4]]);
    expect(evs.at(-1).last).toBe(true);
    const alt = p({ kind: 'alternate', seconds: 1, gapSeconds: 0, repeats: 1 });
    expect([0, 2].map((k) => scheduler.eventAt(alt, 0, k).group)).toEqual([0, 1]);
    const met = p({ kind: 'metronome', bpm: 120, beatsPerBar: 3, repeats: 4 });
    expect([0, 1, 2, 3].map((k) => scheduler.eventAt(met, 0, k).time)).toEqual([0, 0.5, 1, 1.5]);
    expect([0, 1, 2, 3].map((k) => scheduler.eventAt(met, 0, k).accent)).toEqual([true, false, false, true]);
    expect(scheduler.eventAt(met, 0, 4)).toBeNull();
    expect(p({ kind: 'timed', seconds: 9999 }).seconds).toBe(600);
    expect(p({ kind: 'metronome', bpm: 999 }).bpm).toBe(240);
  });

  it('fills only the look-ahead window and a stop invalidates late timers', () => {
    let now = 0;
    let timers = [];
    const sch = scheduler.createScheduler({ now: () => now, setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout: () => { timers = []; } });
    const seen = [];
    sch.start({ kind: 'repeat', seconds: 0.2, gapSeconds: 0.1, repeats: null }, (ev) => seen.push(ev.time));
    expect(seen.every((t) => t <= now + 0.1 + 1e-9)).toBe(true);
    const pending = timers.slice();
    sch.stop();
    now = 5;
    pending.forEach((fn) => fn()); // a timer that fires after stop
    expect(seen.every((t) => t < 1)).toBe(true);
    expect(sch.isRunning()).toBe(false);
  });
});

describe('multi-voice engine', () => {
  it('keeps the summed level below full scale with 4 voices (1/N per voice, master <= 0.25)', () => {
    const { env, contexts } = fakeAudio();
    const engine = playback.createPlaybackEngine(env);
    const voices = [261.63, 329.63, 392, 493.88].map((f) => ({ frequency: f, waveform: 'sine' }));
    expect(engine.startVoices(voices, { gain: 5 }).started).toBe(true); // asked for too much
    const ctx = contexts[0];
    const master = ctx.gains.find((g) => g.out.includes(ctx.destination));
    expect(master.gain.at(2)).toBeCloseTo(playback.MAX_GAIN, 9);
    const voiceGains = ctx.gains.filter((g) => ctx.osc.some((o) => o.out.includes(g)));
    expect(voiceGains).toHaveLength(4);
    const sum = voiceGains.reduce((s, g) => s + g.gain.at(2), 0);
    expect(sum).toBeCloseTo(1, 9);
    // Worst case (all in phase, each waveform peak 1) = master * 1 = 0.25.
    expect(sum * master.gain.at(2)).toBeLessThan(1);
    expect(engine.getFrequencies()).toEqual([261.63, 329.63, 392, 493.88]);
  });

  it('builds harmonic tones only below Nyquist and with at most 40 partials', () => {
    const coef = playback.partialCoefficients(3000, 48000, null);
    expect(coef.partials).toBe(7); // 8 x 3000 = 24 kHz is not below Nyquist
    expect(playback.partialCoefficients(100, 48000, null).partials).toBe(40);
    const { env, contexts } = fakeAudio();
    const engine = playback.createPlaybackEngine(env);
    engine.startVoices([{ frequency: 3000, waveform: 'harmonic' }, { frequency: 440, waveform: 'triangle' }], { gain: 0.1 });
    expect(contexts[0].waves).toHaveLength(1);
    expect(contexts[0].waves[0].imag.length).toBe(8);
    expect(contexts[0].osc[1].type).toBe('triangle');
    const peak = playback.waveformPeak(Float32Array.from([0, 1, 0.5, 0.33]));
    expect(peak.peak).toBeLessThanOrEqual(peak.bound);
  });

  it('refuses out-of-range voices without creating audio', () => {
    const { env, contexts } = fakeAudio();
    const engine = playback.createPlaybackEngine(env);
    expect(engine.startVoices([{ frequency: 20 }], { gain: 0.1 }).started).toBe(false);
    expect(engine.startVoices([], { gain: 0.1 }).started).toBe(false);
    expect(engine.startVoices([1, 2, 3, 4, 5].map(() => ({ frequency: 440 })), { gain: 0.1 }).started).toBe(true);
    expect(contexts[0].osc).toHaveLength(4); // at most 4 voices
  });

  it('stop fades and cancels every planned note; dispose releases at once', () => {
    const { env, contexts, runTimers } = fakeAudio();
    const engine = playback.createPlaybackEngine(env);
    engine.startVoices([{ frequency: 440 }, { frequency: 660, group: 1 }], { gain: 0.1, pattern: { kind: 'alternate', seconds: 0.5, gapSeconds: 0, repeats: null } });
    const ctx = contexts[0];
    ctx.currentTime = 1.05;
    expect(engine.stop()).toBe(true);
    const master = ctx.gains.find((g) => g.out.includes(ctx.destination));
    expect(master.gain.events.at(-1)).toEqual(['linear', 0, 1.05 + playback.FADE_OUT_SECONDS]);
    const before = JSON.stringify(ctx.gains.map((g) => g.gain.events.length));
    runTimers(); // scheduler refills must not add anything after stop
    expect(ctx.state).toBe('closed');
    expect(JSON.stringify(ctx.gains.map((g) => g.gain.events.length))).toBe(before);
    expect(env.outputs.some((e) => e.type === 'end')).toBe(true);
    engine.startVoices([{ frequency: 440 }], { gain: 0.1 });
    engine.dispose();
    expect(contexts[1].state).toBe('closed');
    expect(engine.isActive()).toBe(false);
  });

  it('glides voice frequencies (A4 / temperament follow) without restarting', () => {
    const { env, contexts } = fakeAudio();
    const engine = playback.createPlaybackEngine(env);
    engine.startVoices([{ frequency: 440 }, { frequency: 550 }], { gain: 0.1 });
    expect(engine.setVoiceFrequencies([441, 551.25])).toBe(true);
    expect(engine.setVoiceFrequencies([441])).toBe(false); // different voice count
    expect(contexts).toHaveLength(1);
    expect(contexts[0].osc[1].frequency.events.at(-1)).toEqual(['exp', 551.25, 1 + playback.FREQUENCY_GLIDE_SECONDS]);
  });

  it('a timed pattern ends by itself and reports done once', () => {
    const { env, contexts, runTimers } = fakeAudio();
    const engine = playback.createPlaybackEngine(env);
    let done = 0;
    engine.startVoices([{ frequency: 440 }], { gain: 0.1, pattern: { kind: 'timed', seconds: 0.05 }, onDone: () => { done += 1; } });
    contexts[0].currentTime = 2;
    for (let i = 0; i < 4; i += 1) runTimers();
    expect(done).toBe(1);
    expect(engine.isActive()).toBe(false);
  });

  it('the value timeline gives the scheduled level at any time (re-planning without cancelAndHold)', () => {
    const seg = [{ t0: 0, v0: 0, t1: 0.02, v1: 1 }, { t0: 1, v0: 1, t1: 1.03, v1: 0 }];
    expect(playback.timelineValueAt(seg, 0.01, 0)).toBeCloseTo(0.5, 9);
    expect(playback.timelineValueAt(seg, 0.5, 0)).toBe(1);
    expect(playback.timelineValueAt(seg, 1.015, 0)).toBeCloseTo(0.5, 9);
    expect(playback.timelineValueAt(seg, 2, 0)).toBe(0);
  });
});
