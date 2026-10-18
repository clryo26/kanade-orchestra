import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

// Regression tests for the review findings R-01 / R-04 / R-08 (pure logic).
// Storage (R-05 / R-06), capture (R-07) and the 30-minute record (R-09) are
// in test_metronome_review_storage.test.js.
const require = createRequire(import.meta.url);
const dir = path.join(process.cwd(), 'src/static/js/modules/metronome');
const R = require(path.join(dir, 'rational.js'));
const SM = require(path.join(dir, 'score_model.js'));
require(path.join(dir, 'tempo_map.js'));
require(path.join(dir, 'event_compiler.js'));
const TA = require(path.join(dir, 'timing_analysis.js'));

const BASIC = '00000000-0000-4000-8000-00000000b001';
let seq = 100;
const uuid = () => { seq += 1; return `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`; };

function snapshotOf(basicPayload, extra) {
  const p = SM.defaultBasicPreset(BASIC);
  p.payload = Object.assign({}, p.payload, basicPayload);
  const vb = SM.validatePreset(p);
  if (!vb.ok) throw new Error(JSON.stringify(vb.errors));
  const store = { [BASIC]: { 1: vb.preset } };
  let top = BASIC;
  for (const env of extra || []) {
    const v = SM.validatePreset(env);
    if (!v.ok) throw new Error(JSON.stringify(v.errors));
    store[env.id] = { 1: v.preset };
    top = env.id;
  }
  return SM.buildSnapshot(store, top, 1);
}

// Small deterministic random generator for the comparison runs.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

describe('R-01 bounded order-preserving alignment', () => {
  it('matches the exact dynamic-programme reference on random small inputs', () => {
    for (let run = 0; run < 60; run += 1) {
      const r = rng(run + 1);
      const targets = [];
      let t = 1000;
      for (let i = 0; i < 40; i += 1) { t += 120 + r() * 600; targets.push({ timeMs: t, layerId: 'meter' }); }
      const attacks = [];
      targets.forEach((x) => {
        if (r() < 0.8) attacks.push({ timeMs: x.timeMs + (r() - 0.5) * 120 });
        if (r() < 0.3) attacks.push({ timeMs: x.timeMs + (r() - 0.5) * 900 });
      });
      attacks.sort((a, b) => a.timeMs - b.timeMs);
      const fast = TA.align(targets, attacks).matches.map((m) => m.obs);
      const exact = TA.alignExact(targets, attacks).map((m) => m.obs);
      expect(fast).toEqual(exact);
    }
  });

  it('handles the full record (28800 beats) with many extra attacks in linear time and bounded memory', () => {
    const al = TA.createAligner();
    let maxPending = 0;
    const t0 = Date.now();
    let attacks = 0;
    for (let i = 0; i < 28800; i += 1) {
      const t = 1000 + i * 62.5; // 16 beats per second
      al.addTarget({ timeMs: t, layerId: 'meter', beatKey: `b${i % 4}`, conditionKey: 'c', bpm: 240 });
      al.addAttack({ timeMs: t + 3, quality: 'ok' });
      for (let k = 0; k < 3; k += 1) { al.addAttack({ timeMs: t + 20 + k * 7, quality: 'ok' }); attacks += 1; } // noise: 3 extras per beat
      if (i % 16 === 0) {
        al.advance(t - 400);
        const p = al.pendingSizes();
        maxPending = Math.max(maxPending, p.targets + p.attacks);
      }
    }
    const res = TA.summarize(al.finish(), { valid: true });
    const ms = Date.now() - t0;
    expect(res.counts.target).toBe(28800);
    expect(res.counts.extraDetail).toBe(7200); // details capped
    expect(res.counts.extraTotal).toBe(attacks); // but every extra is counted
    expect(res.summary.extraDetailsTruncated).toBe(true);
    expect(res.summary.extraTruncatedAtMs).not.toBeNull();
    expect(maxPending).toBeLessThan(200);
    expect(ms).toBeLessThan(3000);
  });

  it('a flood of attacks keeps the pending queue bounded (counted as "flood")', () => {
    const al = TA.createAligner();
    al.addTarget({ timeMs: 100000, layerId: 'meter', beatKey: 'b0', conditionKey: 'c', bpm: 60 });
    for (let i = 0; i < 10000; i += 1) al.addAttack({ timeMs: 1000 + i * 0.5, quality: 'ok' });
    expect(al.pendingSizes().attacks).toBeLessThanOrEqual(TA.LIMITS.maxPendingAttacks);
    const r = al.finish();
    expect(r.extraByQuality.flood).toBeGreaterThan(0);
  });

  it('refuses beats after the 28800 limit (the record is closed, nothing silently grows)', () => {
    const al = TA.createAligner({ maxTargets: 3 });
    for (let i = 0; i < 5; i += 1) al.addTarget({ timeMs: i * 1000, layerId: 'meter' });
    expect(al.full()).toBe(true);
    expect(al.finish().refusedTargets).toBe(2);
  });
});

