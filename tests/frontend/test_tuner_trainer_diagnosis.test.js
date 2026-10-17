import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const dir = path.join(process.cwd(), 'src/static/js/modules/tuner');
const T = require(path.join(dir, 'trainer.js'));
const I = require(path.join(dir, 'intonation_profile.js'));

const midis = (ex) => ex.targetEvents.map((e) => e.midi);

describe('exercise compiler (all 12 kinds)', () => {
  it('scales: major and the three minor scales with the documented steps', () => {
    const major = T.compileExercise({ kind: 'major', key: 2, octave: 4 }).exercise;
    expect(midis(major)).toEqual([62, 64, 66, 67, 69, 71, 73, 74]);
    const harmonic = T.compileExercise({ kind: 'minor', key: 9, octave: 4, scaleType: 'harmonic' }).exercise;
    expect(midis(harmonic)).toEqual([69, 71, 72, 74, 76, 77, 80, 81]);
    const melodic = T.compileExercise({ kind: 'minor', key: 9, octave: 4, scaleType: 'melodic', direction: 'updown' }).exercise;
    // Up melodic, down natural; the top note once.
    expect(midis(melodic)).toEqual([69, 71, 72, 74, 76, 78, 80, 81, 79, 77, 76, 74, 72, 71, 69]);
    for (let key = 0; key < 12; key += 1) expect(T.compileExercise({ kind: 'major', key, octave: 4 }).ok).toBe(true);
  });

  it('chromatic up/down/updown, leaps, repeats, long tone, dynamics, ear, metronome, warmup, custom', () => {
    expect(midis(T.compileExercise({ kind: 'chromatic', startMidi: 60, endMidi: 63, direction: 'updown' }).exercise)).toEqual([60, 61, 62, 63, 62, 61, 60]);
    expect(midis(T.compileExercise({ kind: 'chromatic', startMidi: 60, endMidi: 62, direction: 'updown', repeatTurn: true }).exercise)).toEqual([60, 61, 62, 62, 61, 60]);
    expect(midis(T.compileExercise({ kind: 'chromatic', startMidi: 62, endMidi: 60, direction: 'down' }).exercise)).toEqual([62, 61, 60]);
    expect(midis(T.compileExercise({ kind: 'leap', startMidi: 60, intervalSemitones: 24, repeats: 1 }).exercise)).toEqual([60, 84]);
    expect(midis(T.compileExercise({ kind: 'repeat', startMidi: 65, repeats: 4 }).exercise)).toEqual([65, 65, 65, 65]);
    const dyn = T.compileExercise({ kind: 'dynamics', startMidi: 69, dynamic: 'decrescendo' }).exercise;
    expect(dyn.targetEvents[0].dynamic).toBe('decrescendo');
    const ear = T.compileExercise({ kind: 'ear', startMidi: 69 }).exercise;
    expect(ear.targetEvents[0].visible).toBe(false);
    const met = T.compileExercise({ kind: 'metronome', startMidi: 69, tempo: 120, bars: 2, beatsPerBar: 4 }).exercise;
    expect(met.totalSeconds).toBeCloseTo(4, 9);
    expect(T.compileExercise({ kind: 'warmup', startMidi: 60 }).exercise.options.stages).toHaveLength(2);
    expect(T.compileExercise({ kind: 'interval' }).exercise.targetEvents).toEqual([]);
    const custom = T.compileExercise({ kind: 'custom', text: 'C4:1 r:1 E♭4:2 F#4', tempo: 120 }).exercise;
    expect(midis(custom)).toEqual([60, 63, 66]);
    expect(custom.targetEvents.map((e) => e.startSec)).toEqual([0, 1, 2]);
    expect(custom.targetEvents[1].durationSec).toBe(1);
  });

  it('refuses invalid custom input, too many notes and notes outside the instrument range', () => {
    expect(T.compileExercise({ kind: 'custom', text: 'H4:1' })).toMatchObject({ ok: false, reason: 'format' });
    expect(T.compileExercise({ kind: 'custom', text: 'r:1' })).toMatchObject({ ok: false, reason: 'empty' });
    expect(T.compileExercise({ kind: 'custom', text: Array(257).fill('C4').join(' ') })).toMatchObject({ ok: false, reason: 'too-long' });
    expect(T.compileExercise({ kind: 'chromatic', startMidi: 50, endMidi: 70, range: { lowMidi: 55, highMidi: 90 } })).toMatchObject({ ok: false, reason: 'range' });
  });

  it('targets follow the temperament (Pythagorean E is +7.82 cent)', () => {
    const eq = T.compileExercise({ kind: 'longtone', startMidi: 64, a4Tenths: 4420 }).exercise.targetEvents[0].targetHz;
    const py = T.compileExercise({ kind: 'longtone', startMidi: 64, a4Tenths: 4420, targetConfig: { temperament: 'pythagorean', rootMidi: 60 } }).exercise.targetEvents[0].targetHz;
    expect(1200 * Math.log2(py / eq)).toBeCloseTo(7.82, 2);
  });
});

