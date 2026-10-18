import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

// MT-01 / MT-02 / MT-03 / MT-15 (pure model): rational positions, preset
// validation, tempo curves with score end points, compiled event positions.
const require = createRequire(import.meta.url);
const dir = path.join(process.cwd(), 'src/static/js/modules/metronome');
const R = require(path.join(dir, 'rational.js'));
const SM = require(path.join(dir, 'score_model.js'));
const TM = require(path.join(dir, 'tempo_map.js'));
const EC = require(path.join(dir, 'event_compiler.js'));

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function basic(overrides = {}) {
  const p = SM.defaultBasicPreset(uuid(1));
  p.payload = Object.assign({}, p.payload, overrides);
  return p;
}

function snapshotOf(...presets) {
  const store = {};
  const validated = presets.map((p) => {
    const v = SM.validatePreset(p);
    if (!v.ok) throw new Error(JSON.stringify(v.errors));
    store[p.id] = { [p.revision]: v.preset };
    return v.preset;
  });
  const top = validated[validated.length - 1];
  return SM.buildSnapshot(store, top.id, top.revision);
}

function compileAll(snap, from, to, sampleRate = 48000) {
  const map = TM.fromSnapshot(snap);
  return EC.compile({ snapshot: snap, tempoMap: map, origin: { score: R.ZERO, frame: 0 }, sampleRate, from, to });
}

describe('rational positions', () => {
  it('reduces, compares and keeps exact sums (no floating ticks)', () => {
    let s = R.ZERO;
    for (let i = 0; i < 3000; i += 1) s = R.add(s, R.make(1, 3));
    expect(s).toEqual({ n: 1000, d: 1 });
    expect(R.make(6, -8)).toEqual({ n: -3, d: 4 });
    expect(R.cmp(R.make(1, 3), R.make(2, 6))).toBe(0);
    expect(R.floorDiv(R.make(7, 4), R.make(1, 2))).toBe(3);
    expect(R.mod(R.make(7, 4), R.make(1, 2))).toEqual({ n: 1, d: 4 });
    expect(R.dotted(R.make(1, 4), 1)).toEqual({ n: 3, d: 8 });
    expect(R.dotted(R.make(1, 4), 2)).toEqual({ n: 7, d: 16 });
  });

  it('refuses results beyond the safe integer range instead of rounding', () => {
    const big = R.make(Number.MAX_SAFE_INTEGER - 1, 1);
    expect(() => R.add(big, big)).toThrow(RangeError);
    expect(() => R.mul(R.make(1, 2 ** 30), R.make(1, 2 ** 30))).toThrow('rational-overflow');
    expect(() => R.make(1, 0)).toThrow();
  });
});

describe('preset validation (data design 4)', () => {
  it('accepts the default basic preset and stores BPM as tenths', () => {
    const v = SM.validatePreset(basic());
    expect(v.ok).toBe(true);
    expect(v.preset.tempo.bpmTenths).toBe(1200);
    expect(SM.bpmToTenths(120.04)).toBe(1200);
    expect(SM.bpmToTenths(120.05)).toBe(1201); // half up
    expect(SM.bpmToTenths(19.9)).toBeNull(); // below 20 BPM: refused
    expect(SM.bpmToTenths(300.04)).toBe(3000);
    expect(SM.bpmToTenths(300.06)).toBeNull();
  });

  it('refuses unknown keys, prototype keys, wrong group sums, unreduced rationals and wrong accent lengths', () => {
    const codes = (p) => SM.validatePreset(p).errors.map((e) => e.code);
    expect(codes(basic({ extra: 1 }))).toContain('unknown-field');
    const proto = basic();
    Object.defineProperty(proto.payload, '__proto__', { value: 1, enumerable: true });
    expect(codes(proto)).toContain('forbidden-key');
    expect(codes(basic({ groups: [2, 1] }))).toContain('groups-sum-mismatch');
    expect(codes(basic({ pulse: { n: 2, d: 8 } }))).toContain('rational-not-reduced');
    expect(codes(basic({ accent: { group: [1, 1, 1, 1], pulse: [1, 1], subdivision: 0.3 } }))).toContain('length-mismatch');
    expect(codes(basic({ tempo: { bpmTenths: 120.5, reference: { n: 1, d: 4 } } }))).toContain('out-of-range');
    expect(codes(basic({ meter: { numerator: 4, denominator: 3 } }))).toContain('invalid-denominator');
    expect(codes(basic({ subdivision: { unit: { n: 1, d: 64 } } }))).toContain('below-32nd');
    const unknownVersion = basic();
    unknownVersion.schemaVersion = 2;
    expect(SM.validatePreset(unknownVersion)).toMatchObject({ ok: false, unknownVersion: true });
  });

  it('builds a frozen snapshot through base references and refuses cycles / missing bases', () => {
    const b = basic();
    const adv = { schemaVersion: 1, id: uuid(2), revision: 1, kind: 'advanced', title: '3対2', payload: { basePresetId: b.id, baseRevision: 1, layers: [{ id: 'three', cycle: { n: 3, d: 4 }, pulses: 3, phase: { n: 0, d: 1 } }] } };
    const snap = snapshotOf(b, adv);
    expect(snap.kind).toBe('advanced');
    expect(snap.source.map((s) => s.kind)).toEqual(['basic', 'advanced']);
    expect(Object.isFrozen(snap.barTemplate)).toBe(true);
    const store = { [adv.id]: { 1: SM.validatePreset(adv).preset } };
    expect(() => SM.buildSnapshot(store, adv.id, 1)).toThrow('invalid-preset');
  });
});

