import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const pipeline = require('./helpers/tuner_pipeline.cjs');
const dir = path.join(process.cwd(), 'src/static/js/modules/tuner');
const read = (name) => fs.readFileSync(path.join(dir, name), 'utf8');
for (const name of ['music', 'temperament', 'target_model', 'onset', 'note_events', 'analysis_stats', 'intonation_profile', 'workspace']) {
  require(path.join(dir, `${name}.js`));
}
const L = globalThis.PortalTunerLib;

function loadStatsWorker({ failImport = false } = {}) {
  const posted = [];
  const timers = [];
  const context = vm.createContext({
    Float32Array, Float64Array, Uint32Array, Uint8Array, Uint16Array, ArrayBuffer, Math, Number, Object, Array, Error, Promise, Infinity, NaN, JSON, String,
    location: { search: `?rev=${pipeline.RELEASE}` },
    postMessage: (m) => posted.push(m),
    close: () => { context.closed = true; },
    setTimeout: (fn) => timers.push(fn),
  });
  context.self = context;
  context.importScripts = (...urls) => {
    if (failImport) throw new Error('network');
    for (const url of urls) vm.runInContext(read(url.split('?')[0]), context);
  };
  vm.runInContext(read('stats.worker.js'), context);
  const send = (data) => context.self.onmessage({ data });
  const flush = () => { while (timers.length) timers.shift()(); };
  return { posted, send, flush, context };
}

function measuredSnapshot() {
  const sr = 48000;
  const a = pipeline.synth({ sampleRate: sr, seconds: 1.2, f0: () => 440 * 2 ** (6 / 1200), seed: 3 });
  const gap = new Float32Array(Math.round(0.3 * sr));
  const b = pipeline.synth({ sampleRate: sr, seconds: 1.2, f0: () => 493.88, seed: 4 });
  const samples = new Float32Array(a.length + gap.length + b.length);
  samples.set(a, 0);
  samples.set(b, a.length + gap.length);
  const { snap } = pipeline.collect(pipeline.runWorker(samples), sr);
  snap.series.expectedHop2 = (2 * sr) / 30;
  // A playback interval over the second note (simultaneous mode).
  const start2 = 2 * (a.length + gap.length);
  snap.intervals = [{ kind: 'output', startFrame2: start2, endFrame2: start2 + 2 * b.length }];
  return snap;
}

describe('statistics worker', () => {
  it('answers hello with ready only for the same release and protocol', () => {
    const w = loadStatsWorker();
    w.send({ type: 'hello', release: pipeline.RELEASE, protocol: 2 });
    expect(w.posted.at(-1)).toMatchObject({ type: 'ready', release: pipeline.RELEASE });
    w.send({ type: 'hello', release: 'other', protocol: 2 });
    expect(w.posted.at(-1).type).toBe('version-mismatch');
    w.send({ type: 'hello', release: pipeline.RELEASE, protocol: 1 });
    expect(w.posted.at(-1).type).toBe('version-mismatch');
    const broken = loadStatsWorker({ failImport: true });
    broken.send({ type: 'hello', release: pipeline.RELEASE, protocol: 2 });
    expect(broken.posted.at(-1).type).toBe('load-failed');
  });

  it('collapses a burst of requests of one kind to the latest', () => {
    const w = loadStatsWorker();
    for (let id = 1; id <= 5; id += 1) w.send({ type: 'analyze', kind: 'diagnose', requestId: id, revision: id, events: [], conditionKey: 'k' });
    w.send({ type: 'analyze', kind: 'unknown', requestId: 9 });
    w.flush();
    expect(w.posted.map((m) => [m.type, m.requestId])).toEqual([['result', 5]]);
    w.send({ type: 'analyze', kind: 'diagnose', requestId: 6, events: [], conditionKey: 'k' });
    w.send({ type: 'stop' });
    w.flush();
    expect(w.posted).toHaveLength(1); // stopped: the pending request is dropped
    expect(w.context.closed).toBe(true);
  });

  it('segment results equal the synchronous fallback and exclude the playback interval', async () => {
    const snap = measuredSnapshot();
    const request = { snapshot: snap, segmentOptions: { thresholdDbfs: -50, a4Hz: 440 }, targetConfig: { temperament: 'equal', a4Tenths: 4400 }, toleranceCents: 5 };
    const w = loadStatsWorker();
    w.send(Object.assign({ type: 'analyze', kind: 'segment', requestId: 1 }, request));
    w.flush();
    const fromWorker = w.posted[0].result;
    const fallback = await L.workspace.createStatsClient({ release: 'x' }).request('segment', request);
    expect(JSON.parse(JSON.stringify(fromWorker))).toEqual(JSON.parse(JSON.stringify(fallback)));
    expect(fromWorker.events.length).toBe(2);
    const [first, second] = fromWorker.events;
    expect(first.target.label).toBe('A4');
    expect(first.stats.medianCents).toBeGreaterThan(4);
    expect(first.stats.medianCents).toBeLessThan(8);
    // Second note lies in the output interval: no valid time, excluded as playback.
    expect(second.stats.validSeconds).toBe(0);
    expect(second.stats.medianCents).toBeNull();
    expect(Object.keys(second.stats.excludedByReason)).toContain('playback');
  });

  it('eventStats in the fallback also excludes playback (same rule as the worker)', async () => {
    const snap = measuredSnapshot();
    const n = snap.series.frame2.length;
    const items = [{ i0: 0, i1: n - 1, startFrame2: snap.series.frame2[0], endFrame2: snap.series.frame2[n - 1], targetHz: 440, toleranceCents: 5 }];
    const w = loadStatsWorker();
    w.send({ type: 'analyze', kind: 'eventStats', requestId: 1, snapshot: snap, items });
    w.flush();
    const fallback = await L.workspace.createStatsClient({ release: 'x' }).request('eventStats', { snapshot: snap, items });
    expect(JSON.parse(JSON.stringify(w.posted[0].result))).toEqual(JSON.parse(JSON.stringify(fallback)));
    expect(fallback.stats[0].excludedByReason.playback).toBeGreaterThan(0);
  });
});