describe('alignment of performed notes with the expected sequence', () => {
  const ex = T.compileExercise({ kind: 'chromatic', startMidi: 60, endMidi: 63, noteSeconds: 1, restSeconds: 0, tempo: 60 }).exercise;
  const hz = (midi, cents = 0) => 442 * 2 ** ((midi - 69) / 12) * 2 ** (cents / 1200);

  it('matches, keeps the real deviation, and reports missed / wrong / extra notes', () => {
    const observed = [
      { id: 0, startSec: 0.05, observedHz: hz(60, 8) },
      { id: 1, startSec: 1.1, observedHz: hz(61, -3) },
      { id: 9, startSec: 1.5, observedHz: hz(80) }, // extra note
      // 62 is missing
      { id: 2, startSec: 3.02, observedHz: hz(64) }, // wrong note at 63's time
    ];
    const al = T.align(observed, ex.targetEvents, { tempo: 60 });
    expect(al.results.map((r) => r.status)).toEqual(['matched', 'matched', 'missed', 'wrong-note']);
    expect(al.results[0].cents).toBeCloseTo(8, 6); // not rounded to "correct"
    expect(al.extras.map((e) => e.observedId)).toEqual([9]);
    const res = T.computeResult({ exercise: ex, alignment: al, statsByObserved: { 0: { medianCents: 8, validSeconds: 0.9, inToleranceSeconds: 0, excludedByReason: {} }, 1: { medianCents: -3, validSeconds: 0.9, inToleranceSeconds: 0.9, excludedByReason: {} } }, completed: false });
    expect(res.counts).toEqual({ targets: 4, matched: 2, wrongNotes: 1, missed: 1, extras: 1 });
    expect(res.partial).toBe(true);
    expect(res.metrics.accuracy.medianAbsCents).toBeCloseTo(5.5, 9);
    expect(res.metrics.coverage.value).toBeCloseTo(1.8 / 4, 9); // missed time counts as requested time
    expect(res.metrics.maintenance.validMaintenance).toBeCloseTo(0.5, 9);
    expect(res.score).toEqual({ value: null, reason: 'disabled' });
    expect(T.computeScore(res.metrics, T.SCORE_MODELS.longtone)).toMatchObject({ value: null, reason: 'normalization-unvalidated' });
  });

  it('starts outside max(100 ms, 25 % of a beat) are not matched', () => {
    const late = T.align([{ id: 0, startSec: 0.3, observedHz: hz(60) }], [ex.targetEvents[0]], { tempo: 60 });
    expect(late.results[0].status).toBe('missed');
    const fine = T.align([{ id: 0, startSec: 0.24, observedHz: hz(60) }], [ex.targetEvents[0]], { tempo: 60 });
    expect(fine.results[0].status).toBe('matched');
    expect(T.align([{ id: 0, startSec: 0.09, observedHz: hz(60) }], [ex.targetEvents[0]], { tempo: 240 }).results[0].status).toBe('matched');
  });

  it('reproducibility uses attempts (events), not frames', () => {
    const rep = T.compileExercise({ kind: 'repeat', startMidi: 69, repeats: 3, tempo: 60 }).exercise;
    const al = { results: rep.targetEvents.map((t, i) => ({ stepId: i, status: 'matched', observedIndex: i, cents: 0 })), extras: [] };
    const stats = { 0: { medianCents: 2, validSeconds: 0.7 }, 1: { medianCents: 4, validSeconds: 0.7 }, 2: { medianCents: 6, validSeconds: 0.7 } };
    const res = T.computeResult({ exercise: rep, alignment: al, statsByObserved: stats, completed: true });
    expect(res.metrics.reproducibility).toEqual([{ midi: 69, attempts: 3, sdCents: 2 }]);
  });
});

