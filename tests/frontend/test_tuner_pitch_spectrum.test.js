import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const root = process.cwd();
const fft = require(path.join(root, 'src/static/js/modules/tuner/fft.js'));
const pitch = require(path.join(root, 'src/static/js/modules/tuner/pitch.js'));
const spectrum = require(path.join(root, 'src/static/js/modules/tuner/spectrum.js'));

function randomGenerator(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296 * 2 - 1;
  };
}

// Synthetic test tones. Amplitudes stay well below full scale.
function synth(sampleRate, frequency, length, kind, seed = 1) {
  const random = randomGenerator(seed);
  const out = new Float32Array(length);
  const phase = 0.37;
  for (let i = 0; i < length; i += 1) {
    const t = i / sampleRate;
    let v = 0;
    if (kind === 'sine' || kind === 'noise20' || kind === 'noise30') v = 0.5 * Math.sin(2 * Math.PI * frequency * t + phase);
    if (kind === 'rich') {
      for (let h = 1; h <= 12 && h * frequency < sampleRate / 2; h += 1) v += (0.4 / h) * Math.sin(2 * Math.PI * h * frequency * t + phase * h);
    }
    if (kind === 'missing') {
      // Harmonics 2-8 at equal level, no fundamental.
      for (let h = 2; h <= 8 && h * frequency < sampleRate / 2; h += 1) v += 0.15 * Math.sin(2 * Math.PI * h * frequency * t + phase * h);
    }
    // White noise; SNR relative to the 0.5-amplitude sine (power 0.125).
    if (kind === 'noise20') v += Math.sqrt(3 * 0.125 / 100) * random();
    if (kind === 'noise30') v += Math.sqrt(3 * 0.125 / 1000) * random();
    out[i] = v;
  }
  return out;
}

function centsError(measured, actual) {
  return 1200 * Math.log2(measured / actual);
}

// Off-grid frequencies (+8.1 cents) so results are not tuned to exact bins.
function testFrequency(midi) {
  return 440 * 2 ** ((midi - 69) / 12) * 2 ** (8.1 / 1200);
}

function sweep(sampleRate, kind, fromMidi, toMidi) {
  const detector = pitch.createPitchDetector({ sampleRate });
  const rows = [];
  for (let midi = fromMidi; midi <= toMidi; midi += 1) {
    const f = testFrequency(midi);
    const result = detector.detect(synth(sampleRate, f, detector.frameLength, kind, midi));
    rows.push({ midi, valid: result.valid, error: result.valid ? centsError(result.frequency, f) : NaN, confidence: result.confidence });
  }
  return rows;
}

describe('tuner FFT', () => {
  it('matches a direct DFT and round-trips through the inverse', () => {
    const random = randomGenerator(7);
    const size = 32;
    const input = Array.from({ length: size }, () => random());
    const re = Float64Array.from(input);
    const im = new Float64Array(size);
    fft.transform(re, im, false);
    for (let k = 0; k < size; k += 1) {
      let sr = 0;
      let si = 0;
      for (let n = 0; n < size; n += 1) {
        sr += input[n] * Math.cos((-2 * Math.PI * k * n) / size);
        si += input[n] * Math.sin((-2 * Math.PI * k * n) / size);
      }
      expect(re[k]).toBeCloseTo(sr, 9);
      expect(im[k]).toBeCloseTo(si, 9);
    }
    fft.transform(re, im, true);
    for (let n = 0; n < size; n += 1) expect(re[n] / size).toBeCloseTo(input[n], 12);
    expect(() => fft.transform(new Float64Array(12), new Float64Array(12), false)).toThrow();
  });
});

