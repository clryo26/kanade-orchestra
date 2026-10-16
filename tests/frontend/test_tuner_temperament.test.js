import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const root = process.cwd();
const music = require(path.join(root, 'src/static/js/modules/tuner/music.js'));
const temperament = require(path.join(root, 'src/static/js/modules/tuner/temperament.js'));
const displayFilter = require(path.join(root, 'src/static/js/modules/tuner/display_filter.js'));

const cents = (a, b) => 1200 * Math.log2(a / b);

function settle(filter, frequency, startMs, a4, frames = 40) {
  let snapshot;
  let now = startMs;
  for (let i = 0; i < frames; i += 1) {
    now += 50;
    snapshot = filter.push({ valid: true, frequency }, now, a4);
  }
  return { snapshot, now };
}

describe('just-intonation thirds', () => {
  it('uses the pure ratios 6/5 and 5/4 and their offsets from equal temperament', () => {
    expect(temperament.pureOffsetCents('minor-third')).toBeCloseTo(15.6413, 4);
    expect(temperament.pureOffsetCents('major-third')).toBeCloseTo(-13.6863, 4);
    expect(temperament.pureOffsetCents('equal')).toBe(0);
  });

  it.each([
    [430, 60], [442, 60], [450, 60], [442, 48], [442, 72], [442, 69], [430, 24], [450, 104],
  ])('computes the target from the root for A4 = %i Hz, root midi %i', (a4, rootMidi) => {
    for (const [mode, ratio, semitones, offset] of [['minor-third', 6 / 5, 3, 15.6413], ['major-third', 5 / 4, 4, -13.6863]]) {
      const t = temperament.justTarget(mode, rootMidi, a4);
      const rootHz = a4 * 2 ** ((rootMidi - 69) / 12);
      expect(t.rootFrequency).toBeCloseTo(rootHz, 9);
      expect(t.targetFrequency).toBeCloseTo(rootHz * ratio, 9);
      expect(t.target.midi).toBe(rootMidi + semitones);
      expect(t.equalTargetFrequency).toBeCloseTo(music.noteFrequency(rootMidi + semitones, a4), 9);
      // Same offset for every root/octave/A4 because it follows from the ratio.
      expect(cents(t.targetFrequency, t.equalTargetFrequency)).toBeCloseTo(offset, 4);
    }
  });

  it('names the example "根音 C4 → 純正長3度 E4"', () => {
    const t = temperament.justTarget('major-third', 60, 442);
    expect([t.root.label, t.intervalLabel, t.target.label]).toEqual(['C4', '純正長3度', 'E4']);
    const view = require(path.join(root, 'src/static/js/modules/tuner/view.js'));
    expect(view.targetLineText(t)).toBe(`根音 C4 → 純正長3度 E4（目標 ${t.targetFrequency.toFixed(2)} Hz）`);
  });

  it('offers roots C1..A♭7 so the third stays within the detection range (C1-C8)', () => {
    const roots = temperament.rootOptions();
    expect(roots[0].label).toBe('C1');
    expect(roots.at(-1).label).toBe('A♭7');
    expect(temperament.justTarget('major-third', 104, 442).target.label).toBe('C8');
    expect(temperament.isValidRoot(105)).toBe(false);
    expect(temperament.isValidRoot(23)).toBe(false);
    expect(temperament.justTarget('major-third', 105, 442)).toBeNull();
    expect(temperament.DEFAULT_ROOT_MIDI).toBe(60);
    expect(temperament.DEFAULT_MODE).toBe('equal');
  });
});