describe('practice state machine', () => {
  it('countdown -> performing -> result; pause/interrupt resume only by the user', () => {
    let now = 0;
    let timers = [];
    const clock = { now: () => now, setTimeout: (fn, ms) => { timers.push({ fn, at: now + ms / 1000 }); return timers.length; }, clearTimeout: () => { timers = []; } };
    const run = () => { const due = timers.filter((t) => t.at <= now); timers = timers.filter((t) => t.at > now); due.forEach((t) => t.fn()); };
    const s = T.createTrainerSession(clock);
    const states = [];
    s.onChange((i) => states.push(i.state));
    const ex = T.compileExercise({ kind: 'longtone', startMidi: 69, noteSeconds: 2, prepSeconds: 3 }).exercise;
    s.configure(ex);
    s.begin();
    now = 3; run();
    expect(s.getState()).toBe('performing');
    now = 4;
    s.pause('interrupted');
    expect(s.getState()).toBe('interrupted');
    now = 10; run(); // time passes: no automatic resume, no automatic end
    expect(s.getState()).toBe('interrupted');
    s.resume();
    now = 11.5; run();
    expect(s.getState()).toBe('result');
    expect(states).toEqual(['configuring', 'countdown', 'performing', 'interrupted', 'performing', 'result']);
    expect(s.segments().length).toBe(2); // the paused time is not part of the performance
  });

  it('a stale countdown timer after cancel never starts the performance', () => {
    let fns = [];
    const s = T.createTrainerSession({ now: () => 0, setTimeout: (fn) => { fns.push(fn); return 1; }, clearTimeout: () => {} });
    s.configure(T.compileExercise({ kind: 'longtone', startMidi: 69 }).exercise);
    s.begin();
    const stale = fns.slice();
    s.cancel();
    stale.forEach((fn) => fn());
    expect(s.getState()).toBe('configuring');
  });

  it('interval questions stay in range and are checked exactly', () => {
    let seed = 7;
    const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < 50; i += 1) {
      const q = T.makeIntervalQuestion(rand, { minSemitones: 2, maxSemitones: 7, lowMidi: 60, highMidi: 72 });
      expect(q.semitones).toBeGreaterThanOrEqual(2);
      expect(q.semitones).toBeLessThanOrEqual(7);
      expect(q.highMidi - q.lowMidi).toBe(q.semitones);
      expect(q.highMidi).toBeLessThanOrEqual(72);
      expect(T.checkIntervalAnswer(q, q.semitones).correct).toBe(true);
      expect(T.checkIntervalAnswer(q, q.semitones + 1).correct).toBe(false);
    }
  });
});

