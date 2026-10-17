import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const P = require(path.join(process.cwd(), 'tests/frontend/helpers/tuner_pipeline.cjs'));
const S = P.lib.analysisStats;

// Synthetic signals with known truth go through the real analysis Worker
// (VM), the measurement store, note segmentation and the statistics.
// These are PC synthetic-tone checks, not device or instrument guarantees.
const SR = 48000;
const A = 440;
const sec = (frame2) => frame2 / 2 / SR;
const env = (segments, fade = 0.01) => (t) => {
  const s = segments.find(([a, b]) => t >= a && t < b);
  return s ? Math.min(1, (t - s[0]) / fade, (s[1] - t) / fade) : 0;
};

function statsFor(snap, ev, targetHz, extra = {}) {
  return S.eventStats({ series: snap.series, i0: ev.i0, i1: ev.i1, startFrame2: ev.startFrame2, endFrame2: ev.endFrame2, targetHz, toleranceCents: 3, ...extra });
}

describe('note events on synthetic notes (onset envelope + pitch)', () => {
  it('splits short repeated notes (150 ms, 30 ms silence) 6/6 with onsets within ±50 ms', () => {
    const segs = Array.from({ length: 6 }, (_, i) => [0.3 + i * 0.18, 0.45 + i * 0.18]);
    const x = P.synth({ seconds: 1.6, f0: (t) => (segs.some(([a, b]) => t >= a && t < b) ? A : 0), env: env(segs) });
    const { events } = P.analyse(x);
    expect(events).toHaveLength(6);
    events.forEach((ev, i) => {
      expect(Math.abs(sec(ev.startFrame2) - segs[i][0])).toBeLessThanOrEqual(0.05);
      expect(Math.abs(sec(ev.endFrame2) - segs[i][1])).toBeLessThanOrEqual(0.05);
      expect(ev.observedMidi).toBe(69);
    });
  });

  it('splits re-attacks without silence (portato dips of -15 dB) but not a ±6 dB tremolo', () => {
    const portato = P.synth({ seconds: 2.2, f0: (t) => (t >= 0.2 && t < 2 ? A : 0), env: (t) => (t < 0.2 || t >= 2 ? 0 : ((t - 0.2) % 0.45 > 0.39 ? 10 ** (-15 / 20) : Math.min(1, (t - 0.2) / 0.01))) });
    expect(P.analyse(portato).events.map((e) => e.startBoundary)).toEqual(['onset', 'reattack', 'reattack', 'reattack']);
    const tremolo = P.synth({ seconds: 3, f0: (t) => (t >= 0.2 && t < 2.8 ? A : 0), env: (t) => (t < 0.2 || t >= 2.8 ? 0 : 10 ** ((6 * Math.sin(2 * Math.PI * 5 * t)) / 20)) });
    expect(P.analyse(tremolo).events).toHaveLength(1);
  });

  it('splits a legato pitch change within ±50 ms and never splits a vibrato (3-10 Hz, up to ±50 cent)', () => {
    const legato = P.synth({ seconds: 2, f0: (t) => (t < 0.2 || t >= 1.8 ? 0 : A * 2 ** ((200 * Math.floor((t - 0.2) / 0.4)) / 1200)), env: (t) => (t < 0.2 || t >= 1.8 ? 0 : 1) });
    const ev = P.analyse(legato).events;
    expect(ev.map((e) => e.observedMidi)).toEqual([69, 71, 73, 75]);
    [0.6, 1.0, 1.4].forEach((truth, i) => expect(Math.abs(sec(ev[i + 1].startFrame2) - truth)).toBeLessThanOrEqual(0.05));
    expect(ev[1].attackEligible).toBe(true);
    for (const rate of [3, 5.5, 7.5, 10]) {
      const vib = P.synth({ seconds: 3.4, f0: (t) => (t < 0.2 || t >= 3.2 ? 0 : A * 2 ** ((50 * Math.sin(2 * Math.PI * rate * t)) / 1200)), env: (t) => (t < 0.2 || t >= 3.2 ? 0 : 1) });
      expect(P.analyse(vib, { profile: 'vibrato' }).events, `rate ${rate}`).toHaveLength(1);
    }
  });

  it('a target change splits without counting a new attack or attempt', () => {
    const x = P.synth({ seconds: 2, f0: (t) => (t >= 0.2 && t < 1.8 ? A : 0), env: (t) => (t < 0.2 || t >= 1.8 ? 0 : 1) });
    const { events } = P.analyse(x, { boundaries: [{ frame2: 2 * SR, type: 'targetChange' }] });
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ startBoundary: 'targetChange', attackEligible: false, countsAsAttempt: false });
  });

  it('never bridges an input gap: the note ends there and no value is interpolated', () => {
    const x = P.synth({ seconds: 2, f0: (t) => (t >= 0.2 && t < 1.8 ? A : 0), env: (t) => (t < 0.2 || t >= 1.8 ? 0 : 1) });
    const { events, snap } = P.analyse(x, { dropAt: [{ frame: 48000, length: 4096 }] });
    expect(events.length).toBeGreaterThanOrEqual(2);
    const t2 = Array.from(snap.series.frame2).map(sec);
    // No frame is centred inside the dropped audio.
    expect(t2.filter((t) => t > 1.0 + 0.045 && t < 1.0 + 4096 / SR - 0.045)).toEqual([]);
    expect(events.every((e) => !(sec(e.startFrame2) < 1.0 && sec(e.endFrame2) > 1.0 + 4096 / SR))).toBe(true);
  });
});

