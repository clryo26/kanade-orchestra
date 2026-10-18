import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

// Phases 02-05 (pure logic): advanced rhythm (MT-03), practice programs and
// tempo steps (MT-09 / MT-11), accelerando score (MT-02), orchestra score
// helpers (MT-09), attack detection (MT-16) and timing statistics (MT-17).
const require = createRequire(import.meta.url);
const dir = path.join(process.cwd(), 'src/static/js/modules/metronome');
const R = require(path.join(dir, 'rational.js'));
const SM = require(path.join(dir, 'score_model.js'));
const TM = require(path.join(dir, 'tempo_map.js'));
const EC = require(path.join(dir, 'event_compiler.js'));
const IX = require(path.join(dir, 'index.js'));
const VA = require(path.join(dir, 'view_advanced.js'));
const TR = require(path.join(dir, 'trainer.js'));
const VP = require(path.join(dir, 'view_practice.js'));
const VS = require(path.join(dir, 'view_score.js'));
const OA = require(path.join(dir, 'onset_adapter.js'));
const TA = require(path.join(dir, 'timing_analysis.js'));

let seq = 0;
const uuid = () => {
  seq += 1;
  return `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
};
const BASIC = '00000000-0000-4000-8000-00000000b001';

function basicEnvelope(overrides = {}) {
  const p = SM.defaultBasicPreset(BASIC);
  p.payload = Object.assign({}, p.payload, overrides);
  return p;
}

function snapshot(basic, extra) {
  const store = {};
  const vb = SM.validatePreset(basic);
  if (!vb.ok) throw new Error(JSON.stringify(vb.errors));
  store[basic.id] = { 1: vb.preset };
  let top = basic.id;
  for (const env of extra || []) {
    const v = SM.validatePreset(env);
    if (!v.ok) throw new Error(JSON.stringify(v.errors));
    store[env.id] = { 1: v.preset };
    top = env.id;
  }
  return SM.buildSnapshot(store, top, 1);
}

function compile(snap, from, to, sampleRate = 48000) {
  const map = TM.fromSnapshot(snap);
  return EC.compile({ snapshot: snap, tempoMap: map, origin: { score: R.ZERO, frame: 0 }, sampleRate, from, to }).events;
}

function scoreEnvelope(doc, baseId = BASIC) {
  return { schemaVersion: 1, id: '00000000-0000-4000-8000-00000000c001', revision: 1, kind: 'score', title: doc.title || '楽曲', payload: { basePresetId: baseId, baseRevision: 1, bars: doc.bars, tempoMap: doc.tempoMap, events: doc.events, ...(doc.conductor ? { conductor: doc.conductor } : {}) } };
}

describe('advanced rhythm (phase 02)', () => {
  it('turns a cell pattern into validated rhythm items and keeps the default pattern implicit', () => {
    const plain = VA.layerFromForm({ id: 'layer1', cycleText: '1', pulses: 3, phaseText: '0', soundId: 'wood', volume: 1, pattern: VA.defaultPattern(3) });
    expect(plain.layer.rhythm).toBeUndefined();
    const custom = VA.layerFromForm({ id: 'layer1', cycleText: '1', pulses: 3, phaseText: '1/8', soundId: 'wood', volume: 1, pattern: ['strong', 'rest', 'weak'] });
    expect(custom.layer.rhythm.map((r) => [r.offset, r.rest, r.accentLevel])).toEqual([
      [{ n: 0, d: 1 }, false, 'group'],
      [{ n: 1, d: 3 }, true, 'pulse'],
      [{ n: 2, d: 3 }, false, 'subdivision'],
    ]);
    const adv = { schemaVersion: 1, id: '00000000-0000-4000-8000-00000000a001', revision: 1, kind: 'advanced', title: 'x', payload: { basePresetId: BASIC, baseRevision: 1, layers: [custom.layer] } };
    expect(SM.validatePreset(adv).ok).toBe(true);
    expect(VA.layerFromForm({ id: 'l', cycleText: '1/4', pulses: 2, phaseText: '1/2' }).error).toMatch(/周期より短く/);
    expect(VA.layerFromForm({ id: 'l', cycleText: 'abc', pulses: 2 }).error).toBeTruthy();
  });

  it('plays a rest cell silently but keeps it as an expected position (emit=false)', () => {
    const custom = VA.layerFromForm({ id: 'layer1', cycleText: '1', pulses: 3, phaseText: '0', soundId: 'wood', volume: 1, pattern: ['strong', 'rest', 'medium'] }).layer;
    const snap = snapshot(basicEnvelope(), [{ schemaVersion: 1, id: '00000000-0000-4000-8000-00000000a001', revision: 1, kind: 'advanced', title: 'x', payload: { basePresetId: BASIC, baseRevision: 1, layers: [custom] } }]);
    const layer = compile(snap, R.ZERO, R.ONE).filter((e) => e.layerId === 'layer1');
    expect(layer.map((e) => [R.toString(e.score), e.emit])).toEqual([['0', true], ['1/3', false], ['2/3', true]]);
  });

  it('allows swing without poly layers (implementation change IC-01) and swings the meter subdivision', () => {
    const swing = VA.swingFromForm({ enabled: true, ratio: '2:1', target: 'ordinaryEighthPairs', applyInsideTuplets: false, layerIds: ['meter'] }, []);
    const adv = { schemaVersion: 1, id: '00000000-0000-4000-8000-00000000a001', revision: 1, kind: 'advanced', title: 'x', payload: { basePresetId: BASIC, baseRevision: 1, layers: [], swing } };
    expect(SM.validatePreset(adv).ok).toBe(true);
    // Empty layers without swing are still refused.
    expect(SM.validatePreset({ ...adv, payload: { basePresetId: BASIC, baseRevision: 1, layers: [] } }).ok).toBe(false);
    const snap = snapshot(basicEnvelope({ subdivision: { unit: { n: 1, d: 8 } } }), [adv]);
    const offbeats = compile(snap, R.ZERO, R.make(1, 2)).filter((e) => e.layerId === 'meter' && e.accentLevel === 'subdivision');
    // The second eighth of a pair moves to 2/3 of the pair (2:1).
    expect(R.toString(offbeats[0].score)).toBe('1/6');
  });

  it('shows 3 against 2 as a 6-cell common grid; huge grids fall back to per-layer display', () => {
    const rows = [{ cycle: R.make(1, 2), pulses: 2, phase: R.ZERO }, { cycle: R.make(1, 2), pulses: 3, phase: R.ZERO }];
    expect(EC.polyGrid(rows).cells).toBe(6);
    const big = [{ cycle: R.make(1, 1), pulses: 13 }, { cycle: R.make(1, 1), pulses: 17 }, { cycle: R.make(1, 1), pulses: 19 }];
    expect(EC.polyGrid(big).perLayer).toBe(true);
  });

  it('builds a meter sequence as a looping score (3/4 + 2/4 + 7/8)', () => {
    const parsed = VA.parseMeterSequence('3/4, 2/4, 7/8=2+2+3');
    expect(parsed.meters.map((m) => m.groups)).toEqual([[1, 1, 1], [1, 1], [2, 2, 3]]);
    expect(VA.parseMeterSequence('3/4').error).toBeTruthy();
    expect(VA.parseMeterSequence('3/4, 7/8=2+2').error).toMatch(/合計/);
    const doc = VA.scoreFromMeters(parsed.meters, uuid, 'click', IX.defaultAccents);
    const snap = snapshot(basicEnvelope(), [scoreEnvelope(doc)]);
    expect(R.toString(snap.totalLength)).toBe('17/8');
    // Second pass starts right after the first (untilStop loop).
    const heads = compile(snap, R.ZERO, R.make(30, 8)).filter((e) => e.layerId === 'meter' && e.accentLevel === 'group' && R.isZero(e.offset));
    expect(heads.map((e) => R.toString(e.score))).toEqual(['0', '3/4', '5/4', '17/8', '23/8', '27/8']);
  });
});

describe('practice programs (phase 03)', () => {
  const step = (over = {}) => ({ id: uuid(), presetId: TR.CURRENT_PRESET_ID, presetRevision: 1, end: { kind: 'bars', value: 4 }, exercise: 'play', ...over });

  it('validates the program schema strictly', () => {
    expect(TR.validateProgram({ steps: [step()], repeat: 2 }).ok).toBe(true);
    expect(TR.validateProgram({ steps: [step({ extra: 1 })] }).errors[0].code).toBe('unknown-field');
    expect(TR.validateProgram({ steps: [step({ tempoStep: { deltaBpmTenths: 0, at: 'bars', every: 2, minBpmTenths: 600, maxBpmTenths: 1200, onLimit: 'stop' } })] }).ok).toBe(false);
    expect(TR.validateProgram({ steps: [step({ tempoStep: { deltaBpmTenths: 40, at: 'bars', every: 2, minBpmTenths: 1300, maxBpmTenths: 1200, onLimit: 'stop' } })] }).errors.some((e) => e.code === 'min-above-max')).toBe(true);
    expect(TR.validateProgram({ steps: [step({ exercise: 'tempoGuess', end: { kind: 'manual' } })] }).ok).toBe(false);
    const s = step();
    expect(TR.validateProgram({ steps: [s, { ...s }] }).errors.some((e) => e.code === 'duplicate-id')).toBe(true);
    expect(TR.validateProgram({ steps: Array.from({ length: 257 }, () => step()) }).ok).toBe(false);
  });

  it('applies tempo steps with stop / hold / reverse at the limit', () => {
    const ts = { deltaBpmTenths: 100, minBpmTenths: 600, maxBpmTenths: 1250 };
    expect(TR.nextTempo(1200, { ...ts, onLimit: 'stop' }, 1)).toEqual({ bpmTenths: 1250, direction: 1, limit: 'stop' });
    expect(TR.nextTempo(1200, { ...ts, onLimit: 'hold' }, 1)).toEqual({ bpmTenths: 1250, direction: 1, limit: 'hold' });
    expect(TR.nextTempo(1200, { ...ts, onLimit: 'reverse' }, 1)).toEqual({ bpmTenths: 1100, direction: -1, limit: 'reverse' });
    expect(TR.nextTempo(1100, { ...ts, onLimit: 'reverse' }, 1).bpmTenths).toBe(1200);
  });

  it('scores a tempo guess without pass / fail and draws hidden tempos in range', () => {
    expect(TR.tempoGuessResult(1200, 126)).toEqual({ truthBpm: 120, answerBpm: 126, errorBpm: 6, errorPercent: 5 });
    expect(TR.tempoGuessResult(1200, Number.NaN)).toBeNull();
    expect(TR.hiddenTempo(600, 1600, () => 0)).toBe(600);
    expect(TR.hiddenTempo(600, 1600, () => 0.9999)).toBe(1600);
  });

  function fakeApi() {
    const listeners = [];
    const calls = [];
    let state = 'stopped';
    let draft = { bpmTenths: 1000 };
    const api = {
      calls,
      on: (fn) => { listeners.push(fn); return () => {}; },
      emit: (type, payload) => listeners.forEach((fn) => fn(type, payload)),
      state: () => state,
      setState: (s) => { state = s; },
      play: (o) => { calls.push(['play', o]); state = 'running'; },
      stop: (r) => { calls.push(['stop', r]); state = 'stopped'; api.emit('stopped', { reason: r }); },
      setDraft: (next, source, mode) => { draft = { ...draft, ...next }; calls.push(['draft', next, mode]); return Promise.resolve({ ok: true }); },
      getDraft: () => ({ ...draft }),
      setPractice: (p) => { calls.push(['practice', p]); },
      setConcealTempo: (on) => calls.push(['conceal', on]),
      sampleRate: () => 1000,
      transport: () => ({ getSnapshot: () => ({ loop: true }) }),
      showMessage: () => {},
      announce: () => {},
    };
    return api;
  }

  function tick(api, occurrence, frame) {
    api.emit('tick', { position: { occurrence, score: { n: occurrence, d: 1 }, ended: false }, frame });
  }

  it('runs steps: tempo step on bar boundaries (next bar), end after N bars, rest then a tap for the next step', () => {
    const api = fakeApi();
    const results = [];
    const timers = [];
    const runner = TR.createProgramRunner({
      api,
      uuid,
      utcNow: () => '2026-10-18T00:00:00Z',
      setTimeout: (fn) => { timers.push(fn); return timers.length; },
      clearTimeout: () => {},
      resolvePreset: () => ({}),
      onResult: (r) => results.push(r),
    });
    const program = { steps: [step({ end: { kind: 'bars', value: 4 }, startBpmTenths: 1000, restSeconds: 1, tempoStep: { deltaBpmTenths: 50, at: 'bars', every: 2, minBpmTenths: 600, maxBpmTenths: 2000, onLimit: 'hold' } }), step({ end: { kind: 'bars', value: 1 } })], repeat: 1 };
    const started = runner.start(program);
    expect(started.ok).toBe(true);
    expect(api.calls.find((c) => c[0] === 'play')).toBeTruthy();
    for (let bar = 0; bar <= 3; bar += 1) tick(api, bar, bar * 1000);
    // After 2 bars: +5.0 BPM applied at the next bar boundary.
    expect(api.calls.filter((c) => c[0] === 'draft' && c[2] === 'nextBar').map((c) => c[1].bpmTenths)).toEqual([1050]);
    tick(api, 4, 4000);
    expect(api.calls.filter((c) => c[0] === 'stop').length).toBe(1);
    expect(runner.view().state).toBe('resting');
    timers.shift()();
    expect(runner.view().state).toBe('ready');
    // The next step starts only from the user's tap.
    const plays = api.calls.filter((c) => c[0] === 'play').length;
    expect(runner.next()).toBe(true);
    expect(api.calls.filter((c) => c[0] === 'play').length).toBe(plays + 1);
    tick(api, 0, 0);
    tick(api, 1, 1000);
    expect(runner.view().state).toBe('done');
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('complete');
    expect(results[0].steps.map((s) => [s.endReason, s.bars, s.endBpmTenths])).toEqual([['bars', 4, 1100], ['bars', 1, 1100]]);
  });

  it('a user stop or a new start closes the running attempt as incomplete (one result per attempt)', () => {
    const api = fakeApi();
    const results = [];
    const runner = TR.createProgramRunner({ api, uuid, utcNow: () => 't', setTimeout: () => 0, clearTimeout: () => {}, resolvePreset: () => ({}), onResult: (r) => results.push(r) });
    const a = runner.start({ steps: [step({ end: { kind: 'manual' } })] });
    tick(api, 0, 0);
    const b = runner.start({ steps: [step({ end: { kind: 'manual' } })] });
    expect(results.map((r) => [r.attemptId, r.status, r.endReason])).toEqual([[a.attemptId, 'incomplete', 'superseded']]);
    // The stop button of the transport bar.
    api.stop('stop');
    expect(results[1].attemptId).toBe(b.attemptId);
    expect(results[1].endReason).toBe('user-stop');
  });

  it('tempo guessing hides the tempo, waits for the answer and records the error', () => {
    const api = fakeApi();
    const results = [];
    const runner = TR.createProgramRunner({ api, uuid, utcNow: () => 't', setTimeout: () => 0, clearTimeout: () => {}, random: () => 0.5, resolvePreset: () => ({}), onResult: (r) => results.push(r) });
    runner.start({ steps: [step({ exercise: 'tempoGuess', end: { kind: 'bars', value: 2 }, tempoStep: { deltaBpmTenths: 10, at: 'bars', every: 1, minBpmTenths: 800, maxBpmTenths: 1000, onLimit: 'hold' } })] });
    expect(api.calls).toContainEqual(['conceal', true]);
    expect(runner.view().bpmTenths).toBeNull(); // never exposed while guessing
    tick(api, 0, 0);
    tick(api, 2, 2000);
    expect(runner.view().state).toBe('guessing');
    const truth = api.getDraft().bpmTenths;
    const res = runner.submitGuess(truth / 10 + 3);
    expect(res.errorBpm).toBe(3);
    expect(api.calls).toContainEqual(['conceal', false]);
    expect(results[0].steps[0].guess.errorBpm).toBe(3);
  });

  it('counts playing time on the audio clock: pauses are excluded, sparse display ticks are not lost (R-09)', () => {
    const api = fakeApi();
    const runner = TR.createProgramRunner({ api, uuid, utcNow: () => 't', setTimeout: () => 0, clearTimeout: () => {}, resolvePreset: () => ({}), onResult: () => {} });
    runner.start({ steps: [step({ end: { kind: 'activeSeconds', value: 100 } })] });
    tick(api, 0, 0);
    tick(api, 0, 400);
    api.setState('paused');
    api.emit('state', { state: 'paused' });
    tick(api, 0, 800);
    api.setState('running');
    api.emit('state', { state: 'running' });
    tick(api, 0, 900);
    tick(api, 0, 5000); // a slow display while the click keeps running: counted
    expect(runner.view().activeSeconds).toBeCloseTo(4.5, 5);
  });

  it('counts repeats of an endless score section', () => {
    const snap = { loop: false, occurrences: [{}, {}, {}], loopFrom: 1 };
    expect(TR.passesAt(snap, 2)).toBe(0);
    expect(TR.passesAt(snap, 3)).toBe(1);
    expect(TR.passesAt(snap, 5)).toBe(2);
    expect(TR.passesAt({ loop: true }, 7)).toBe(7);
  });
});

describe('accelerando score (phase 03, MT-02)', () => {
  it('ends the curve at the end of the last ramp bar and derives the duration (no stored seconds)', () => {
    const draft = { meter: [4, 4], groups: [1, 1, 1, 1], pulse: '1/4', reference: '1/4', soundId: 'click', accent: IX.defaultAccents(4, 4) };
    const built = VP.rampScore({ draft, startBpmTenths: 600, endBpmTenths: 1200, bars: 2, holdBars: 1, curve: 'linear' }, uuid, IX.defaultAccents);
    expect(built.doc.tempoMap[0]).not.toHaveProperty('durationSeconds');
    const snap = snapshot(basicEnvelope({ tempo: { bpmTenths: 600, reference: { n: 1, d: 4 } } }), [scoreEnvelope(built.doc)]);
    const map = TM.fromSnapshot(snap);
    // U = 8 quarter beats, linear 60 -> 120: D = 120U/(B0+B1) = 960/180 s.
    expect(map.timeAt(R.make(2, 1))).toBeCloseTo(960 / 180, 9);
    // Hold bar at 120 BPM: 2 s more.
    expect(map.timeAt(R.make(3, 1)) - map.timeAt(R.make(2, 1))).toBeCloseTo(2, 9);
    expect(VP.rampScore({ draft, startBpmTenths: 600, endBpmTenths: 4000, bars: 2 }, uuid, IX.defaultAccents).error).toBeTruthy();
  });

  it('maps the practice form to masks that keep expected beats', () => {
    const p = VP.practiceFromForm({ muteOn: true, playBars: 2, muteBars: 1, randomOn: true, randomUnit: 'bar', probability: 0.5, seed: 42, offbeatOn: true, muteOnBeat: true, beatFeel: '1/8' }, { pulse: '1/4' });
    expect(p).toEqual({ mute: { playBars: 2, muteBars: 1 }, randomMute: { unit: 'bar', probability: 0.5, seed: 42, algorithmVersion: 1 }, offbeat: { offset: { n: 1, d: 8 }, muteOnBeat: true }, beatFeel: { pulse: { n: 1, d: 8 } } });
    expect(VP.practiceFromForm({ beatFeel: 'none' }, { pulse: '1/4' })).toBeNull();
  });
});

describe('orchestra score (phase 04)', () => {
  it('parses meters, groups bars into runs and finds the start of a written bar', () => {
    expect(VS.parseMeterText('7/8=2+2+3')).toEqual({ meter: [7, 8], groups: [2, 2, 3] });
    expect(VS.parseMeterText('6/8').groups).toEqual([3, 3]);
    expect(VS.parseMeterText('5/7')).toBeNull();
    const bars = VS.buildBars({ meter: [4, 4], groups: [1, 1, 1, 1] }, 3, {}, uuid, IX.defaultAccents)
      .concat(VS.buildBars({ meter: [3, 4], groups: [1, 1, 1] }, 2, { mute: true }, uuid, IX.defaultAccents));
    expect(VS.runsOf(bars).map((r) => [r.start, r.end, r.mute])).toEqual([[0, 2, false], [3, 4, true]]);
    const snap = snapshot(basicEnvelope(), [scoreEnvelope({ bars, tempoMap: [], events: [] })]);
    expect(R.toString(VS.startOfBar(snap, 3))).toBe('3');
    // Long rest: two muted 3/4 bars from occurrence 3.
    expect(VS.longRestInfo(snap, 3, 0)).toEqual({ barsLeft: 2, pulsesLeftInBar: 3 });
    expect(VS.longRestInfo(snap, 4, 0.5)).toEqual({ barsLeft: 1, pulsesLeftInBar: 1 });
    expect(VS.longRestInfo(snap, 0, 0)).toBeNull();
  });

  it('keeps cues sounding in long rests and the metric modulation 120 -> 90', () => {
    const bars = VS.buildBars({ meter: [4, 4], groups: [1, 1, 1, 1] }, 4, { mute: true }, uuid, IX.defaultAccents);
    const events = [
      { id: 'cue1', kind: 'cue', target: { barId: bars[3].id, offset: { n: 0, d: 1 } }, before: { unit: 'bar', count: 2 }, soundId: 'cue' },
      { id: 'mod1', kind: 'modulation', at: { barId: bars[2].id, offset: { n: 0, d: 1 } }, oldValue: { n: 1, d: 4 }, newValue: { n: 3, d: 16 } },
    ];
    const snap = snapshot(basicEnvelope(), [scoreEnvelope({ bars, tempoMap: [], events })]);
    const evs = compile(snap, R.ZERO, R.make(4, 1));
    expect(evs.filter((e) => e.layerId === 'meter').every((e) => e.emit === false)).toBe(true);
    expect(evs.filter((e) => e.kind === 'cue').map((e) => [R.toString(e.score), e.label, e.emit])).toEqual([['1', '2', true], ['2', '1', true]]);
    const map = TM.fromSnapshot(snap);
    expect(map.tempoAt(R.make(5, 2)).bpm).toBeCloseTo(90, 9);
  });

  it('draws the conductor marker on the beat point at each group head', () => {
    const points = VS.conductorTemplate('three', 3);
    expect(points).toHaveLength(3);
    const spec = { groupStarts: [R.ZERO, R.make(1, 4), R.make(1, 2)], length: R.make(3, 4) };
    const p0 = VS.conductorPosition(points, spec, 0);
    expect([p0.group, p0.x, p0.y]).toEqual([0, points[0].x, points[0].y]);
    const p1 = VS.conductorPosition(points, spec, 0.25);
    expect(p1.group).toBe(1);
    expect(p1.x).toBeCloseTo(points[1].x, 9);
    // The template is validated as part of the score.
    const bars = VS.buildBars({ meter: [3, 4], groups: [1, 1, 1] }, 1, {}, uuid, IX.defaultAccents);
    expect(SM.validatePreset(scoreEnvelope({ bars, tempoMap: [], events: [], conductor: { template: 'three', points } })).ok).toBe(true);
    expect(VS.conductorTemplate('additive', 5)).toHaveLength(5);
  });
});

describe('attack detection (phase 05, MT-16 synthetic)', () => {
  function clicks(times, sampleRate, { attackMs = 1, noise = 0.0005, seconds = 3 } = {}) {
    const out = new Float32Array(Math.round(sampleRate * seconds));
    let s = 12345;
    for (let i = 0; i < out.length; i += 1) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      out[i] = noise * ((s / 0x7fffffff) * 2 - 1);
    }
    for (const t of times) {
      const start = Math.round(t * sampleRate);
      const att = Math.max(1, Math.round(attackMs / 1000 * sampleRate));
      for (let i = 0; i < Math.round(0.12 * sampleRate) && start + i < out.length; i += 1) {
        const env = i < att ? i / att : Math.exp(-(i - att) / (0.04 * sampleRate));
        out[start + i] += 0.5 * env * Math.sin(2 * Math.PI * 440 * i / sampleRate);
      }
    }
    return out;
  }

  it('finds short attacks within a few milliseconds of the true start', () => {
    const sr = 48000;
    const truth = [0.5, 1.0, 1.5, 2.0];
    const found = OA.detect(clicks(truth, sr), sr);
    expect(found).toHaveLength(4);
    found.forEach((a, i) => {
      expect(Math.abs(a.effectiveFrame2 / 2 / sr - truth[i]) * 1000).toBeLessThan(6);
      expect(a.quality).toBe('ok');
    });
  });

  it('labels slow attacks instead of guessing a precise time', () => {
    const sr = 48000;
    const found = OA.detect(clicks([0.5], sr, { attackMs: 120, seconds: 1.5 }), sr);
    expect(found.length).toBeGreaterThanOrEqual(1);
    expect(found[0].quality).toBe('slow-attack');
  });

  it('restarts the envelope at an input gap', () => {
    const env = OA.createEnvelope(48000);
    env.push(new Float32Array(1024), 0);
    const out = env.push(new Float32Array(1024), 4096);
    expect(out[0].gap).toBe(true);
  });
});

describe('timing statistics (phase 05, MT-17)', () => {
  const beat = (i, ms = 500) => ({ timeMs: 1000 + i * ms, eventId: `e${i}`, layerId: 'meter', beatKey: `b${i % 4}`, conditionKey: 'c1', bpm: 120 });

  it('matches in order, one to one, and reports late playing as positive', () => {
    const targets = Array.from({ length: 30 }, (_, i) => beat(i));
    const attacks = targets.filter((_, i) => i !== 5).map((t) => ({ timeMs: t.timeMs + 20, quality: 'ok' }));
    attacks.push({ timeMs: 1000 + 10 * 500 + 260, quality: 'ok' }); // an extra note between beats
    attacks.sort((a, b) => a.timeMs - b.timeMs);
    const res = TA.analyze(targets, attacks, { valid: true });
    expect(res.summary.medianMs).toBe(20);
    expect(res.summary.excluded.missing).toBe(1);
    expect(res.counts.extraTotal).toBe(1);
    expect(res.counts.valid).toBe(29);
    // 20 ms at 120 BPM (500 ms beat) = +4 % of a beat.
    expect(res.details.find((d) => d.eventId === 'e0').ratio).toBe(4);
    expect(res.summary.verdict).toBe('reference'); // never pass / fail yet
    expect(res.groups.length).toBe(4);
    expect(res.groups.every((g) => g.validCount <= g.targetCount)).toBe(true);
  });

  it('holds the result without calibration or with too few beats, and never exceeds 256 groups', () => {
    const targets = Array.from({ length: 10 }, (_, i) => beat(i));
    const attacks = targets.map((t) => ({ timeMs: t.timeMs, quality: 'ok' }));
    expect(TA.analyze(targets, attacks, null).summary.hold).toBe('not-calibrated');
    expect(TA.analyze(targets, attacks, { valid: true }).summary.hold).toBe('too-few');
    // R-08: the device keeps every group; the account summary merges beat
    // positions of the same condition instead of cutting at 256.
    const many = Array.from({ length: 600 }, (_, i) => ({ ...beat(i, 200), beatKey: `k${i}` }));
    const res = TA.analyze(many, [], { valid: true });
    expect(res.groups.length).toBe(600);
    expect(res.accountGroups.length).toBe(1);
    expect(res.groupMode).toBe('merged-beats');
  });

  it('marks a beat ambiguous when two attacks are almost equally close', () => {
    const targets = [beat(0), beat(1), beat(2)];
    const attacks = [{ timeMs: 1000 }, { timeMs: 1490 }, { timeMs: 1508 }, { timeMs: 2000 }];
    const al = TA.align(targets, attacks);
    expect(al.matches[1].ambiguous).toBe(true);
    expect(al.matches[0].ambiguous).toBe(false);
  });

  it('keeps the tempo stability at 1 for an intended ramp (expected intervals follow it)', () => {
    let t = 1000;
    const targets = [];
    for (let i = 0; i < 25; i += 1) { targets.push({ ...beat(i), timeMs: t }); t += 600 - i * 10; }
    const attacks = targets.map((x) => ({ timeMs: x.timeMs + 5, quality: 'ok' }));
    const res = TA.analyze(targets, attacks, { valid: true });
    expect(res.summary.ioiRatio.median).toBeCloseTo(1, 6);
  });

  it('calibrates the round trip from known clicks', () => {
    const clicksMs = Array.from({ length: 20 }, (_, i) => 1000 + i * 600);
    const heard = clicksMs.map((c, i) => c + 85 + (i % 2 ? 1 : -1));
    const r = TA.calibrate(clicksMs, heard);
    expect(r.ok).toBe(true);
    expect(r.offsetMs).toBeCloseTo(85, 0);
    expect(TA.calibrate(clicksMs, heard.slice(0, 5)).code).toBe('too-few-clicks');
    expect(TA.calibrate(clicksMs, []).code).toBe('no-clicks-heard');
  });

  it('refuses analysis targets above 16 per second before starting (clicks may still play)', () => {
    const at = (bpmTenths, unit) => snapshot(basicEnvelope({ tempo: { bpmTenths, reference: { n: 1, d: 4 } }, pulse: unit, accent: { group: [1, 0.7, 0.7, 0.7], pulse: Array.from({ length: unit.d }, () => 0.7), subdivision: 0.35 } }));
    // 120 BPM quarter reference, 32nd pulse: 16 per second (allowed).
    expect(TA.targetRate(at(1200, { n: 1, d: 32 }), ['meter']).ok).toBe(true);
    // 300 BPM, 32nd pulse: 40 per second (refused for analysis).
    const r = TA.targetRate(at(3000, { n: 1, d: 32 }), ['meter']);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('ANALYSIS_TARGET_RATE_EXCEEDED');
    expect(TA.targetRate(at(1200, { n: 1, d: 4 }), ['meter', 'a', 'b']).code).toBe('too-many-layers');
  });

  it('maps input frames by the smallest observed arrival delay', () => {
    const m = TA.createClockMapper(48000);
    m.observe(48000, 1030);
    m.observe(96000, 2012);
    m.observe(144000, 3050);
    expect(m.toPerformance(48000)).toBeCloseTo(1012, 9);
  });
});
