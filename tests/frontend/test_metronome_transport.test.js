import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

// MT-06 / MT-08 / MT-09 (logic level): transport states, fences and
// generations with a fake backend and a fake clock.
const require = createRequire(import.meta.url);
const dir = path.join(process.cwd(), 'src/static/js/modules/metronome');
const R = require(path.join(dir, 'rational.js'));
const SM = require(path.join(dir, 'score_model.js'));
const TP = require(path.join(dir, 'transport.js'));

const SR = 48000;
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function snap(payload = {}, extra = []) {
  const p = SM.defaultBasicPreset(uuid(1));
  p.payload = Object.assign({}, p.payload, payload);
  const store = { [p.id]: { 1: SM.validatePreset(p).preset } };
  let top = p;
  extra.forEach((e) => {
    const v = SM.validatePreset(e);
    if (!v.ok) throw new Error(JSON.stringify(v.errors));
    store[e.id] = { [e.revision]: v.preset };
    top = e;
  });
  return SM.buildSnapshot(store, top.id, top.revision);
}

function harness(kind = 'main') {
  const clock = { frame: 0 };
  const timers = [];
  const log = [];
  let generation = 0;
  const scheduled = [];
  const backend = {
    kind,
    setGeneration(g) { generation = g; },
    schedule(events, g) { if (g !== generation) return 0; events.forEach((e) => scheduled.push({ ...e, g })); log.push(['schedule', events.length, g]); return events.length; },
    replaceFrom(frame, events, g) {
      if (g !== generation) return Promise.resolve({ stale: true });
      for (let i = scheduled.length - 1; i >= 0; i -= 1) if (scheduled[i].frame >= frame) scheduled.splice(i, 1);
      events.forEach((e) => scheduled.push({ ...e, g }));
      log.push(['replace', frame]);
      return Promise.resolve({ accepted: true, appliedFrame: Math.max(frame, clock.frame), late: frame < clock.frame });
    },
    cancelFrom(frame, g) {
      if (g !== generation) return Promise.resolve({ stale: true });
      for (let i = scheduled.length - 1; i >= 0; i -= 1) if (scheduled[i].frame >= frame) scheduled.splice(i, 1);
      log.push(['cancel', frame]);
      return Promise.resolve({});
    },
    stop(g) { generation = g; scheduled.length = 0; log.push(['stop', g]); return Promise.resolve({}); },
    renewPermit(until) { log.push(['permit', until]); },
    currentFrame() { return clock.frame; },
  };
  const states = [];
  const tp = TP.createTransport({
    backend, sampleRate: SR,
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
    onState: (s) => states.push(s),
  });
  const advance = (seconds) => {
    const steps = Math.round(seconds / 0.025);
    for (let i = 0; i < steps; i += 1) {
      clock.frame += Math.round(SR * 0.025);
      const due = timers.splice(0);
      due.forEach((fn) => fn());
    }
  };
  return { tp, clock, scheduled, log, states, advance };
}