describe('tuner YIN difference function', () => {
  it.each([
    [8, 7, 3],
    [64, 50, 11],
    [300, 257, 5],
  ])('FFT version equals the direct sum (W=%i, tauMax=%i)', (windowLength, tauMax, seed) => {
    const random = randomGenerator(seed);
    const x = Float64Array.from({ length: windowLength + tauMax + 1 }, () => random());
    const direct = pitch.differenceDirect(x, windowLength, tauMax);
    const fast = pitch.differenceFFT(x, windowLength, tauMax);
    for (let tau = 0; tau <= tauMax; tau += 1) {
      expect(Math.abs(fast[tau] - direct[tau])).toBeLessThan(1e-9 * Math.max(1, direct[tau]));
    }
  });

  it('zero-pads enough to avoid circular wrap-around', () => {
    const geometry = pitch.frameGeometry(48000, 31, 4400);
    const workspace = pitch.createDifferenceWorkspace(geometry.frameLength, geometry.windowLength);
    expect(workspace.size).toBeGreaterThanOrEqual(geometry.frameLength + geometry.windowLength - 1);
    // A frame whose end differs strongly from its start would leak into small
    // lags if the correlation wrapped around; the direct sum is the reference.
    const random = randomGenerator(3);
    const x = Float64Array.from({ length: 120 }, (_, i) => (i > 90 ? 5 : 0) + random() * 0.1);
    const direct = pitch.differenceDirect(x, 60, 59);
    const fast = pitch.differenceFFT(x, 60, 59);
    for (let tau = 0; tau < 60; tau += 1) expect(fast[tau]).toBeCloseTo(direct[tau], 8);
  });

  it('searches roughly 31-4,400 Hz (C1-C8 for A4 = 430-450 Hz)', () => {
    const detector = pitch.createPitchDetector({ sampleRate: 48000 });
    expect(48000 / detector.tauMax).toBeLessThanOrEqual(31);
    expect(48000 / detector.tauMin).toBeGreaterThanOrEqual(4400);
    expect(440 * 2 ** ((24 - 69) / 12) * (430 / 440)).toBeGreaterThan(31);
    expect(440 * 2 ** ((108 - 69) / 12) * (450 / 440)).toBeLessThan(4400);
  });
});

describe('tuner pitch accuracy on synthetic tones', () => {
  for (const sampleRate of [48000, 44100]) {
    it(`pure and harmonic-rich tones are within ±2 cents from C1 to C8 at ${sampleRate} Hz`, () => {
      for (const kind of ['sine', 'rich']) {
        for (const row of sweep(sampleRate, kind, 24, 108)) {
          expect(row.valid, `${kind} midi ${row.midi}`).toBe(true);
          expect(Math.abs(row.error), `${kind} midi ${row.midi}`).toBeLessThanOrEqual(2);
        }
      }
    });

    it(`missing-fundamental tones (harmonics 2-8 equal) resolve to the fundamental C1-C7 at ${sampleRate} Hz`, () => {
      for (const row of sweep(sampleRate, 'missing', 24, 96)) {
        expect(row.valid, `midi ${row.midi}`).toBe(true);
        expect(Math.abs(row.error), `midi ${row.midi}`).toBeLessThanOrEqual(2);
      }
    });

    it(`noise-mixed tones: SNR 30 dB within ±2 cents C2-C8, SNR 20 dB within ±6 cents C1-C8 at ${sampleRate} Hz`, () => {
      for (const row of sweep(sampleRate, 'noise30', 36, 108)) {
        expect(row.valid, `30dB midi ${row.midi}`).toBe(true);
        expect(Math.abs(row.error), `30dB midi ${row.midi}`).toBeLessThanOrEqual(2);
      }
      for (const row of sweep(sampleRate, 'noise20', 24, 108)) {
        expect(row.valid, `20dB midi ${row.midi}`).toBe(true);
        expect(Math.abs(row.error), `20dB midi ${row.midi}`).toBeLessThanOrEqual(6);
      }
    });
  }

  it('treats silence and broadband noise as no pitch', () => {
    const detector = pitch.createPitchDetector({ sampleRate: 48000 });
    const silent = detector.detect(new Float32Array(detector.frameLength));
    expect(silent).toMatchObject({ valid: false, reason: 'silent' });
    const random = randomGenerator(11);
    const quiet = Float32Array.from({ length: detector.frameLength }, () => random() * 0.0005);
    expect(detector.detect(quiet).valid).toBe(false);
    const loudNoise = Float32Array.from({ length: detector.frameLength }, () => random() * 0.3);
    const noise = detector.detect(loudNoise);
    expect(noise.valid).toBe(false);
    expect(noise.reason).toBe('unstable');
  });

  it('rejects frames containing an attack or a sudden stop', () => {
    const detector = pitch.createPitchDetector({ sampleRate: 48000 });
    const n = detector.frameLength;
    const tone = synth(48000, 440, n, 'sine');
    // Quiet (-26 dB) before/after rather than exact zeros, which would be a dropout.
    const attack = tone.map((v, i) => (i < n * 0.4 ? v * 0.05 : v));
    expect(detector.detect(attack)).toMatchObject({ valid: false, reason: 'unstable' });
    const stop = tone.map((v, i) => (i > n * 0.6 ? v * 0.05 : v));
    expect(detector.detect(stop)).toMatchObject({ valid: false, reason: 'unstable' });
    // A moderate decay (3 dB across the frame, e.g. a plucked note) is still measured.
    const decaying = tone.map((v, i) => v * 10 ** ((-3 * i) / n / 20));
    expect(detector.detect(decaying).valid).toBe(true);
  });

  it('rejects audible frames containing an audio dropout (run of exact zeros)', () => {
    const detector = pitch.createPitchDetector({ sampleRate: 48000 });
    const tone = synth(48000, 440, detector.frameLength, 'sine');
    tone.fill(0, 1000, 1024); // 24-sample buffer underrun
    expect(detector.detect(tone)).toMatchObject({ valid: false, reason: 'dropout' });
    const short = synth(48000, 440, detector.frameLength, 'sine');
    short.fill(0, 1000, 1004); // a few exact zeros can occur in a real waveform
    expect(detector.detect(short).valid).toBe(true);
  });

  it('removes DC offset before measuring', () => {
    const detector = pitch.createPitchDetector({ sampleRate: 48000 });
    const tone = synth(48000, 440, detector.frameLength, 'sine').map((v) => v + 0.3);
    const result = detector.detect(tone);
    expect(result.valid).toBe(true);
    expect(Math.abs(centsError(result.frequency, 440))).toBeLessThan(0.5);
    expect(result.rmsDbfs).toBeCloseTo(20 * Math.log10(0.5 / Math.SQRT2), 0);
  });
});

