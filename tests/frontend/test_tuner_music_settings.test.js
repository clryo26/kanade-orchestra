import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const root = process.cwd();
const music = require(path.join(root, 'src/static/js/modules/tuner/music.js'));
const settings = require(path.join(root, 'src/static/js/modules/tuner/settings.js'));

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => (Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null),
    setItem: (key, value) => { data[key] = String(value); },
    removeItem: (key) => { delete data[key]; },
  };
}

describe('tuner note names and cents', () => {
  it('uses the fixed spelling table without German names', () => {
    expect(music.NOTE_NAMES.map((n) => `${n.letter}（${n.solfege}）`)).toEqual([
      'C（ド）', 'C♯（ド♯）', 'D（レ）', 'E♭（ミ♭）', 'E（ミ）', 'F（ファ）',
      'F♯（ファ♯）', 'G（ソ）', 'A♭（ラ♭）', 'A（ラ）', 'B♭（シ♭）', 'B（シ）',
    ]);
    const text = fs.readFileSync(path.join(root, 'src/static/js/modules/tuner/music.js'), 'utf8');
    expect(text).not.toMatch(/'H'|'Es'|'Fis'/);
  });

  it('names notes with octave numbers (A4, B♭3, C1, C8)', () => {
    expect(music.describeNote(69).label).toBe('A4');
    expect(music.describeNote(58)).toMatchObject({ label: 'B♭3', solfege: 'シ♭' });
    expect(music.describeNote(24).label).toBe('C1');
    expect(music.describeNote(108).label).toBe('C8');
    expect(music.describeNote(61).label).toBe('C♯4');
    expect(music.describeNote(68).label).toBe('A♭4');
  });

  it.each([430, 442, 450])('computes target frequencies and cents for A4 = %i Hz', (a4) => {
    expect(music.noteFrequency(69, a4)).toBeCloseTo(a4, 10);
    expect(music.noteFrequency(81, a4)).toBeCloseTo(a4 * 2, 10);
    expect(music.noteFrequency(60, a4)).toBeCloseTo(a4 * 2 ** (-9 / 12), 10);
    const sharp = a4 * 2 ** (10 / 1200);
    const result = music.analyzeFrequency(sharp, a4);
    expect(result.note.label).toBe('A4');
    expect(result.cents).toBeCloseTo(10, 9);
    expect(music.analyzeFrequency(a4 * 2 ** (-3.1 / 1200), a4).cents).toBeCloseTo(-3.1, 9);
  });

  it('switches to the neighbouring note past the semitone midpoint', () => {
    expect(music.analyzeFrequency(442 * 2 ** (49 / 1200), 442).note.label).toBe('A4');
    expect(music.analyzeFrequency(442 * 2 ** (51 / 1200), 442).note.label).toBe('B♭4');
  });
});

describe('tuner reference A4 setting', () => {
  it('defaults to 442 and accepts only whole integers 430-450 from storage', () => {
    const cases = {
      '430': 430, '442': 442, '450': 450,
      '429': 442, '451': 442, '442.0': 442, '442.5': 442, ' 442': 442, '442 ': 442,
      '0442': 442, '4.42e2': 442, '': 442, 'abc': 442, '+442': 442, '-442': 442,
    };
    for (const [raw, expected] of Object.entries(cases)) {
      const store = settings.createSettingsStore(memoryStorage({ [settings.STORAGE_KEY]: raw }));
      expect(store.load(), raw).toBe(expected);
    }
    expect(settings.createSettingsStore(memoryStorage()).load()).toBe(442);
    expect(settings.createSettingsStore(null).load()).toBe(442);
  });

  it('steps by 1 Hz and stops at the range ends', () => {
    const storage = memoryStorage({ [settings.STORAGE_KEY]: '431' });
    const store = settings.createSettingsStore(storage);
    store.load();
    expect(store.canDecrease()).toBe(true);
    expect(store.step(-1)).toMatchObject({ value: 430, saved: true, changed: true });
    expect(store.canDecrease()).toBe(false);
    expect(store.step(-1)).toMatchObject({ value: 430, changed: false });
    expect(storage.data[settings.STORAGE_KEY]).toBe('430');
    store.set(449);
    store.step(1);
    expect(store.get()).toBe(450);
    expect(store.canIncrease()).toBe(false);
    expect(store.step(1).value).toBe(450);
    expect(store.set(442.5)).toMatchObject({ value: 450, saved: false, changed: false });
  });

  it('keeps working in memory when storage throws (read or write)', () => {
    const throwing = {
      getItem: () => { throw new Error('SecurityError'); },
      setItem: () => { throw new Error('QuotaExceededError'); },
    };
    const store = settings.createSettingsStore(throwing);
    expect(store.load()).toBe(442);
    const result = store.step(1);
    expect(result).toMatchObject({ value: 443, saved: false, changed: true });
    expect(store.get()).toBe(443);
    expect(store.lastSaveFailed()).toBe(true);
  });

  it('restores the saved value in a new session', () => {
    const storage = memoryStorage();
    const first = settings.createSettingsStore(storage);
    first.load();
    first.step(1);
    first.step(1);
    const second = settings.createSettingsStore(storage);
    expect(second.load()).toBe(444);
  });

  it('does not touch storage while loading the module', () => {
    const source = fs.readFileSync(path.join(root, 'src/static/js/modules/tuner/settings.js'), 'utf8');
    const code = source.replace(/\/\/.*$/gm, '');
    // Storage is injected by the caller; the module itself never names it.
    expect(code).not.toContain('localStorage');
  });

  it('survives logout: logout and auth clearing never remove the tuner key', () => {
    const files = [
      'src/static/js/auth_feature.js',
      'src/static/js/modules/navigation/events.js',
      'src/static/js/modules/common_helpers/api_runtime.js',
    ];
    for (const file of files) {
      const source = fs.readFileSync(path.join(root, file), 'utf8');
      expect(source).not.toContain('portalTunerReferenceA4Hz');
      expect(source).not.toMatch(/localStorage\.clear\(/);
    }
    // Simulate the logout's storage effects on a storage holding the setting.
    const storage = memoryStorage({ [settings.STORAGE_KEY]: '445', portalAuth: 'true', userRole: 'system-admin' });
    storage.removeItem('portalAuth');
    storage.removeItem('userRole');
    expect(settings.createSettingsStore(storage).load()).toBe(445);
  });
});
