import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const pipeline = require('./helpers/tuner_pipeline.cjs');
const dir = path.join(process.cwd(), 'src/static/js/modules/tuner');
for (const name of ['music', 'temperament', 'target_model', 'playback', 'analysis_stats']) require(path.join(dir, `${name}.js`));
const L = globalThis.PortalTunerLib;
const sound = require(path.join(dir, 'view_sound.js'));
const stats = L.analysisStats;

describe('harmonics through the real analysis worker (A-007 / HA-001)', () => {
  it('relative strengths of a known harmonic tone (amplitudes 1, 1/2, 1/4)', () => {
    const sr = 48000;
    const samples = pipeline.synth({ sampleRate: sr, seconds: 2, f0: () => 220, amps: [1, 0.5, 0.25], noiseDbfs: -90, seed: 9 });
    const { snap } = pipeline.collect(pipeline.runWorker(samples), sr);
    const steady = snap.harmonics.filter((hm) => hm.window === 16384 || hm.window === 4096);
    expect(steady.length).toBeGreaterThan(0);
    const summary = stats.harmonicSummary(steady.filter((hm) => hm.window === steady[steady.length - 1].window), steady[steady.length - 1].window);
    const rel = Object.fromEntries(summary.harmonics.map((hm) => [hm.number, hm.relDb]));
    expect(rel[2]).toBeGreaterThan(-6.02 - 1.5);
    expect(rel[2]).toBeLessThan(-6.02 + 1.5);
    expect(rel[3]).toBeGreaterThan(-12.04 - 1.5);
    expect(rel[3]).toBeLessThan(-12.04 + 1.5);
  });

  it('clipped frames are excluded from harmonic summaries', () => {
    const frames = [
      { harmonics: [{ number: 2, powerDbfs: -20, relDb: -6, valid: true }] },
      { clipped: true, harmonics: [{ number: 2, powerDbfs: 0, relDb: 0, valid: true }] },
    ];
    const s = stats.harmonicSummary(frames, 16384);
    expect(s.frameCount).toBe(1);
    expect(s.harmonics[0].relDb).toBe(-6);
  });
});

describe('same-note harmonic comparison (HA-004 / HA-005)', () => {
  const ev = (midi, level, h2) => ({ target: { midi, label: 'X' }, stats: { medianLevelDbfs: level }, harmonicsSteady: { frameCount: 10, window: 16384, harmonics: [{ number: 2, relDb: h2 }, { number: 3, relDb: null }] } });

  it('groups by target note, orders by level and needs a 6 dB level spread for dynamics', () => {
    const groups = stats.harmonicComparison([ev(69, -20, -3), ev(69, -35, -9), ev(60, -25, -5), ev(69, -30, -6), { target: null }]);
    expect(groups.map((g) => [g.midi, g.status])).toEqual([[60, 'insufficient'], [69, 'ok']]);
    const a4 = groups[1];
    expect(a4.rows.map((r) => r.levelDbfs)).toEqual([-35, -30, -20]);
    expect(a4.rows.map((r) => r.relDb[2])).toEqual([-9, -6, -3]);
    expect(a4.rows[0].relDb[3]).toBeNull(); // missing stays missing
    expect(a4.dynamics).toBe('comparable');
    const close = stats.harmonicComparison([ev(69, -20, -3), ev(69, -22, -4)]);
    expect(close[0].dynamics).toBe('level-difference-too-small');
  });
});

describe('chord presets and temperament-linked voices (S-008 / S-010)', () => {
  it('chord presets give the documented equal-tempered semitones', () => {
    const expected = { major: [0, 4, 7], minor: [0, 3, 7], dominant7: [0, 4, 7, 10], major7: [0, 4, 7, 11], minor7: [0, 3, 7, 10], halfDiminished7: [0, 3, 6, 10], diminished7: [0, 3, 6, 9] };
    for (const [id, semis] of Object.entries(expected)) {
      const voices = sound.chordVoices(id, 60, false);
      expect(voices.map((v) => v.midi - 60), id).toEqual(semis);
    }
  });

  it('a just chord uses the temperament ratios; chords without a just definition stay equal', () => {
    const just = sound.chordVoices('major', 60, true);
    expect(just.every((v) => v.source === 'linked')).toBe(true);
    const ctx = (target) => ({ lib: L, a4Hz: 442, target });
    const c4 = 442 * 2 ** ((60 - 69) / 12);
    const third = just.find((v) => v.role === 'third');
    const resolved = sound.resolveVoices([third], ctx(L.targetModel.normalizeConfig({ temperament: 'just-major', rootMidi: 60, role: 'third' })));
    expect(resolved.ok).toBe(true);
    expect(resolved.voices[0].frequency / c4).toBeCloseTo(5 / 4, 9);
    expect(sound.chordVoices('diminished7', 60, true).every((v) => v.source === 'note')).toBe(true);
  });

  it('refuses voices outside the playback range', () => {
    const res = sound.resolveVoices([{ source: 'hz', hzText: '5000' }], { lib: L, a4Hz: 442, target: null });
    expect(res.ok).toBe(false);
    expect(res.errors.join(' ')).toMatch(/28\.0～4,700\.0 Hz/);
  });
});
