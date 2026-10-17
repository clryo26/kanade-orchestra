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
  // Migration source: the legacy key holds whole integers 430-450 only.
  it('defaults to 442 and accepts only whole integers 430-450 from the legacy key', () => {
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

  // Design T-011: 390.0-480.0 Hz in 0.1 Hz steps, stored as integer tenths.
  it('steps by 0.1 Hz, stops at 390.0 / 480.0 Hz and never rewrites the legacy key', () => {
    const storage = memoryStorage({ [settings.STORAGE_KEY]: '431' });
    const store = settings.createSettingsStore(storage);
    expect(store.load()).toBe(431); // migrated x10
    expect(store.getTenths()).toBe(4310);
    store.setTenths(3901);
    expect(store.canDecrease()).toBe(true);
    expect(store.step(-1)).toMatchObject({ value: 390, tenths: 3900, saved: true, changed: true });
    expect(store.canDecrease()).toBe(false);
    expect(store.step(-1)).toMatchObject({ value: 390, changed: false });
    expect(JSON.parse(storage.data[settings.SETTINGS_KEY]).a4Tenths).toBe(3900);
    expect(storage.data[settings.STORAGE_KEY]).toBe('431'); // legacy key untouched
    store.setTenths(4799);
    store.step(1);
    expect(store.get()).toBe(480);
    expect(store.canIncrease()).toBe(false);
    expect(store.step(1).value).toBe(480);
    expect(store.set(442.5)).toMatchObject({ value: 442.5, tenths: 4425, changed: true });
    expect(store.set(442.55)).toMatchObject({ value: 442.5, changed: false }); // 0.01 Hz is refused
    expect(store.setTenths(3899)).toMatchObject({ changed: false });
    expect(store.setTenths(4801)).toMatchObject({ changed: false });
  });

  it('parses typed A4 values (one decimal, full-width digits) and refuses the rest', () => {
    expect(settings.parseA4Input('442')).toEqual({ ok: true, tenths: 4420 });
    expect(settings.parseA4Input(' 441.5 ')).toEqual({ ok: true, tenths: 4415 });
    expect(settings.parseA4Input('４４３．２')).toEqual({ ok: true, tenths: 4432 });
    expect(settings.parseA4Input('390.0')).toEqual({ ok: true, tenths: 3900 });
    expect(settings.parseA4Input('480.0')).toEqual({ ok: true, tenths: 4800 });
    for (const [text, reason] of [['', 'empty'], ['389.9', 'range'], ['480.1', 'range'], ['442.25', 'format'], ['4.42e2', 'format'], ['abc', 'format']]) {
      expect(settings.parseA4Input(text), text).toMatchObject({ ok: false, reason });
    }
    expect(settings.PRESETS_TENTHS).toEqual([4400, 4410, 4420, 4430]);
  });

  it('keeps an unknown settings schema untouched and works with defaults', () => {
    const raw = JSON.stringify({ schemaVersion: 99, a4Tenths: 4500, future: true });
    const storage = memoryStorage({ [settings.SETTINGS_KEY]: raw });
    const store = settings.createSettingsStore(storage);
    expect(store.load()).toBe(442);
    expect(store.isReadOnly()).toBe(true);
    store.step(1);
    expect(store.get()).toBe(442.1);
    expect(storage.data[settings.SETTINGS_KEY]).toBe(raw);
  });

  it('saves display preferences only after "save on this device" and can reset them', () => {
    const storage = memoryStorage();
    const store = settings.createSettingsStore(storage);
    store.load();
    expect(store.setPrefs({ toleranceCents: 5 })).toMatchObject({ saved: false, persisted: false });
    expect(store.getPrefs().toleranceCents).toBe(5); // in memory
    expect(storage.data[settings.SETTINGS_KEY]).toBeUndefined();
    store.setPersist(true);
    store.setPrefs({ toleranceCents: 7.5, meterRangeCents: 25, responsePreset: 'custom', smoothingMs: 333 });
    const saved = JSON.parse(storage.data[settings.SETTINGS_KEY]);
    expect(saved.prefs).toMatchObject({ toleranceCents: 7.5, meterRangeCents: 25, smoothingMs: 330 });
    const again = settings.createSettingsStore(storage);
    again.load();
    expect(again.getPrefs()).toMatchObject({ toleranceCents: 7.5, responsePreset: 'custom' });
    expect(again.resetPrefs()).toMatchObject({ toleranceCents: 3, meterRangeCents: 50, responsePreset: 'standard' });
    store.setPersist(false);
    expect(JSON.parse(storage.data[settings.SETTINGS_KEY]).prefs).toBeUndefined();
  });

  it('maps response presets and tolerance to display-only filter options', () => {
    expect(settings.displayOptions({ responsePreset: 'fast' })).toMatchObject({ smoothingTimeMs: 40, onsetConfirmFrames: 1, holdMs: 500 });
    expect(settings.displayOptions({ responsePreset: 'standard' })).toMatchObject({ smoothingTimeMs: 120, onsetConfirmFrames: 2, holdMs: 1000, enterInTuneCents: 3, exitInTuneCents: 4 });
    expect(settings.displayOptions({ responsePreset: 'stable', toleranceCents: 10 })).toMatchObject({ smoothingTimeMs: 240, onsetConfirmFrames: 3, holdMs: 1500, enterInTuneCents: 10, exitInTuneCents: 11 });
    expect(settings.normalizePrefs({ toleranceCents: 0.2 }).toleranceCents).toBe(0.5);
    expect(settings.normalizePrefs({ toleranceCents: 99 }).toleranceCents).toBe(25);
    expect(settings.normalizePrefs({ inputThreshold: { mode: 'manual', dbfs: -200 } }).inputThreshold.dbfs).toBe(-90);
  });

  it('keeps working in memory when storage throws (read or write)', () => {
    const throwing = {
      getItem: () => { throw new Error('SecurityError'); },
      setItem: () => { throw new Error('QuotaExceededError'); },
    };
    const store = settings.createSettingsStore(throwing);
    expect(store.load()).toBe(442);
    const result = store.step(10); // +1.0 Hz
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
    expect(second.load()).toBe(442.2);
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
    for (const file of files) {
      expect(fs.readFileSync(path.join(root, file), 'utf8')).not.toContain('portalTunerSettings');
    }
  });
});