describe('R-04 target rate from the compiled expected events', () => {
  it('quarter reference 300 BPM with 32nd subdivision is 40 beats per second and refused', () => {
    const snap = snapshotOf({ tempo: { bpmTenths: 3000, reference: { n: 1, d: 4 } }, subdivision: { unit: { n: 1, d: 32 } } });
    const r = TA.targetRate(snap, ['meter']);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('ANALYSIS_TARGET_RATE_EXCEEDED');
    expect(r.rate).toBeGreaterThan(16);
    // The same tempo without subdivision: 5 per second, allowed.
    expect(TA.targetRate(snapshotOf({ tempo: { bpmTenths: 3000, reference: { n: 1, d: 4 } } }), ['meter'])).toMatchObject({ ok: true, rate: 5 });
  });

  it('120 BPM with 32nd subdivision is exactly 16 per second (allowed); two layers add up', () => {
    const snap = snapshotOf({ subdivision: { unit: { n: 1, d: 32 } } });
    expect(TA.targetRate(snap, ['meter'])).toMatchObject({ ok: true, rate: 16 });
    const adv = { schemaVersion: 1, id: '00000000-0000-4000-8000-00000000a001', revision: 1, kind: 'advanced', title: 'x', payload: { basePresetId: BASIC, baseRevision: 1, layers: [{ id: 'layer1', cycle: { n: 1, d: 1 }, pulses: 3, phase: { n: 0, d: 1 }, soundId: 'wood', volume: 1 }] } };
    const two = snapshotOf({ subdivision: { unit: { n: 1, d: 16 } } }, [adv]);
    // 8 sixteenths/s of the meter layer + 1.5/s of the 3-beat layer (one coincides each bar).
    const r = TA.targetRate(two, ['meter', 'layer1']);
    expect(r.ok).toBe(true);
    expect(r.rate).toBeGreaterThanOrEqual(9);
  });

  it('swing and custom rhythms count as played; a dense spot inside an accelerando is found', () => {
    // Accelerando 60 -> 300 BPM over 8 bars, quarter pulse with 16th subdivision:
    // the average is low but the last bars reach 20 per second.
    const bars = Array.from({ length: 8 }, () => ({ id: uuid(), meter: { numerator: 4, denominator: 4 }, groups: [1, 1, 1, 1], pulse: { n: 1, d: 4 }, accent: { group: [1, 0.7, 0.7, 0.7], pulse: [1, 0.7, 0.7, 0.7], subdivision: 0.3 }, soundId: 'click', mute: false, subdivision: { unit: { n: 1, d: 16 } } }));
    const score = { schemaVersion: 1, id: '00000000-0000-4000-8000-00000000c001', revision: 1, kind: 'score', title: 's', payload: { basePresetId: BASIC, baseRevision: 1, bars, tempoMap: [{ start: { barId: bars[0].id, offset: { n: 0, d: 1 } }, end: { barId: bars[7].id, offset: { n: 1, d: 1 } }, reference: { n: 1, d: 4 }, startBpmTenths: 600, endBpmTenths: 3000, curve: 'linear', domain: 'seconds' }], events: [] } };
    const r = TA.targetRate(snapshotOf({ tempo: { bpmTenths: 600, reference: { n: 1, d: 4 } } }, [score]), ['meter']);
    expect(r.ok).toBe(false);
    expect(r.at).toBeGreaterThan(5); // late in the ramp, not at the start
    // A custom rhythm with rests: only the sounding expected positions count.
    const adv = { schemaVersion: 1, id: '00000000-0000-4000-8000-00000000a001', revision: 1, kind: 'advanced', title: 'x', payload: { basePresetId: BASIC, baseRevision: 1, layers: [{ id: 'l1', cycle: { n: 1, d: 2 }, pulses: 4, phase: { n: 0, d: 1 }, soundId: 'wood', volume: 1, rhythm: [0, 1, 2, 3].map((i) => ({ offset: R.make(i, 8), duration: { n: 1, d: 8 }, rest: i % 2 === 1, velocity: 1, accentLevel: 'pulse', timingMode: 'generated' })).map((x) => ({ ...x, offset: { n: x.offset.n, d: x.offset.d } })) }] } };
    expect(TA.targetRate(snapshotOf({}, [adv]), ['l1'])).toMatchObject({ ok: true, rate: 2 }); // 1-second cycle, 2 of 4 items are rests
  });

  it('isTargetEvent is the single rule (cues and count-in are never targets)', () => {
    expect(TA.isTargetEvent({ expected: true, kind: 'meter', layerId: 'meter' }, ['meter'])).toBe(true);
    expect(TA.isTargetEvent({ expected: true, kind: 'countIn', layerId: 'meter' }, ['meter'])).toBe(false);
    expect(TA.isTargetEvent({ expected: false, kind: 'cue', layerId: 'cue' }, ['cue'])).toBe(false);
    expect(TA.isTargetEvent({ expected: true, kind: 'layer', layerId: 'l2' }, ['meter'])).toBe(false);
  });
});