describe('long-tone metrics against known truth', () => {
  it('separates attack, steady and release and reports them independently', () => {
    // -30 cent scoop decaying with 60 ms, steady +4 cent, release falls -20 cent in the last 150 ms.
    const total = 2;
    const f0 = (t) => {
      if (t < 0.3 || t >= 0.3 + total) return 0;
      const u = t - 0.3;
      let c = 4 - 34 * Math.exp(-u / 0.06);
      if (u > total - 0.15) c -= 20 * (u - (total - 0.15)) / 0.15;
      return A * 2 ** (c / 1200);
    };
    const x = P.synth({ seconds: 2.6, f0, env: (t) => (t >= 0.3 && t < 2.3 ? 1 : 0), noiseDbfs: -70 });
    const { events, snap } = P.analyse(x, { profile: 'high' });
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(Math.abs(sec(ev.startFrame2) - 0.3)).toBeLessThanOrEqual(0.05);
    expect(Math.abs(sec(ev.endFrame2) - 2.3)).toBeLessThanOrEqual(0.05);
    // Judged against the steady pitch (+4 cent) so the tone becomes stable.
    const target = A * 2 ** (4 / 1200);
    const st = statsFor(snap, ev, target);
    expect(st.steady.medianCents).toBeCloseTo(0, 0);
    expect(Math.abs(st.steady.sdCents)).toBeLessThan(1);
    expect(st.attack.medianCents).toBeLessThan(st.steady.medianCents - 3); // the scoop is visible, not overwritten
    expect(st.release.medianCents).toBeLessThan(st.steady.medianCents - 2);
    expect(st.stabilization.seconds).toBeGreaterThan(0);
    expect(st.meanCents).not.toBeNull();
    expect(st.medianCents).toBeCloseTo(0, 0);
    // Against the nominal A the same tone is never within ±3 cent: no stabilisation time.
    expect(statsFor(snap, ev, A).stabilization).toBeNull();
  });

  it('missing observations are excluded time, never 0 cent, and coverage shows it', () => {
    const frame2 = Float64Array.from([0, 1, 2, 3, 4, 5, 6, 7].map((k) => 2 * k * 1600));
    const series = { frame2, hz: Float32Array.from([442, 442, NaN, NaN, NaN, 442, 442, 442]), reason: Uint8Array.from([0, 0, 1, 1, 1, 0, 0, 0]), flags: new Uint8Array(8), rms: new Float32Array(8).fill(-30), sampleRate: SR, expectedHop2: 3200 };
    // Event bounds half a hop around the first/last centres: 8 hops in total.
    const st = S.eventStats({ series, i0: 0, i1: 7, startFrame2: -1600, endFrame2: 2 * 7 * 1600 + 1600, targetHz: 442, toleranceCents: 3 });
    expect(st.meanCents).toBeCloseTo(0, 9);
    expect(st.observationCount).toBe(5);
    expect(st.excludedByReason.quiet).toBeCloseTo(3 * 1600 / SR, 9);
    expect(st.coverage).toBeCloseTo(5 / 8, 6);
    expect(st.validMaintenance).toBe(1);
  });

  it('weights irregular hops by time, not by frame count, and leaves big gaps unknown', () => {
    // Dense +10 cent frames for 0.1 s and sparse 0 cent frames for 0.4 s.
    const t = [];
    const c = [];
    for (let k = 0; k < 10; k += 1) { t.push(0.01 * k); c.push(10); }
    for (let k = 0; k < 8; k += 1) { t.push(0.1 + 0.05 * k); c.push(0); }
    const series = { frame2: Float64Array.from(t.map((v) => 2 * v * SR)), hz: Float32Array.from(c.map((v) => 442 * 2 ** (v / 1200))), reason: new Uint8Array(t.length), flags: new Uint8Array(t.length), sampleRate: SR, expectedHop2: 2 * 0.05 * SR };
    const st = S.eventStats({ series, i0: 0, i1: t.length - 1, startFrame2: 0, endFrame2: 2 * 0.5 * SR, targetHz: 442 });
    expect(st.meanCents).toBeLessThan(3.5); // a frame mean would be 10*10/18 = 5.6
    expect(st.meanCents).toBeGreaterThan(1.5);
    const gapSeries = { frame2: Float64Array.from([0, 0.05, 0.4, 0.45].map((v) => 2 * v * SR)), hz: new Float32Array(4).fill(442), reason: new Uint8Array(4), flags: new Uint8Array(4), sampleRate: SR, expectedHop2: 2 * 0.05 * SR };
    const g = S.eventStats({ series: gapSeries, i0: 0, i1: 3, startFrame2: 0, endFrame2: 2 * 0.5 * SR, targetHz: 442 });
    expect(g.excludedByReason.unknown).toBeGreaterThan(0.25);
  });

  it('drift is the weighted slope over effective time', () => {
    const x = P.synth({ seconds: 3.4, f0: (t) => (t >= 0.2 && t < 3.2 ? A * 2 ** ((10 * (t - 0.2) / 3) / 1200) : 0), env: (t) => (t >= 0.2 && t < 3.2 ? 1 : 0) });
    const { events, snap } = P.analyse(x);
    const st = statsFor(snap, events[0], A);
    expect(st.driftCentsPerSec).toBeCloseTo(10 / 3, 0);
  });

  it('glissando: values match the truth at the effective time (window centre)', () => {
    const f0 = (t) => (t < 0.3 || t >= 2.3 ? 0 : A * 2 ** ((100 * Math.min(1, Math.max(0, t - 0.8) / 1)) / 1200));
    const x = P.synth({ seconds: 2.6, f0, env: (t) => (t >= 0.3 && t < 2.3 ? 1 : 0) });
    const { snap } = P.analyse(x);
    const s = snap.series;
    const errs = [];
    for (let i = 0; i < s.frame2.length; i += 1) {
      const t = sec(s.frame2[i]);
      if (!(s.hz[i] > 0) || t < 0.9 || t > 1.7) continue;
      errs.push(1200 * Math.log2(s.hz[i] / f0(t)));
    }
    expect(errs.length).toBeGreaterThan(10);
    expect(Math.max(...errs.map(Math.abs))).toBeLessThan(1);
  });
});

