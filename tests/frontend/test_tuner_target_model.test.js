import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const dir = path.join(process.cwd(), 'src/static/js/modules/tuner');
const tm = require(path.join(dir, 'target_model.js'));
const temperament = require(path.join(dir, 'temperament.js'));
const displayFilter = require(path.join(dir, 'display_filter.js'));

// Expected values are written from the definitions (ratios, powers of two),
// independent of the implementation's helper functions.
const rel = (a, b) => Math.abs(a - b) / b;
const equal = (midi, a4) => a4 * Math.pow(2, (midi - 69) / 12);

describe('target model: equal temperament', () => {
  it('matches A4 * 2^((n-69)/12) for A4 = 390/430/440/442/450/480 and C1..C8', () => {
    for (const a4 of [390, 430, 440, 442, 450, 480]) {
      for (let midi = 24; midi <= 108; midi += 1) {
        const r = tm.resolve({ temperament: 'equal', a4Tenths: a4 * 10, fixedMidi: midi });
        expect(rel(r.targetHz, equal(midi, a4)), `${a4} ${midi}`).toBeLessThanOrEqual(1e-9);
        expect(r.equalHz).toBe(r.targetHz);
      }
    }
    expect(tm.resolve({ temperament: 'equal', a4Tenths: 3900, fixedMidi: 24 }).targetHz).toBeCloseTo(28.9869, 3);
    expect(tm.resolve({ temperament: 'equal', a4Tenths: 4800, fixedMidi: 108 }).targetHz).toBeCloseTo(4566.5553, 3);
  });

  it('auto picks the nearest note; a fixed note is kept whatever is played', () => {
    expect(tm.resolve({ temperament: 'equal', a4Tenths: 4420 }, 445).midi).toBe(69);
    expect(tm.resolve({ temperament: 'equal', a4Tenths: 4420 }, 460).midi).toBe(70);
    expect(tm.resolve({ temperament: 'equal', a4Tenths: 4420, fixedMidi: 60 }, 460).midi).toBe(60);
    expect(tm.resolve({ temperament: 'equal', a4Tenths: 4420 }, null)).toBeNull();
  });

  it('0.1 Hz A4 values are exact (442.5 Hz)', () => {
    expect(tm.resolve({ temperament: 'equal', a4Tenths: 4425, fixedMidi: 69 }).targetHz).toBe(442.5);
  });
});

describe('target model: just intonation', () => {
  it('keeps the existing thirds identical to temperament.justTarget', () => {
    for (const mode of ['minor-third', 'major-third']) {
      for (const root of [24, 60, 104]) {
        const old = temperament.justTarget(mode, root, 442);
        const now = tm.resolve({ temperament: mode, rootMidi: root, a4Tenths: 4420 });
        expect(now.targetHz).toBe(old.targetFrequency);
        expect(now.midi).toBe(old.target.midi);
      }
    }
  });

  it('triads: root * {1, 5/4, 3/2} and {1, 6/5, 3/2}, octave shifts by 2^k', () => {
    const root = equal(60, 442);
    const cases = [
      ['just-major', 'root', 1], ['just-major', 'third', 5 / 4], ['just-major', 'fifth', 3 / 2],
      ['just-minor', 'root', 1], ['just-minor', 'third', 6 / 5], ['just-minor', 'fifth', 3 / 2],
    ];
    for (const [t, role, ratio] of cases) {
      const r = tm.resolve({ temperament: t, rootMidi: 60, role, a4Tenths: 4420 });
      expect(rel(r.targetHz, root * ratio), `${t} ${role}`).toBeLessThanOrEqual(1e-9);
      const up = tm.resolve({ temperament: t, rootMidi: 60, role, octaveShift: 1, a4Tenths: 4420 });
      expect(rel(up.targetHz, root * ratio * 2)).toBeLessThanOrEqual(1e-9);
      expect(up.midi).toBe(r.midi + 12);
    }
    // Major third 386.3137 cents = -13.6863 from equal temperament.
    expect(tm.resolve({ temperament: 'just-major', rootMidi: 60, role: 'third', a4Tenths: 4420 }).equalCentsOffset).toBeCloseTo(-13.6863, 4);
    expect(tm.resolve({ temperament: 'just-minor', rootMidi: 60, role: 'third', a4Tenths: 4420 }).equalCentsOffset).toBeCloseTo(15.6413, 4);
    expect(tm.resolve({ temperament: 'just-major', rootMidi: 60, role: 'fifth', a4Tenths: 4420 }).equalCentsOffset).toBeCloseTo(1.955, 3);
  });

  it('sevenths: 15/8 (major), 9/5 default, 16/9 and 7/4 selectable', () => {
    const root = equal(60, 440);
    for (const [seventh, ratio] of [['major-15/8', 15 / 8], ['minor-9/5', 9 / 5], ['minor-16/9', 16 / 9], ['minor-7/4', 7 / 4]]) {
      const r = tm.resolve({ temperament: 'just-major', rootMidi: 60, role: 'seventh', seventh, a4Tenths: 4400 });
      expect(rel(r.targetHz, root * ratio), seventh).toBeLessThanOrEqual(1e-9);
    }
    expect(tm.resolve({ temperament: 'just-major', rootMidi: 60, role: 'seventh', a4Tenths: 4400 }).targetHz).toBeCloseTo(root * 9 / 5, 9);
  });

  it('a role outside C1..C8 is not selectable', () => {
    expect(tm.resolve({ temperament: 'just-major', rootMidi: 104, role: 'fifth', a4Tenths: 4420 })).toBeNull();
    expect(tm.resolve({ temperament: 'just-major', rootMidi: 100, role: 'root', octaveShift: 1, a4Tenths: 4420 })).toBeNull();
  });
});