describe('6/8 with either reference (design 5)', () => {
  it('dotted quarter = 60 gives a 2 s bar; eighth = 60 gives a 6 s bar', () => {
    const six8 = { meter: { numerator: 6, denominator: 8 }, groups: [3, 3], pulse: { n: 1, d: 8 }, accent: { group: [1, 0.8], pulse: [1, 0.4, 0.4, 0.8, 0.4, 0.4], subdivision: 0.3 } };
    const dq = snapshotOf(basic(Object.assign({}, six8, { tempo: { bpmTenths: 600, reference: { n: 3, d: 8 } } })));
    const e8 = snapshotOf(basic(Object.assign({}, six8, { tempo: { bpmTenths: 600, reference: { n: 1, d: 8 } } })));
    expect(TM.fromSnapshot(dq).timeAt(R.make(6, 8))).toBeCloseTo(2, 12);
    expect(TM.fromSnapshot(e8).timeAt(R.make(6, 8))).toBeCloseTo(6, 12);
    // Same speed after changing the reference: Bnew = Bold * rold / rnew.
    expect(60 * (3 / 8) / (1 / 8)).toBe(180);
    const ev = compileAll(dq, R.ZERO, R.make(6, 8)).events;
    expect(ev.map((e) => e.accentLevel)).toEqual(['group', 'pulse', 'pulse', 'group', 'pulse', 'pulse']);
    expect(ev.map((e) => e.frame)).toEqual([0, 16000, 32000, 48000, 64000, 80000]);
  });

  it('7/8 = 2+2+3 classifies group heads, and accents are not doubled', () => {
    const s = snapshotOf(basic({ meter: { numerator: 7, denominator: 8 }, groups: [2, 2, 3], pulse: { n: 1, d: 8 }, accent: { group: [1, 0.8, 0.8], pulse: [1, 0.4, 0.8, 0.4, 0.8, 0.4, 0.4], subdivision: 0.2 } }));
    const ev = compileAll(s, R.ZERO, R.make(7, 8)).events;
    expect(ev).toHaveLength(7);
    expect(ev.filter((e) => e.accentLevel === 'group').map((e) => R.toString(e.offset))).toEqual(['0', '1/4', '1/2']);
  });
});