describe('tuner spectrum levels and harmonics', () => {
  const sampleRate = 48000;
  const analyzer = spectrum.createSpectrumAnalyzer({ sampleRate });

  it('reads a full-scale sine on a bin centre as 0 dBFS and scales linearly', () => {
    const k = 300;
    const f = k * analyzer.binHz;
    const full = Float32Array.from({ length: analyzer.fftSize }, (_, i) => Math.sin((2 * Math.PI * f * i) / sampleRate));
    const result = analyzer.analyze(full);
    expect(result.binDb[k]).toBeCloseTo(0, 2);
    const tenth = full.map((v) => v * 0.1);
    expect(analyzer.analyze(tenth).binDb[k]).toBeCloseTo(-20, 2);
  });

  it('band power is 0 dBFS for a full-scale sine even between bins', () => {
    const f = 300.5 * analyzer.binHz;
    const full = Float32Array.from({ length: analyzer.fftSize }, (_, i) => Math.sin((2 * Math.PI * f * i) / sampleRate));
    const result = analyzer.analyze(full);
    // The peak bin shows Hann scalloping loss (about -1.4 dB)...
    expect(result.binDb[300]).toBeLessThan(-1);
    // ...but the band power integrates the main lobe.
    expect(analyzer.bandPowerDb(f, 3 * analyzer.binHz)).toBeCloseTo(0, 1);
  });

  it('measures each harmonic from band power and marks validity', () => {
    const f0 = 220;
    const tone = synth(sampleRate, f0, analyzer.fftSize, 'rich');
    analyzer.analyze(tone);
    const list = analyzer.harmonics(f0);
    expect(list[0]).toMatchObject({ number: 1, valid: true });
    for (const n of [1, 2, 3, 5, 8]) {
      expect(list[n - 1].powerDbfs).toBeCloseTo(20 * Math.log10(0.4 / n), 0);
    }
    expect(list.every((item) => item.frequency <= 10000)).toBe(true);
    // Too low to separate neighbouring harmonics with this window: not valid.
    expect(analyzer.harmonics(12)[0].valid).toBe(false);
  });

  it('keeps 512 log-spaced display points and blanks those above Nyquist', () => {
    const low = spectrum.createSpectrumAnalyzer({ sampleRate: 16000 });
    const tone = synth(16000, 1000, low.fftSize, 'sine');
    low.analyze(tone);
    const display = low.reduceForDisplay();
    expect(display).toHaveLength(512);
    expect(low.displayFrequencies[0]).toBeCloseTo(25, 6);
    expect(low.displayFrequencies[511]).toBeCloseTo(10000, 6);
    const aboveNyquist = Array.from(low.displayFrequencies).map((f, i) => [f, display[i]]).filter(([f]) => f >= 8000);
    expect(aboveNyquist.length).toBeGreaterThan(0);
    expect(aboveNyquist.every(([, value]) => Number.isNaN(value))).toBe(true);
    const peakIndex = display.reduce((best, value, i) => (value > display[best] ? i : best), 0);
    expect(Math.abs(centsError(low.displayFrequencies[peakIndex], 1000))).toBeLessThan(30);
    expect(low.harmonics(3000).every((item) => item.frequency < 8000)).toBe(true);
  });
});