describe('named presets in the device settings (M-010 / D-008)', () => {
  const settingsLib = require(path.join(process.cwd(), 'src/static/js/modules/tuner/settings.js'));
  it('validates entries, limits the count and size, and survives "back to defaults"', () => {
    const ok = { id: 'p-1', name: '  B♭管\u0007 ', savedAt: 1, data: { temperament: 'pythagorean', rootMidi: 58 } };
    const list = [ok, { id: 'p-1', name: 'dup', data: {} }, { id: 'bad id', name: 'x', data: {} }, { id: 'p-2', name: 'big', data: { text: 'x'.repeat(9000) } }, { id: 'p-3', name: 3, data: {} }];
    const presets = settingsLib.normalizePresets({ temperament: list, sound: Array.from({ length: 30 }, (_, i) => ({ id: `s${i}`, name: `s${i}`, data: { voices: [] } })) });
    expect(presets.temperament).toEqual([{ id: 'p-1', name: 'B♭管', savedAt: 1, data: { temperament: 'pythagorean', rootMidi: 58 } }]);
    expect(presets.sound).toHaveLength(settingsLib.MAX_PRESETS);
    const data = {};
    const storage = { getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); } };
    const store = settingsLib.createSettingsStore(storage);
    store.load();
    store.setPrefs({ presets: { temperament: [ok], sound: [] } });
    expect(data.portalTunerSettings && JSON.parse(data.portalTunerSettings).prefs).toBeUndefined(); // not persisted while "save" is off
    store.setPersist(true);
    store.setPrefs({ theme: 'dark' });
    expect(JSON.parse(data.portalTunerSettings).prefs.presets.temperament[0].id).toBe('p-1');
    const reset = store.resetPrefs();
    expect(reset.theme).toBe('auto');
    expect(reset.presets.temperament).toHaveLength(1);
  });
});