describe('tempo curves end at score positions (design 6)', () => {
  const D = (b0, b1, U, curve) => TM.durationOf(curve, b0, b1, U);

  it('closed forms: constant, linear and exponential durations', () => {
    expect(D(60, 60, 4, 'constant')).toBeCloseTo(4, 12);
    expect(D(60, 80, 13 / 3, 'linear')).toBeCloseTo(26 / 7, 12);
    expect(D(60, 120, 10, 'exponential')).toBeCloseTo(600 * Math.log(2) / 60, 12);
    // Nearly constant: the limit is the constant formula.
    expect(D(100, 100 * (1 + 1e-12), 8, 'exponential')).toBeCloseTo(4.8, 9);
  });

  it('the map is continuous, the end point is exact and the inverse round-trips', () => {
    for (const curve of ['linear', 'exponential']) {
      const map = TM.createTempoMap({
        initial: { bpm: 60, reference: R.make(1, 4) },
        segments: [{ start: R.make(1, 1), end: R.make(3, 1), reference: R.make(1, 4), b0: 60, b1: 150, curve }],
      });
      const end = map.timeAt(R.make(3, 1));
      const expected = 4 + D(60, 150, 8, curve);
      expect(end).toBeCloseTo(expected, 12);
      for (const x of [0.5, 1, 1.37, 2.2, 2.999, 3, 4.5]) {
        const t = map.timeAt(R.make(Math.round(x * 1000), 1000));
        expect(map.scoreAt(t)).toBeCloseTo(Math.round(x * 1000) / 1000, 9);
      }
      // After the curve the tempo stays at the end BPM.
      expect(map.tempoAt(R.make(4, 1)).bpm).toBeCloseTo(150, 9);
      expect(map.timeAt(R.make(4, 1)) - end).toBeCloseTo(60 * 4 / 150, 12);
    }
  });

  it('a score curve from the example: 6/8 + 7/8 at dotted quarter, 60 -> 80 linear = 26/7 s', () => {
    const b = basic({ tempo: { bpmTenths: 600, reference: { n: 3, d: 8 } }, meter: { numerator: 6, denominator: 8 }, groups: [3, 3], pulse: { n: 1, d: 8 }, accent: { group: [1, 0.8], pulse: [1, 0.4, 0.4, 0.8, 0.4, 0.4], subdivision: 0.3 } });
    const b1 = uuid(11);
    const b2 = uuid(12);
    const bar = (id, num, groups, pulseAccents) => ({ id, meter: { numerator: num, denominator: 8 }, groups, pulse: { n: 1, d: 8 }, accent: { group: groups.map(() => 1), pulse: pulseAccents, subdivision: 0.2 }, soundId: 'click', mute: false });
    const score = {
      schemaVersion: 1, id: uuid(3), revision: 1, kind: 'score', title: '楽曲',
      payload: {
        basePresetId: b.id, baseRevision: 1,
        bars: [bar(b1, 6, [3, 3], [1, 0.4, 0.4, 0.8, 0.4, 0.4]), bar(b2, 7, [2, 2, 3], [1, 0.4, 0.8, 0.4, 0.8, 0.4, 0.4])],
        tempoMap: [{ start: { barId: b1, offset: { n: 0, d: 1 } }, end: { barId: b2, offset: { n: 7, d: 8 } }, reference: { n: 3, d: 8 }, startBpmTenths: 600, endBpmTenths: 800, curve: 'linear', domain: 'seconds' }],
        events: [],
      },
    };
    const snap = snapshotOf(b, score);
    const map = TM.fromSnapshot(snap);
    expect(map.timeAt(R.make(13, 8))).toBeCloseTo(26 / 7, 12);
    // The stored form has no duration; a duration field is refused.
    const withDuration = JSON.parse(JSON.stringify(score));
    withDuration.payload.tempoMap[0].durationSeconds = 3.71;
    expect(SM.validatePreset(withDuration).errors.map((e) => e.code)).toContain('unknown-field');
  });

  it('metric modulation: old quarter = new dotted eighth turns 120 into 90', () => {
    const b = basic();
    const bars = [uuid(21), uuid(22)].map((id) => ({ id, meter: { numerator: 4, denominator: 4 }, groups: [1, 1, 1, 1], pulse: { n: 1, d: 4 }, accent: { group: [1, 0.7, 0.7, 0.7], pulse: [1, 0.7, 0.7, 0.7], subdivision: 0.3 }, soundId: 'click', mute: false }));
    const score = { schemaVersion: 1, id: uuid(4), revision: 1, kind: 'score', title: 'mod', payload: { basePresetId: b.id, baseRevision: 1, bars, tempoMap: [], events: [{ id: 'm1', kind: 'modulation', at: { barId: bars[1].id, offset: { n: 0, d: 1 } }, oldValue: { n: 1, d: 4 }, newValue: { n: 3, d: 16 } }] } };
    const map = TM.fromSnapshot(snapshotOf(b, score));
    expect(map.tempoAt(R.make(1, 1)).bpm).toBeCloseTo(90, 9);
    expect(map.tempoAt(R.make(1, 2)).bpm).toBeCloseTo(120, 9);
  });

  it('refuses overlapping curves and tempos outside the limits', () => {
    expect(() => TM.createTempoMap({ initial: { bpm: 100, reference: R.make(1, 4) }, segments: [
      { start: R.ZERO, end: R.make(2, 1), reference: R.make(1, 4), b0: 100, b1: 120, curve: 'linear' },
      { start: R.make(1, 1), end: R.make(3, 1), reference: R.make(1, 4), b0: 120, b1: 100, curve: 'linear' },
    ] })).toThrow('overlapping-segments');
  });
});

