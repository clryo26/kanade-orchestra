import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const root = process.cwd();
const displayFilter = require(path.join(root, 'src/static/js/modules/tuner/display_filter.js'));

const A4 = 442;

function hz(midi, cents = 0, a4 = A4) {
  return a4 * 2 ** ((midi - 69) / 12) * 2 ** (cents / 1200);
}

function valid(frequency) {
  return { valid: true, frequency };
}

// Feeds the same pitch long enough for the smoothing to settle.
function settle(filter, frequency, startMs, a4 = A4, frames = 40) {
  let snapshot;
  let now = startMs;
  for (let i = 0; i < frames; i += 1) {
    now += 50;
    snapshot = filter.push(valid(frequency), now, a4);
  }
  return { snapshot, now };
}

describe('tuner display filter', () => {
  it('enters "in tune" within ±3 cents and leaves only beyond ±4 cents', () => {
    const filter = displayFilter.createDisplayFilter();
    let { snapshot, now } = settle(filter, hz(69, 5), 0);
    expect(snapshot.judgment).toBe('sharp');
    expect(snapshot.judgmentLabel).toBe('高い');
    ({ snapshot, now } = settle(filter, hz(69, 2.9), now));
    expect(snapshot.judgment).toBe('in-tune');
    expect(snapshot.judgmentLabel).toBe('合っています');
    ({ snapshot, now } = settle(filter, hz(69, 3.8), now));
    expect(snapshot.judgment).toBe('in-tune'); // inside the exit band
    ({ snapshot, now } = settle(filter, hz(69, 4.3), now));
    expect(snapshot.judgment).toBe('sharp');
    ({ snapshot, now } = settle(filter, hz(69, 3.5), now));
    expect(snapshot.judgment).toBe('sharp'); // must come back within ±3 to re-enter
    ({ snapshot } = settle(filter, hz(69, -6), now));
    expect(snapshot.judgment).toBe('flat');
    expect(snapshot.judgmentLabel).toBe('低い');
    expect(snapshot.centsRounded).toBe(-6);
  });

  it('switches note only 3 cents past the semitone midpoint and clamps only the needle', () => {
    const filter = displayFilter.createDisplayFilter({ jumpResetCents: 1000 });
    let { snapshot, now } = settle(filter, hz(69, 45), 0);
    expect(snapshot.note.label).toBe('A4');
    ({ snapshot, now } = settle(filter, hz(69, 52), now));
    expect(snapshot.note.label).toBe('A4'); // 52 < 50 + 3
    expect(snapshot.cents).toBeCloseTo(52, 1);
    expect(snapshot.needleCents).toBe(50);
    ({ snapshot } = settle(filter, hz(69, 54), now));
    expect(snapshot.note.label).toBe('B♭4');
    expect(snapshot.cents).toBeCloseTo(-46, 1);
  });

  it('holds the last reading about 1 second, then clears', () => {
    const filter = displayFilter.createDisplayFilter();
    const { now } = settle(filter, hz(69), 0);
    expect(filter.push({ valid: false }, now + 500, A4).state).toBe('held');
    expect(filter.push({ valid: false }, now + 1000, A4).state).toBe('held');
    expect(filter.push({ valid: false }, now + 1001, A4).state).toBe('none');
  });

  it('resets smoothing on a raw jump of 30 cents or more', () => {
    const filter = displayFilter.createDisplayFilter({ noteSwitchMarginCents: 3 });
    const { now } = settle(filter, hz(60, -10), 0);
    // The first frame after a jump keeps the old reading (held) until confirmed...
    expect(filter.push(valid(hz(60, 22)), now + 50, A4)).toMatchObject({ state: 'held' });
    const jumped = filter.push(valid(hz(60, 22)), now + 100, A4);
    expect(jumped.cents).toBeCloseTo(22, 6); // ...then shows it without blending with the old -10
    const small = displayFilter.createDisplayFilter();
    const base = settle(small, hz(60, -10), 0);
    const drift = small.push(valid(hz(60, 10)), base.now + 50, A4);
    expect(drift.cents).toBeGreaterThan(-10);
    expect(drift.cents).toBeLessThan(10); // 20-cent change is smoothed
  });

  it('resets smoothing when the note changes', () => {
    const filter = displayFilter.createDisplayFilter();
    const { now } = settle(filter, hz(69), 0);
    filter.push(valid(hz(71, 4)), now + 50, A4);
    const next = filter.push(valid(hz(71, 4)), now + 100, A4);
    expect(next.note.label).toBe('B4');
    expect(next.cents).toBeCloseTo(4, 6);
  });

  it('recomputes immediately for a new reference without treating it as a jump', () => {
    const filter = displayFilter.createDisplayFilter();
    const { snapshot, now } = settle(filter, hz(69, 0, 442), 0, 442);
    expect(snapshot.centsRounded).toBe(0);
    const frequencyBefore = snapshot.frequency;
    const after = filter.recompute(now, 443);
    expect(after.frequency).toBeCloseTo(frequencyBefore, 9);
    expect(after.targetFrequency).toBeCloseTo(443, 9);
    expect(after.cents).toBeCloseTo(1200 * Math.log2(442 / 443), 6);
    const jumpReference = filter.recompute(now, 450);
    expect(jumpReference.note.label).toBe('A4');
    expect(jumpReference.centsRounded).toBe(-31);
    // The next measurement continues smoothing from the same frequency.
    const continued = filter.push(valid(hz(69, 0, 442)), now + 50, 450);
    expect(continued.frequency).toBeCloseTo(frequencyBefore, 6);
  });

  it('starts fresh after reset (audio gap)', () => {
    const filter = displayFilter.createDisplayFilter();
    const { now } = settle(filter, hz(69, 20), 0);
    filter.reset();
    expect(filter.push({ valid: false }, now + 10, A4).state).toBe('none');
    filter.push(valid(hz(69, -4)), now + 20, A4);
    const fresh = filter.push(valid(hz(69, -4)), now + 70, A4);
    expect(fresh.cents).toBeCloseTo(-4, 6);
  });

  it('hides an off-pitch first frame of a new note (attack transient)', () => {
    const filter = displayFilter.createDisplayFilter();
    // Attack: one frame 34 cents flat, then the steady pitch.
    expect(filter.push(valid(hz(69, -34)), 0, A4)).toEqual({ state: 'none' });
    expect(filter.push(valid(hz(69, 1)), 50, A4)).toEqual({ state: 'none' });
    const shown = filter.push(valid(hz(69, 1)), 100, A4);
    expect(shown.state).toBe('active');
    expect(shown.cents).toBeCloseTo(1, 6);
  });

  it('does not wait forever when consecutive frames keep disagreeing (wide vibrato)', () => {
    const filter = displayFilter.createDisplayFilter();
    expect(filter.push(valid(hz(69, -40)), 0, A4).state).toBe('none');
    expect(filter.push(valid(hz(69, 0)), 50, A4).state).toBe('none');
    const shown = filter.push(valid(hz(69, 40)), 100, A4);
    expect(shown.state).toBe('active');
    expect(shown.cents).toBeCloseTo(40, 6);
  });

  it('never shows "-0" cents', () => {
    expect(Object.is(displayFilter.roundCents(-0.2), 0)).toBe(true);
    expect(displayFilter.roundCents(-0.6)).toBe(-1);
  });
});

describe('tuner screen-reader announcements', () => {
  it('announces a note only when it stayed stable and not too often', () => {
    const announcer = displayFilter.createAnnouncer({ stableMs: 800, minIntervalMs: 2000 });
    expect(announcer.update('A4 ラ', 0)).toBeNull();
    expect(announcer.update('A4 ラ', 500)).toBeNull();
    expect(announcer.update('A4 ラ', 900)).toBe('A4 ラ');
    expect(announcer.update('A4 ラ', 1500)).toBeNull(); // already announced
    expect(announcer.update('B♭4 シ♭', 1600)).toBeNull();
    expect(announcer.update('B♭4 シ♭', 2500)).toBeNull(); // within 2 s of the last announcement
    expect(announcer.update('B♭4 シ♭', 3000)).toBe('B♭4 シ♭');
    expect(announcer.update(null, 3100)).toBeNull();
    expect(announcer.update('B♭4 シ♭', 5200)).toBeNull();
    expect(announcer.update('B♭4 シ♭', 6100)).toBe('B♭4 シ♭');
  });
});