describe('target model: Pythagorean and custom', () => {
  // Cents of (3/2)^k folded into one octave, k = -3..8 around C (E-flat..G-sharp).
  const PYTH = { 0: 0, 1: 113.685, 2: 203.910, 3: 294.135, 4: 407.820, 5: 498.045, 6: 611.730, 7: 701.955, 8: 815.640, 9: 905.865, 10: 996.090, 11: 1109.775 };

  it('matches the folded fifths table with the break between G-sharp and E-flat', () => {
    const c4 = equal(60, 442);
    for (let pc = 0; pc < 12; pc += 1) {
      const r = tm.resolve({ temperament: 'pythagorean', rootMidi: 60, fixedMidi: 60 + pc, a4Tenths: 4420 });
      expect(1200 * Math.log2(r.targetHz / c4), `pc ${pc}`).toBeCloseTo(PYTH[pc], 3);
    }
    expect(tm.resolve({ temperament: 'pythagorean', rootMidi: 60, fixedMidi: 68, a4Tenths: 4420 }).spelling.letter).toBe('G♯');
    expect(tm.resolve({ temperament: 'pythagorean', rootMidi: 60, fixedMidi: 63, a4Tenths: 4420 }).spelling.letter).toBe('E♭');
    // Another octave: same ratio times 2.
    const c5 = tm.resolve({ temperament: 'pythagorean', rootMidi: 60, fixedMidi: 79, a4Tenths: 4420 });
    expect(1200 * Math.log2(c5.targetHz / c4)).toBeCloseTo(1200 + PYTH[7], 3);
  });

  it('moving the break (window start) changes which enharmonic spelling and ratio is used', () => {
    // Start -4: A-flat (-4 fifths, 792.180 cents) instead of G-sharp.
    const c4 = equal(60, 442);
    const r = tm.resolve({ temperament: 'pythagorean', rootMidi: 60, fixedMidi: 68, pythagoreanStart: -4, a4Tenths: 4420 });
    expect(r.spelling.letter).toBe('A♭');
    expect(1200 * Math.log2(r.targetHz / c4)).toBeCloseTo(792.180, 3);
    // Pythagorean comma between G-sharp and A-flat.
    expect(PYTH[8] - 792.180).toBeCloseTo(23.460, 2);
  });

  it('custom: per pitch class offsets (-100..+100, 0.1 steps), the anchor stays 0', () => {
    const offsets = [50, 10, -10.26, 0, 0, 0, 0, 0, 0, 0, 0, 250];
    const cfg = tm.normalizeConfig({ temperament: 'custom', rootMidi: 62, customOffsets: offsets });
    expect(cfg.customOffsets[0]).toBe(0);
    expect(cfg.customOffsets[2]).toBe(-10.3);
    expect(cfg.customOffsets[11]).toBe(100);
    const r = tm.resolve(Object.assign({}, cfg, { fixedMidi: 63, a4Tenths: 4420 }));
    expect(1200 * Math.log2(r.targetHz / equal(63, 442))).toBeCloseTo(10, 9);
  });

  it('spelling preference never changes the frequency', () => {
    for (const spelling of ['default', 'sharp', 'flat']) {
      expect(tm.resolve({ temperament: 'equal', a4Tenths: 4420, fixedMidi: 61, spelling }).targetHz).toBe(equal(61, 442));
    }
    expect(tm.spell(61, 'sharp').label).toBe('C♯4');
    expect(tm.spell(61, 'flat').label).toBe('D♭4');
    expect(tm.spellFifths(60, 60, 12, 'default').label).toBe('B♯3'); // octave follows the letter
  });
});

describe('display filter with the target model', () => {
  const push = (f, freq, n = 30, t0 = 0) => { let s; let t = t0; for (let i = 0; i < n; i += 1) { t += 50; s = f.push({ valid: true, frequency: freq }, t, 442); } return { s, t }; };

  it('judges against the Pythagorean target and resets "in tune" when the target changes', () => {
    const f = displayFilter.createDisplayFilter();
    f.setTarget({ temperament: 'pythagorean', rootMidi: 60 }, 0, 442);
    const target = tm.resolve({ temperament: 'pythagorean', rootMidi: 60, fixedMidi: 64, a4Hz: 442 }).targetHz;
    const { s, t } = push(f, target);
    expect(s.cents).toBeCloseTo(0, 6);
    expect(s.judgment).toBe('in-tune');
    const after = f.setTarget({ temperament: 'equal', rootMidi: 60 }, t, 442);
    expect(after.cents).toBeCloseTo(7.82, 2);
    expect(after.judgment).toBe('sharp');
  });

  it('tolerance and meter range come from the options (enter at tol, exit beyond tol + 1)', () => {
    const f = displayFilter.createDisplayFilter({ enterInTuneCents: 10, exitInTuneCents: 11, meterRangeCents: 25 });
    const { s } = push(f, equal(69, 442) * Math.pow(2, 9.5 / 1200));
    expect(s.judgment).toBe('in-tune');
    expect(s.needlePercent).toBeCloseTo(50 + 50 * 9.5 / 25, 6);
    const g = displayFilter.createDisplayFilter({ meterRangeCents: 10 });
    const { s: s2 } = push(g, equal(69, 442) * Math.pow(2, 40 / 1200));
    expect(s2.needleCents).toBe(10);
    expect(s2.cents).toBeCloseTo(40, 6); // the value itself is not clamped
  });

  it('a display-smoothing change never touches the raw input', () => {
    const fast = displayFilter.createDisplayFilter({ smoothingTimeMs: 40, onsetConfirmFrames: 1 });
    const first = fast.push({ valid: true, frequency: 440 }, 0, 442);
    expect(first.state).toBe('active'); // fast preset shows the first frame
    expect(first.frequency).toBeCloseTo(440, 9);
  });
});