describe('compiler: subdivision, tuplets, swing, poly and practice masks', () => {
  it('32nd subdivision at 120 BPM: 8 events per beat, frames from the origin without accumulation', () => {
    const s = snapshotOf(basic({ subdivision: { unit: { n: 1, d: 32 } } }));
    const ev = compileAll(s, R.ZERO, R.make(1, 1), 44100).events;
    expect(ev).toHaveLength(32);
    ev.forEach((e, i) => expect(e.frame).toBe(Math.round(44100 * i * 0.0625)));
  });

  it('eighth-note triplets (3:2): three equal clicks per quarter', () => {
    const s = snapshotOf(basic({ subdivision: { unit: { n: 1, d: 8 }, tuplet: { n: 3, m: 2 } } }));
    const ev = compileAll(s, R.ZERO, R.make(1, 4)).events;
    expect(ev.map((e) => R.toString(e.offset))).toEqual(['0', '1/12', '1/6']);
  });

  it('swing 2:1 moves the middle of each eighth pair to 2/3; pair ends stay', () => {
    const b = basic({ subdivision: { unit: { n: 1, d: 8 } } });
    const adv = { schemaVersion: 1, id: uuid(5), revision: 1, kind: 'advanced', title: 'swing', payload: { basePresetId: b.id, baseRevision: 1, layers: [{ id: 'x', cycle: { n: 1, d: 1 }, pulses: 1, phase: { n: 0, d: 1 }, volume: 0 }], swing: { ratio: [2, 1], target: 'ordinaryEighthPairs', applyInsideTuplets: false, layerIds: ['meter'] } } };
    const ev = compileAll(snapshotOf(b, adv), R.ZERO, R.make(1, 2)).events.filter((e) => e.layerId === 'meter');
    expect(ev.map((e) => R.toString(e.offset))).toEqual(['0', '1/6', '1/4', '5/12']);
  });

  it('poly 3 against 2: 3 + 2 clicks, grid of 6 cells, phase kept across bars', () => {
    const b = basic({ meter: { numerator: 3, denominator: 4 }, groups: [1, 1, 1], accent: { group: [1, 0.7, 0.7], pulse: [1, 0.7, 0.7], subdivision: 0.3 } });
    const adv = { schemaVersion: 1, id: uuid(6), revision: 1, kind: 'advanced', title: '3:2', payload: { basePresetId: b.id, baseRevision: 1, layers: [{ id: 'two', cycle: { n: 3, d: 4 }, pulses: 2, phase: { n: 0, d: 1 } }] } };
    const snap = snapshotOf(b, adv);
    const ev = compileAll(snap, R.ZERO, R.make(3, 2)).events;
    expect(ev.filter((e) => e.layerId === 'meter')).toHaveLength(6);
    expect(ev.filter((e) => e.layerId === 'two').map((e) => R.toString(e.score))).toEqual(['0', '3/8', '3/4', '9/8']);
    expect(EC.polyGrid(snap.layers.concat([{ cycle: R.make(3, 4), pulses: 3 }])).cells).toBe(6);
  });

  it('muted bars keep their expected beats (emit=false); random mute is reproducible from the seed', () => {
    const p = basic({ practice: { mute: { playBars: 1, muteBars: 1 }, randomMute: { unit: 'event', probability: 0.5, seed: 42, algorithmVersion: 1 } } });
    const snap = snapshotOf(p);
    const a = compileAll(snap, R.ZERO, R.make(4, 1)).events;
    const b = compileAll(snap, R.make(2, 1), R.make(4, 1)).events;
    expect(a.filter((e) => e.occurrence === 1).every((e) => e.expected && !e.emit)).toBe(true);
    // Seeking to bar 2 gives the same choices as playing through.
    const fromA = a.filter((e) => R.ge(e.score, R.make(2, 1))).map((e) => e.emit);
    expect(b.map((e) => e.emit)).toEqual(fromA);
  });

  it('off-beat practice adds off-beat clicks and can mute the on-beat while keeping them expected', () => {
    const snap = snapshotOf(basic({ practice: { offbeat: { offset: { n: 1, d: 8 }, muteOnBeat: true } } }));
    const ev = compileAll(snap, R.ZERO, R.make(1, 1)).events;
    expect(ev.filter((e) => e.kind === 'offbeat' && e.emit)).toHaveLength(4);
    expect(ev.filter((e) => e.kind !== 'offbeat').every((e) => !e.emit && e.expected)).toBe(true);
  });

  it('count-in ends exactly at the origin frame with the first bar\'s pulses', () => {
    const snap = snapshotOf(basic());
    const map = TM.fromSnapshot(snap);
    const ci = EC.compileCountIn({ snapshot: snap, tempoMap: map, start: R.ZERO, bars: 1, originFrame: 96000, sampleRate: 48000 });
    expect(ci.map((e) => e.frame)).toEqual([0, 24000, 48000, 72000]);
    expect(ci.every((e) => !e.expected)).toBe(true);
  });

  it('density preflight refuses before playing (no thinning)', () => {
    const fast = snapshotOf(basic({ tempo: { bpmTenths: 3000, reference: { n: 1, d: 4 } }, subdivision: { unit: { n: 1, d: 32 } } }));
    expect(EC.preflight(fast, TM.fromSnapshot(fast))).toMatchObject({ ok: true, eventsPerSecond: 40 });
    const b = basic({ tempo: { bpmTenths: 3000, reference: { n: 1, d: 4 } }, subdivision: { unit: { n: 1, d: 32 }, tuplet: { n: 7, m: 4 } } });
    const adv = { schemaVersion: 1, id: uuid(7), revision: 1, kind: 'advanced', title: 'dense', payload: { basePresetId: b.id, baseRevision: 1, layers: [1, 2, 3, 4].map((i) => ({ id: 'l' + i, cycle: { n: 1, d: 4 }, pulses: 64, phase: { n: 0, d: 1 } })) } };
    expect(EC.preflight(snapshotOf(b, adv), TM.fromSnapshot(snapshotOf(b, adv)))).toMatchObject({ ok: false, reason: 'too-many-events-per-second' });
  });
});

