// Test helper: synthetic audio -> the real analysis Worker (run in a VM with
// a stubbed `self`) -> measurement store -> note events -> statistics.
// Only synthetic signals are generated here; nothing is recorded or saved.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = process.cwd();
const tunerDir = path.join(root, 'src/static/js/modules/tuner');
const read = (name) => fs.readFileSync(path.join(tunerDir, name), 'utf8');
const RELEASE = read('capture.worklet.js').match(/TUNER_RELEASE_ID = '([^']+)'/)[1];
const PROTOCOL = Number(read('capture.worklet.js').match(/TUNER_PROTOCOL = (\d+)/)[1]);

const lib = {
  music: require(path.join(tunerDir, 'music.js')),
  onset: require(path.join(tunerDir, 'onset.js')),
  noteEvents: require(path.join(tunerDir, 'note_events.js')),
  analysisStats: require(path.join(tunerDir, 'analysis_stats.js')),
  measurementStore: require(path.join(tunerDir, 'measurement_store.js')),
};

// Deterministic PRNG (mulberry32).
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gaussian(rand) {
  const u = Math.max(1e-12, rand());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

// Signal from instantaneous frequency f0(t) (Hz, 0 = silence) and envelope env(t).
function synth({ sampleRate = 48000, seconds, f0, env = () => 1, amps = [1, 0.5, 0.33, 0.25, 0.2], peak = 0.3, noiseDbfs = -75, seed = 1 }) {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  const rand = rng(seed);
  const noise = 10 ** (noiseDbfs / 20);
  let phase = 0;
  for (let i = 0; i < n; i += 1) {
    const t = i / sampleRate;
    const f = f0(t);
    let s = 0;
    if (f > 0) {
      for (let h = 0; h < amps.length; h += 1) {
        if (f * (h + 1) < sampleRate / 2) s += amps[h] * Math.sin(2 * Math.PI * (h + 1) * phase);
      }
      phase += f / sampleRate;
    }
    out[i] = peak * 0.5 * s * env(t) + noise * gaussian(rand);
  }
  return out;
}

function loadWorker() {
  const posted = [];
  const context = vm.createContext({
    Float32Array, Float64Array, Uint32Array, Uint8Array, ArrayBuffer, Math, Number, Object, Array, Error, Promise, Infinity, NaN,
    location: { search: `?rev=${RELEASE}` },
    postMessage: (message) => posted.push(message),
    close: () => {},
  });
  context.self = context;
  context.importScripts = (...urls) => {
    for (const url of urls) vm.runInContext(read(url.split('?')[0]), context);
  };
  vm.runInContext(read('analysis.worker.js'), context);
  return { context, posted };
}

// Runs samples through the worker in chunks. options: { profile, chunk,
// sampleRate, dropAt: [{ frame, length }], silenceDbfs }
function runWorker(samples, options = {}) {
  const sampleRate = options.sampleRate || 48000;
  const chunk = options.chunk || 1024;
  const { context, posted } = loadWorker();
  const port = { onmessage: null, postMessage() {}, close() {} };
  context.self.onmessage({
    data: {
      type: 'init', release: RELEASE, protocol: PROTOCOL, generation: 7, sampleRate, port,
      config: { profile: options.profile || 'full', silenceDbfs: options.silenceDbfs ?? -60, adaptive: options.adaptive === true },
    },
  });
  let sequence = 0;
  let gapNext = true;
  for (let start = 0; start + chunk <= samples.length; start += chunk) {
    const drop = (options.dropAt || []).find((d) => start >= d.frame && start < d.frame + d.length);
    if (drop) { gapNext = true; continue; }
    const buffer = samples.slice(start, start + chunk).buffer;
    sequence += 1;
    port.onmessage({ data: { type: 'audio', release: RELEASE, protocol: PROTOCOL, generation: 7, sequence, startFrame: start, gap: gapNext, buffer } });
    gapNext = false;
  }
  return posted;
}

// Worker output -> measurement store snapshot (series + envelope + gaps).
function collect(posted, sampleRate = 48000) {
  const store = lib.measurementStore.createMeasurementStore({ pitchCapacity: 200000, envelopeCapacity: 400000 });
  store.beginEpoch({ captureEpoch: 7, sampleRate, maxWindowSamples: 5000 });
  for (const m of posted) {
    if (m.type === 'pitch') store.pushPitch(m.frame);
    else if (m.type === 'envelope') store.pushEnvelope(m.frames, 7);
    else if (m.type === 'gap') store.markGap(7, 2 * (m.startFrame || 0), m.droppedFrames);
    else if (m.type === 'harmonics') store.pushHarmonics(m.frame, 7);
  }
  store.flush();
  const snap = store.snapshot({ epoch: 7 });
  snap.series.sampleRate = sampleRate;
  return { store, snap };
}

function analyse(samples, options = {}) {
  const sampleRate = options.sampleRate || 48000;
  const posted = runWorker(samples, options);
  const { snap } = collect(posted, sampleRate);
  const rateHz = { full: 30, low: 20, high: 40, vibrato: 40 }[options.profile || 'full'];
  snap.series.expectedHop2 = (2 * sampleRate) / rateHz;
  const events = lib.noteEvents.segment({
    series: snap.series,
    envelope: snap.envelope,
    sampleRate,
    gaps: snap.gaps,
    boundaries: options.boundaries || [],
    options: { thresholdDbfs: options.thresholdDbfs ?? -50, a4Hz: options.a4Hz || 440 },
  });
  return { posted, snap, events };
}

module.exports = { RELEASE, PROTOCOL, lib, rng, gaussian, synth, runWorker, collect, analyse };