describe('judgment against a just-intonation target', () => {
  it('reads 0 cent exactly on the pure target and reports the equal-tempered difference', () => {
    const filter = displayFilter.createDisplayFilter();
    filter.setJudgment({ mode: 'major-third', rootMidi: 60 }, 0, 442);
    const t = temperament.justTarget('major-third', 60, 442);
    const { snapshot } = settle(filter, t.targetFrequency, 0, 442);
    expect(snapshot.cents).toBeCloseTo(0, 6);
    expect(snapshot.judgment).toBe('in-tune');
    expect(snapshot.targetFrequency).toBeCloseTo(t.targetFrequency, 9);
    expect(snapshot.equalCents).toBeCloseTo(-13.6863, 3);
    expect(snapshot.equalCentsRounded).toBe(-14);
    expect(snapshot.targetNote.label).toBe('E4');
    expect(snapshot.note.label).toBe('E4'); // detected note is still shown
  });

  it('keeps the fixed target when another note is played', () => {
    const filter = displayFilter.createDisplayFilter();
    filter.setJudgment({ mode: 'minor-third', rootMidi: 60 }, 0, 442);
    const t = temperament.justTarget('minor-third', 60, 442);
    const { snapshot, now } = settle(filter, music.noteFrequency(64, 442), 0, 442); // E4 instead of E♭4
    expect(snapshot.targetNote.label).toBe('E♭4');
    expect(snapshot.targetFrequency).toBeCloseTo(t.targetFrequency, 9);
    expect(snapshot.note.label).toBe('E4');
    expect(snapshot.cents).toBeCloseTo(cents(music.noteFrequency(64, 442), t.targetFrequency), 6);
    expect(snapshot.judgment).toBe('sharp');
    expect(snapshot.needleCents).toBe(50); // internal value kept, needle clamped
    expect(snapshot.cents).toBeGreaterThan(50);
    const octaveUp = music.noteFrequency(75, 442); // E♭5, an octave above the target note
    const far = settle(filter, octaveUp, now, 442).snapshot;
    expect(far.targetFrequency).toBeCloseTo(t.targetFrequency, 9);
    expect(far.cents).toBeCloseTo(cents(octaveUp, t.targetFrequency), 6);
    expect(far.cents).toBeGreaterThan(1000);
  });

  it('applies the ±3 enter / ±4 exit hysteresis to the pure target', () => {
    const filter = displayFilter.createDisplayFilter();
    filter.setJudgment({ mode: 'major-third', rootMidi: 57 }, 0, 442);
    const target = temperament.justTarget('major-third', 57, 442).targetFrequency;
    let { snapshot, now } = settle(filter, target * 2 ** (2.9 / 1200), 0, 442);
    expect(snapshot.judgment).toBe('in-tune');
    ({ snapshot, now } = settle(filter, target * 2 ** (3.8 / 1200), now, 442));
    expect(snapshot.judgment).toBe('in-tune');
    ({ snapshot } = settle(filter, target * 2 ** (4.3 / 1200), now, 442));
    expect(snapshot.judgment).toBe('sharp');
  });

  it('recalculates immediately on mode, root and A4 changes without carrying the old in-tune state', () => {
    const filter = displayFilter.createDisplayFilter();
    const e4 = music.noteFrequency(64, 442);
    const { snapshot, now } = settle(filter, e4, 0, 442);
    expect(snapshot.judgment).toBe('in-tune'); // equal temperament, E4
    // Switch to the pure major third over C4: same measured Hz, new target at once.
    const major = filter.setJudgment({ mode: 'major-third', rootMidi: 60 }, now, 442);
    expect(major.frequency).toBeCloseTo(snapshot.frequency, 9);
    expect(major.cents).toBeCloseTo(13.6863, 3);
    expect(major.judgment).toBe('sharp'); // not carried over from "in-tune"
    // Root change: target follows the new root immediately.
    const rootD = filter.setJudgment({ mode: 'major-third', rootMidi: 62 }, now, 442);
    expect(rootD.targetNote.label).toBe('F♯4');
    expect(rootD.targetFrequency).toBeCloseTo(temperament.justTarget('major-third', 62, 442).targetFrequency, 9);
    // A4 change: the root (and target) move with the reference.
    const a440 = filter.recompute(now, 440);
    expect(a440.targetFrequency).toBeCloseTo(temperament.justTarget('major-third', 62, 440).targetFrequency, 9);
    // Back to equal temperament: nearest-note judgment again.
    const equal = filter.setJudgment({ mode: 'equal', rootMidi: 62 }, now, 442);
    expect(equal.mode).toBe('equal');
    expect(equal.targetNote.label).toBe('E4');
    expect(equal.just).toBeNull();
    expect(equal.cents).toBeCloseTo(0, 6);
  });

  it('an A4 change drops the old in-tune state and judges the new target with ±3 cent', () => {
    const filter = displayFilter.createDisplayFilter();
    filter.setJudgment({ mode: 'major-third', rootMidi: 60 }, 0, 442);
    const t442 = temperament.justTarget('major-third', 60, 442).targetFrequency;
    const { snapshot, now } = settle(filter, t442, 0, 442);
    expect(snapshot.judgment).toBe('in-tune');
    const moved = filter.recompute(now, 443);
    expect(moved.cents).toBeCloseTo(-3.91, 2);
    expect(moved.judgment).toBe('flat'); // old "in tune" (exit at ±4) must not survive
    // Within ±3 of the new target it is "in tune" right away.
    const close = displayFilter.createDisplayFilter();
    close.setJudgment({ mode: 'major-third', rootMidi: 60 }, 0, 442);
    const slightlySharp = t442 * 2 ** (1 / 1200);
    const s2 = settle(close, slightlySharp, 0, 442);
    const moved2 = close.recompute(s2.now, 443);
    expect(moved2.cents).toBeCloseTo(1 - 3.91, 1);
    expect(moved2.judgment).toBe('in-tune');
    // Same rule in equal temperament.
    const equal = displayFilter.createDisplayFilter();
    const s3 = settle(equal, 442, 0, 442);
    expect(s3.snapshot.judgment).toBe('in-tune');
    expect(equal.recompute(s3.now, 443).judgment).toBe('flat');
  });

  it('keeps the judgment setting across a gap reset', () => {
    const filter = displayFilter.createDisplayFilter();
    filter.setJudgment({ mode: 'minor-third', rootMidi: 60 }, 0, 442);
    filter.reset();
    expect(filter.getJudgment()).toEqual({ mode: 'minor-third', rootMidi: 60 });
    const t = temperament.justTarget('minor-third', 60, 442);
    const { snapshot } = settle(filter, t.targetFrequency, 0, 442);
    expect(snapshot.cents).toBeCloseTo(0, 6);
  });
});