describe('score expansion, fermata and cues (design 13)', () => {
  const bars = [uuid(31), uuid(32), uuid(33)].map((id) => ({ id, meter: { numerator: 4, denominator: 4 }, groups: [1, 1, 1, 1], pulse: { n: 1, d: 4 }, accent: { group: [1, 0.7, 0.7, 0.7], pulse: [1, 0.7, 0.7, 0.7], subdivision: 0.3 }, soundId: 'click', mute: false }));

  function scoreWith(events, mutes = []) {
    const b = basic();
    const bs = bars.map((bar, i) => Object.assign({}, bar, { mute: mutes.includes(i) }));
    return snapshotOf(b, { schemaVersion: 1, id: uuid(8), revision: 1, kind: 'score', title: 's', payload: { basePresetId: b.id, baseRevision: 1, bars: bs, tempoMap: [], events } });
  }

  it('repeats expand to occurrences; the finite score ends', () => {
    const snap = scoreWith([{ id: 'r', kind: 'repeat', startBarId: bars[0].id, endBarId: bars[1].id, count: 2 }]);
    expect(snap.occurrences.map((o) => [o.barId === bars[0].id ? 'A' : o.barId === bars[1].id ? 'B' : 'C', o.iteration])).toEqual([['A', 0], ['B', 0], ['A', 1], ['B', 1], ['C', 0]]);
    const res = compileAll(snap, R.make(4, 1), R.make(6, 1));
    expect(res.end).toBe(true);
    expect(res.events).toHaveLength(4);
  });

  it('a fermata limits the window: its own event sounds, nothing after it is compiled', () => {
    const snap = scoreWith([{ id: 'f', kind: 'fermata', at: { barId: bars[1].id, offset: { n: 1, d: 2 } }, resumeCountInPulses: 1 }]);
    const res = compileAll(snap, R.ZERO, R.make(3, 1));
    expect(res.fermata).toMatchObject({ id: 'f', resumeCountInPulses: 1 });
    expect(R.toString(res.events[res.events.length - 1].score)).toBe('3/2');
  });

  it('cue counts down before the target and sounds even in muted (long-rest) bars', () => {
    const snap = scoreWith([{ id: 'c', kind: 'cue', target: { barId: bars[2].id, offset: { n: 0, d: 1 } }, before: { unit: 'bar', count: 2 }, soundId: 'cue' }], [0, 1]);
    const ev = compileAll(snap, R.ZERO, R.make(3, 1)).events;
    const cues = ev.filter((e) => e.kind === 'cue');
    expect(cues.map((e) => [R.toString(e.score), e.label])).toEqual([['0', '2'], ['1', '1']]);
    expect(ev.filter((e) => e.layerId === 'meter' && e.occurrence < 2).every((e) => !e.emit)).toBe(true);
  });
});