describe('vibrato analysis (known rate / extent)', () => {
  const cases = [];
  for (const base of [261.63, 880]) for (const rate of [3, 5.5, 7.5, 10]) for (const semi of [10, 30, 50]) cases.push([base, rate, semi]);
  it('short-window profile: rate within ±0.1 Hz and extent within ±10 % (40 frames/s)', { timeout: 120000 }, () => {
    for (const [base, rate, semi] of cases) {
      const x = P.synth({ seconds: 3.4, f0: (t) => (t < 0.2 || t >= 3.2 ? 0 : base * 2 ** ((3 + semi * Math.sin(2 * Math.PI * rate * t)) / 1200)), env: (t) => (t < 0.2 || t >= 3.2 ? 0 : 1), seed: rate * 10 + semi });
      const { events, snap } = P.analyse(x, { profile: 'vibrato' });
      expect(events, `${base} ${rate} ${semi}`).toHaveLength(1);
      const st = statsFor(snap, events[0], base);
      const v = S.analyzeVibrato(st.observations);
      expect(v.status, `${base} ${rate} ${semi}`).toBe('ok');
      expect(Math.abs(v.rateHz - rate), `${base} ${rate} ${semi}`).toBeLessThanOrEqual(0.1);
      expect(Math.abs(v.semiExtentCents / semi - 1), `${base} ${rate} ${semi}`).toBeLessThanOrEqual(0.1);
      expect(v.fullExtentCents).toBeCloseTo(2 * v.semiExtentCents, 9);
      expect(Math.abs(v.centerCents - 3)).toBeLessThan(1);
    }
  });

  it('holds instead of reporting attenuated numbers from the long window, short notes or a steady tone', () => {
    const vib = P.synth({ seconds: 3.4, f0: (t) => (t < 0.2 || t >= 3.2 ? 0 : A * 2 ** ((30 * Math.sin(2 * Math.PI * 6 * t)) / 1200)), env: (t) => (t < 0.2 || t >= 3.2 ? 0 : 1) });
    const full = P.analyse(vib, { profile: 'full' });
    expect(S.analyzeVibrato(statsFor(full.snap, full.events[0], A).observations)).toMatchObject({ status: 'held', reason: 'long-window' });
    const short = P.synth({ seconds: 1.6, f0: (t) => (t < 0.2 || t >= 1.4 ? 0 : A * 2 ** ((30 * Math.sin(2 * Math.PI * 6 * t)) / 1200)), env: (t) => (t < 0.2 || t >= 1.4 ? 0 : 1) });
    const s = P.analyse(short, { profile: 'vibrato' });
    expect(S.analyzeVibrato(statsFor(s.snap, s.events[0], A).observations)).toMatchObject({ status: 'held', reason: 'too-short' });
    const steady = P.synth({ seconds: 3.4, f0: (t) => (t < 0.2 || t >= 3.2 ? 0 : A), env: (t) => (t < 0.2 || t >= 3.2 ? 0 : 1) });
    const st = P.analyse(steady, { profile: 'vibrato' });
    expect(S.analyzeVibrato(statsFor(st.snap, st.events[0], A).observations).status).not.toBe('ok');
  });

  it('display smoothing would distort the extent, so analysis never uses it', () => {
    // Exponential smoothing (120 ms) of a 6 Hz ±30 cent swing keeps < 40 % of it.
    const alpha = 1 - Math.exp(-25 / 120);
    let y = 0;
    let max = 0;
    for (let k = 0; k < 400; k += 1) {
      const v = 30 * Math.sin(2 * Math.PI * 6 * k * 0.025);
      y += alpha * (v - y);
      if (k > 100) max = Math.max(max, Math.abs(y));
    }
    expect(max).toBeLessThan(0.4 * 30);
    // The analysis input is the store's raw series (no display filter in the chain).
    const src = require('node:fs').readFileSync(path.join(process.cwd(), 'src/static/js/modules/tuner/analysis_stats.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(src).not.toMatch(/displayFilter|smooth/i);
  });
});

describe('octave-ambiguous inputs are flagged and held, never counted as accurate', () => {
  it('flags missing / weak fundamentals (C6-C8) and keeps identifiable tones clean', () => {
    const run = (amps, midi) => {
      const f = 440 * 2 ** ((midi - 69) / 12);
      const x = P.synth({ seconds: 0.6, f0: () => f, amps, peak: 0.3 });
      const frames = P.runWorker(x).filter((m) => m.type === 'pitch' && m.frame.valid).map((m) => m.frame);
      return { frames, f };
    };
    let flaggedWrong = 0;
    let wrong = 0;
    for (let midi = 84; midi <= 108; midi += 4) {
      const { frames, f } = run([0, 1, 1, 1, 1, 1, 1, 1], midi);
      frames.forEach((fr) => {
        const err = Math.abs(1200 * Math.log2(fr.frequency / f));
        if (err > 50) { wrong += 1; if (fr.octaveAmbiguous) flaggedWrong += 1; }
      });
      const clean = run([1, 0.5, 0.33, 0.25, 0.2], midi);
      expect(clean.frames.some((fr) => fr.octaveAmbiguous), `clean midi ${midi}`).toBe(false);
    }
    expect(flaggedWrong).toBe(wrong); // every wrong octave was flagged (synthetic set)
    // Flagged frames are excluded from statistics with their reason.
    const series = { frame2: Float64Array.from([0, 3200]), hz: Float32Array.from([440, 440]), reason: new Uint8Array(2), flags: Uint8Array.from([8, 0]), sampleRate: SR, expectedHop2: 3200 };
    expect(S.eventStats({ series, i0: 0, i1: 1, startFrame2: 0, endFrame2: 4800, targetHz: 440 }).excludedByReason.ambiguous).toBeGreaterThan(0);
  });
});