describe('transport', () => {
  it('starts after the start delay, fills only the look-ahead horizon and keeps exact frames', () => {
    const h = harness('main');
    h.tp.load(snap());
    const r = h.tp.start({ countInBars: 0 });
    expect(r.originFrame).toBe(Math.round(SR * 0.1));
    expect(h.scheduled.every((e) => e.frame <= h.clock.frame + SR * 0.3 + SR * 0.5)).toBe(true);
    h.advance(2);
    const frames = h.scheduled.filter((e) => e.layerId === 'meter').map((e) => e.frame);
    frames.forEach((f, i) => expect(f).toBe(r.originFrame + i * 24000));
    expect(Math.max(...frames)).toBeLessThanOrEqual(h.clock.frame + SR * 0.3 + 24000);
  });

  it('count-in precedes the origin and is not an expected beat', () => {
    const h = harness();
    h.tp.load(snap());
    const r = h.tp.start({ countInBars: 1 });
    const ci = h.scheduled.filter((e) => e.kind === 'countIn');
    expect(ci).toHaveLength(4);
    expect(ci[3].frame).toBe(r.originFrame - 24000);
    expect(ci.every((e) => !e.expected)).toBe(true);
  });

  it('a BPM change at the next pulse keeps the beat continuous (fence) and never moves earlier events', async () => {
    const h = harness();
    h.tp.load(snap());
    const r = h.tp.start({ countInBars: 0 });
    h.advance(0.6);
    const before = h.scheduled.filter((e) => e.frame < h.clock.frame + SR * 0.03).map((e) => e.frame);
    const fence = await h.tp.edit(snap({ tempo: { bpmTenths: 600, reference: { n: 1, d: 4 } } }), 2, 'nextPulse');
    expect((fence.fenceFrame - r.originFrame) % 24000).toBe(0); // on the old pulse grid
    // Every old beat before the fence is scheduled once (none lost, none doubled).
    const old = h.scheduled.filter((e) => e.frame < fence.fenceFrame && e.layerId === 'meter').map((e) => e.frame);
    expect(old).toEqual(old.map((_, i) => r.originFrame + i * 24000));
    expect(old[old.length - 1]).toBe(fence.fenceFrame - 24000);
    // Events already scheduled before the edit are unchanged.
    expect(h.scheduled.filter((e) => before.includes(e.frame)).map((e) => e.frame)).toEqual(before);
    h.advance(3);
    const after = h.scheduled.filter((e) => e.frame >= fence.fenceFrame).map((e) => e.frame).sort((a, b) => a - b);
    expect(after[0]).toBe(fence.fenceFrame);
    expect(after[1] - after[0]).toBe(48000); // 60 BPM from the fence on
  });

  it('a meter change at the next bar starts a new bar occurrence there', async () => {
    const h = harness();
    h.tp.load(snap());
    const r = h.tp.start({ countInBars: 0 });
    h.advance(0.3);
    const three = snap({ meter: { numerator: 3, denominator: 4 }, groups: [1, 1, 1], accent: { group: [1, 0.7, 0.7], pulse: [1, 0.7, 0.7], subdivision: 0.3 } });
    const fence = await h.tp.edit(three, 2, 'nextBar');
    expect(fence.fenceFrame).toBe(r.originFrame + 96000);
    h.advance(4);
    const bars = h.scheduled.filter((e) => e.frame >= fence.fenceFrame && e.accentLevel === 'group' && R.isZero(e.offset)).map((e) => e.frame);
    expect(bars[0]).toBe(fence.fenceFrame);
    expect(bars[1] - bars[0]).toBe(72000); // 3/4 bars from the fence
    const oldBeats = h.scheduled.filter((e) => e.frame < fence.fenceFrame && e.layerId === 'meter');
    expect(oldBeats).toHaveLength(4); // the whole first 4/4 bar
  });

  it('pause cancels from the next safe grid point; resume continues from there after a new origin', async () => {
    const h = harness();
    h.tp.load(snap());
    const r = h.tp.start({ countInBars: 0 });
    h.advance(0.62);
    const p = await h.tp.pause();
    expect(h.tp.getState()).toBe('paused');
    expect(h.scheduled.every((e) => e.frame < p.frame)).toBe(true);
    expect((p.frame - r.originFrame) % 24000).toBe(0);
    h.advance(5); // paused time is not added to the score
    const r2 = h.tp.resume({ countInBars: 0 });
    expect(R.eq(h.tp.getSegment().originScore, p.score)).toBe(true);
    expect(r2.originFrame).toBe(h.clock.frame + Math.round(SR * 0.1));
  });

  it('stop invalidates the generation: an old backend reply cannot act, position returns to 0', async () => {
    const h = harness();
    h.tp.load(snap());
    h.tp.start({ countInBars: 0 });
    const g = h.tp.getGeneration();
    h.advance(0.5);
    h.tp.stop();
    expect(h.tp.getGeneration()).toBe(g + 1);
    expect(h.scheduled).toHaveLength(0);
    expect(h.tp.getState()).toBe('stopped');
    expect(R.isZero(h.tp.getPosition())).toBe(true);
    h.advance(1);
    expect(h.scheduled).toHaveLength(0); // no timer of the old run schedules anything
  });

  it('seek stops at the target; playing again starts there', () => {
    const h = harness();
    h.tp.load(snap());
    h.tp.start({ countInBars: 0 });
    h.advance(0.4);
    h.tp.seek(R.make(2, 1));
    expect(h.tp.getState()).toBe('stopped');
    h.tp.start({ countInBars: 0 });
    expect(R.eq(h.tp.getSegment().originScore, R.make(2, 1))).toBe(true);
  });

  it('fermata: waits after its own event, resumes from the next event without repeating it', () => {
    const bars = [uuid(41), uuid(42)].map((id) => ({ id, meter: { numerator: 4, denominator: 4 }, groups: [1, 1, 1, 1], pulse: { n: 1, d: 4 }, accent: { group: [1, 0.7, 0.7, 0.7], pulse: [1, 0.7, 0.7, 0.7], subdivision: 0.3 }, soundId: 'click', mute: false }));
    const score = { schemaVersion: 1, id: uuid(9), revision: 1, kind: 'score', title: 'f', payload: { basePresetId: uuid(1), baseRevision: 1, bars, tempoMap: [], events: [{ id: 'f1', kind: 'fermata', at: { barId: bars[0].id, offset: { n: 1, d: 2 } }, resumeCountInPulses: 0 }] } };
    const h = harness();
    h.tp.load(snap({}, [score]));
    h.tp.start({ countInBars: 0 });
    h.advance(2);
    expect(h.tp.getState()).toBe('waiting');
    const heldEvents = h.scheduled.filter((e) => e.layerId === 'meter').map((e) => R.toString(e.score));
    expect(heldEvents).toEqual(['0', '1/4', '1/2']);
    h.advance(3);
    expect(h.scheduled.filter((e) => e.layerId === 'meter')).toHaveLength(3); // nothing after the fermata
    const r = h.tp.resumeFermata(0);
    h.advance(1);
    const next = h.scheduled.filter((e) => e.layerId === 'meter').map((e) => R.toString(e.score));
    expect(next[0]).toBe('3/4'); // the held 1/2 is not played again
    expect(h.scheduled[0].frame).toBe(r.originFrame);
  });

  it('the end of a finite score stops the transport after the tail', () => {
    const bars = [uuid(51)].map((id) => ({ id, meter: { numerator: 2, denominator: 4 }, groups: [1, 1], pulse: { n: 1, d: 4 }, accent: { group: [1, 0.7], pulse: [1, 0.7], subdivision: 0.3 }, soundId: 'click', mute: false }));
    const score = { schemaVersion: 1, id: uuid(10), revision: 1, kind: 'score', title: 'e', payload: { basePresetId: uuid(1), baseRevision: 1, bars, tempoMap: [], events: [] } };
    const h = harness();
    h.tp.load(snap({}, [score]));
    h.tp.start({ countInBars: 0 });
    h.advance(3);
    expect(h.tp.getState()).toBe('stopped');
    expect(h.tp.getReason()).toBe('ended');
  });

  it('edits that change the structure of a running score are refused (stop first)', async () => {
    const bars = [uuid(61)].map((id) => ({ id, meter: { numerator: 4, denominator: 4 }, groups: [1, 1, 1, 1], pulse: { n: 1, d: 4 }, accent: { group: [1, 0.7, 0.7, 0.7], pulse: [1, 0.7, 0.7, 0.7], subdivision: 0.3 }, soundId: 'click', mute: false }));
    const score = { schemaVersion: 1, id: uuid(11), revision: 1, kind: 'score', title: 's', payload: { basePresetId: uuid(1), baseRevision: 1, bars, tempoMap: [], events: [] } };
    const h = harness();
    h.tp.load(snap({}, [score]));
    h.tp.start({ countInBars: 0 });
    h.advance(0.2);
    await expect(h.tp.edit(snap(), 2, 'nextBar')).rejects.toThrow('stop-required');
  });
});