describe('personal diagnosis statistics', () => {
  const cond = I.conditionsKey({ a4Tenths: 4420, temperament: 'equal', engineVersion: 'yin-2', statsVersion: 1 });
  const ev = (session, median, extra = {}) => Object.assign({ sessionId: session, midi: 69, conditionsKey: cond, startedAt: 1e12 + Number(String(session).replace(/\D/g, '') || 0) * 86400000, durationSeconds: 1, observationCount: 20, coverage: 0.95, meanCents: median, medianCents: median, sdCents: 1, engineVersion: 'yin-2', statsVersion: 1 }, extra);

  it('counts events and sessions (a long note is one event) and holds without enough data', () => {
    const few = I.summarize([ev('s1', 5), ev('s1', 6), ev('s2', 5)]);
    expect(few).toMatchObject({ status: 'insufficient', nEvents: 3, nSessions: 2, tendency: 'undetermined' });
    const long = I.summarize([ev('s1', 5, { durationSeconds: 600 }), ev('s2', 5), ev('s3', 5)]);
    expect(long.nEvents).toBe(3); // 10 minutes still count once
  });

  it('weights sessions equally: one session with many events cannot dominate the mean', () => {
    const many = Array.from({ length: 30 }, () => ev('s1', 20));
    const s = I.summarize(many.concat([ev('s2', 0), ev('s3', 0), ev('s4', 0)]));
    expect(s.meanCents).toBeCloseTo(5, 9); // (20 + 0 + 0 + 0) / 4 sessions
    expect(s.eventMeanCents).toBeCloseTo(600 / 33, 9);
  });

  it('decides a tendency only when the session-cluster interval excludes 0', () => {
    const high = I.summarize(['s1', 's2', 's3', 's4'].flatMap((s, i) => [ev(s, 6 + i * 0.2), ev(s, 6.4)]));
    expect(high.status).toBe('ok');
    expect(high.tendency).toBe('high');
    const mixed = I.summarize(['s1', 's2', 's3', 's4'].flatMap((s, i) => [ev(s, i % 2 ? 3 : -3), ev(s, i % 2 ? 2 : -2)]));
    expect(['none', 'undetermined']).toContain(mixed.tendency);
    const wide = I.summarize(['s1', 's2', 's3'].flatMap((s, i) => [ev(s, [40, -30, 5][i]), ev(s, [40, -30, 5][i])]));
    expect(wide.status).toBe('reference');
  });

  it('excludes playback overlap, short or low-coverage events and never treats missing as 0', () => {
    const s = I.summarize([ev('s1', 5, { simultaneousPlayback: true }), ev('s1', 5, { durationSeconds: 0.1 }), ev('s1', 5, { coverage: 0.5 }), ev('s1', NaN), ev('s1', 5, { observationCount: 2 })]);
    expect(s.nEvents).toBe(0);
    expect(s.excludedByReason).toEqual({ playback: 1, short: 1, 'low-coverage': 1, 'no-value': 1, 'few-observations': 1 });
    expect(s.meanCents).toBeNull();
  });

  it('separates conditions and refuses comparisons across engine/stats versions', () => {
    const other = I.conditionsKey({ a4Tenths: 4400, temperament: 'equal', engineVersion: 'yin-2', statsVersion: 1 });
    expect(other).not.toBe(cond);
    expect(I.conditionDifferences({ a4Tenths: 4420 }, { a4Tenths: 4400 })).toEqual(['a4Tenths']);
    const map = I.noteMap([ev('s1', 5), ev('s2', 5, { conditionsKey: other })], cond);
    expect(map['69'].nEvents).toBe(1);
    const imp = I.improvement([ev('s9', 1)], [ev('s1', 5, { engineVersion: 'yin-1' })]);
    expect(imp.status).toBe('not-comparable');
  });

  it('improvement compares recent and earlier sessions with an interval; categories and ranking', () => {
    const past = ['s1', 's2', 's3'].flatMap((s) => [ev(s, 10), ev(s, 9), ev(s, 11)]);
    const recent = ['s7', 's8', 's9'].flatMap((s) => [ev(s, 2), ev(s, 1), ev(s, 3)]);
    expect(I.improvement(recent, past)).toMatchObject({ status: 'closer' });
    expect(I.improvement(past, past.slice(0, 2)).status).toBe('insufficient');
    const notes = { 64: Object.assign(I.summarize(past.map((e) => Object.assign({}, e, { midi: 64 }))), {}), 69: I.summarize(recent) };
    const rank = I.weakRanking(notes);
    expect(rank.byDeviation[0].key).toBe('64');
    const sugg = I.suggestions(notes, {}, (m) => 'MIDI' + m);
    expect(sugg.some((x) => x.kind === 'longtone' && x.midi === 64 && x.reason.nSessions === 3)).toBe(true);
    expect(sugg.every((x) => !/故障|不良|奏法が/.test(x.text))).toBe(true);
    expect(I.registerOf(50)).toBe('low');
    expect(I.periodKey(Date.UTC(2026, 9, 17, 16), 'day')).toBe('2026-10-18'); // Japan time
    expect(I.periodKey(Date.UTC(2026, 9, 17, 0), 'month')).toBe('2026-10');
  });
});

describe('playing environment (E-003, record only)', () => {
  it('keeps values in range, drops the rest and stays outside the condition key', () => {
    expect(I.normalizeEnvironment({ temperatureC: '22.46', humidityPct: '55.4', warmup: 'minutes', warmupMinutes: '15' })).toEqual({ temperatureC: 22.5, humidityPct: 55, warmup: 'minutes', warmupMinutes: 15 });
    expect(I.normalizeEnvironment({ temperatureC: 60, humidityPct: -1, warmup: 'minutes', warmupMinutes: 999 })).toEqual({ temperatureC: null, humidityPct: null, warmup: 'unknown', warmupMinutes: null });
    expect(I.normalizeEnvironment({ temperatureC: '', warmup: 'done' })).toEqual({ temperatureC: null, humidityPct: null, warmup: 'done', warmupMinutes: null });
    expect(I.describeEnvironment(null)).toBe('未記入');
    expect(I.describeEnvironment({ temperatureC: -10, humidityPct: 100, warmup: 'done' })).toBe('気温 -10.0℃・湿度 100%・ウォームアップ済み');
    const base = { a4Tenths: 4420, temperament: 'equal' };
    expect(I.conditionsKey(Object.assign({}, base, { environment: { temperatureC: 30 } }))).toBe(I.conditionsKey(base));
    const sugg = I.suggestions({ 69: I.summarize([]) }, {});
    expect(JSON.stringify(sugg)).not.toMatch(/気温|湿度|ウォームアップ/);
  });
});