describe('R-08 conditions and groups', () => {
  const spec = { meter: { numerator: 4, denominator: 4 }, groups: [1, 1, 1, 1], pulse: { n: 1, d: 4 }, subdivision: null };

  it('an intended accelerando is one condition; a revision change marks only the next beat of each layer', () => {
    const tr = TA.createConditionTracker({ route: 'speaker', calibrationId: 'c1', analyzerVersion: 'v', outputKind: 'worklet', sampleRate: 48000 });
    const keys = [];
    const excluded = [];
    for (let i = 0; i < 6; i += 1) {
      const c = tr.target({ revision: 3, generation: 1, layerId: 'meter' }, { spec });
      keys.push(c.conditionKey);
      excluded.push(c.excluded);
    }
    expect(new Set(keys).size).toBe(1); // tempo changes inside the curve do not split
    expect(excluded.every((x) => !x)).toBe(true);
    // Two layers: an edit marks the first beat of each layer, independently.
    expect(tr.target({ revision: 3, generation: 1, layerId: 'l1' }, { spec }).excluded).toBe(false);
    expect(tr.target({ revision: 4, generation: 1, layerId: 'meter' }, { spec }).excluded).toBe(true);
    expect(tr.target({ revision: 4, generation: 1, layerId: 'meter' }, { spec }).excluded).toBe(false);
    expect(tr.target({ revision: 4, generation: 1, layerId: 'l1' }, { spec }).excluded).toBe(true);
    // A new run (pause / resume) is a boundary too.
    expect(tr.target({ revision: 4, generation: 2, layerId: 'meter' }, { spec }).excluded).toBe(true);
  });

  it('the condition includes the bar structure, subdivision, calibration, route and analyzer version', () => {
    const a = TA.createConditionTracker({ route: 'speaker', calibrationId: 'c1', analyzerVersion: 'v1' }).target({ revision: 1, generation: 1, layerId: 'meter' }, { spec }).conditionKey;
    const b = TA.createConditionTracker({ route: 'wired', calibrationId: 'c1', analyzerVersion: 'v1' }).target({ revision: 1, generation: 1, layerId: 'meter' }, { spec }).conditionKey;
    const c = TA.createConditionTracker({ route: 'speaker', calibrationId: 'c1', analyzerVersion: 'v1' }).target({ revision: 1, generation: 1, layerId: 'meter' }, { spec: { ...spec, groups: [2, 2] } }).conditionKey;
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('257 beat groups are merged by beat position for the account, totals stay equal; 257 conditions are held', () => {
    const rows = [];
    for (let i = 0; i < 257; i += 1) rows.push({ kind: 'target', conditionKey: 'c', layerId: 'meter', beatKey: `b${i}`, e: i % 2 ? 1 : null, reason: i % 2 ? null : 'missing' });
    const g = TA.buildGroups(rows, { calibrated: true });
    expect(g.local).toHaveLength(257);
    expect(g.account).toHaveLength(1);
    expect(g.account[0].targetCount).toBe(257);
    expect(g.account[0].validCount).toBe(128);
    const sum = (list, f) => list.reduce((s, x) => s + x[f], 0);
    expect(sum(g.local, 'targetCount')).toBe(sum(g.account, 'targetCount'));
    const conditions = Array.from({ length: 257 }, (_, i) => ({ kind: 'target', conditionKey: `c${i}`, layerId: 'meter', beatKey: 'b0', e: 1, reason: null }));
    const held = TA.buildGroups(conditions, { calibrated: true });
    expect(held.account).toBeNull();
    expect(held.accountHold).toBe('too-many-conditions');
    expect(held.local).toHaveLength(257); // nothing cut on the device
  });

  it('screen, device record and account summary agree on target / valid counts (two layers, coincident beats)', () => {
    const targets = [];
    for (let i = 0; i < 40; i += 1) {
      targets.push({ timeMs: 1000 + i * 500, layerId: 'meter', beatKey: `b${i % 4}`, conditionKey: 'c', bpm: 120 });
      if (i % 2 === 0) targets.push({ timeMs: 1000 + i * 500 + 2, layerId: 'l1', beatKey: 'x', conditionKey: 'c', bpm: 120 }); // coincident
    }
    targets.sort((a, b) => a.timeMs - b.timeMs);
    const attacks = targets.filter((t) => t.layerId === 'meter').map((t) => ({ timeMs: t.timeMs + 10, quality: 'ok' }));
    const res = TA.analyze(targets, attacks, { valid: true });
    expect(res.counts.target).toBe(40); // compound beats: one attack is never used twice
    const sum = (list, f) => list.reduce((s, x) => s + x[f], 0);
    expect(sum(res.groups, 'targetCount')).toBe(res.counts.target);
    expect(sum(res.accountGroups, 'validCount')).toBe(res.counts.valid);
    expect(res.groups.some((g) => g.layerKey === 'l1+meter')).toBe(true);
  });
});

describe('B / C presets and conductor editing (pure helpers)', () => {
  const VS = require(path.join(dir, 'view_score.js'));
  const VAP = require(path.join(dir, 'view_account_presets.js'));
  const bar = (groups) => ({ groups });

  it('conductor points are checked against the beat groups and kept inside 0..1', () => {
    const pts = VS.conductorTemplate('three', 3);
    expect(VS.checkConductor({ template: 'three', points: pts }, [bar([1, 1, 1])])).toEqual({ ok: true });
    expect(VS.checkConductor({ template: 'three', points: pts }, [bar([1, 1, 1]), bar([2, 2, 3, 1])]).code).toBe('point-count');
    const moved = VS.movePoint(pts, 1, 0.9, -0.9);
    expect(moved[1].x).toBe(1);
    expect(moved[1].y).toBe(0);
    expect(pts[1].x).not.toBe(1); // the original stays unchanged
    const bad = pts.map((p) => ({ ...p }));
    bad[0].x = 1.5;
    expect(VS.checkConductor({ template: 'three', points: bad }, [bar([1, 1, 1])]).code).toBe('point-out-of-range');
  });

  it('a stored score is restored with its whole chain; a missing base is refused', () => {
    const items = [
      { id: 'b', revision: 1, envelope: { id: 'b', revision: 1, kind: 'basic', payload: {} } },
      { id: 'a', revision: 1, envelope: { id: 'a', revision: 1, kind: 'advanced', payload: { basePresetId: 'b', baseRevision: 1 } } },
      { id: 's', revision: 1, envelope: { id: 's', revision: 1, kind: 'score', payload: { basePresetId: 'a', baseRevision: 1 } } },
    ];
    expect(VS.chainOf(items, items[2]).map((e) => e.kind)).toEqual(['basic', 'advanced', 'score']);
    expect(VS.chainOf(items.slice(1), items[2])).toBeNull();
  });

  it('account presets are grouped into chains; tops only, missing bases marked', () => {
    const items = [
      { id: 'b', revision: 1, kind: 'basic', preset: { schemaVersion: 1, id: 'b', revision: 1, kind: 'basic', payload: {} } },
      { id: 's', revision: 1, kind: 'score', preset: { schemaVersion: 1, id: 's', revision: 1, kind: 'score', payload: { basePresetId: 'b', baseRevision: 1 } } },
      { id: 'x', revision: 1, kind: 'score', preset: { schemaVersion: 1, id: 'x', revision: 1, kind: 'score', payload: { basePresetId: 'gone', baseRevision: 1 } } },
    ];
    const c = VAP.chains(items);
    expect(c.map((g) => g.top.id).sort()).toEqual(['s', 'x']);
    expect(c.find((g) => g.top.id === 's').list.map((e) => e.kind)).toEqual(['basic', 'score']);
    expect(c.find((g) => g.top.id === 'x').missing).toBe(true);
    expect(VAP.errorText({ ok: false, code: 'network' })).toMatch(/オフライン/);
    expect(VAP.errorText({ ok: false, code: 'conflict', detail: 'PRESET_IN_USE' })).toMatch(/参照/);
  });
});
