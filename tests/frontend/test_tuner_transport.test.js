import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const tunerDir = path.join(root, 'src/static/js/modules/tuner');
const read = (name) => fs.readFileSync(path.join(tunerDir, name), 'utf8');
const RELEASE = read('capture.worklet.js').match(/TUNER_RELEASE_ID = '([^']+)'/)[1];

class FakePort {
  constructor() { this.sent = []; this.onmessage = null; this.closed = false; }
  postMessage(message, transfer) { this.sent.push({ message, transfer }); }
  close() { this.closed = true; }
}

// ----- AudioWorklet --------------------------------------------------------

function loadWorklet() {
  let Processor = null;
  const context = vm.createContext({
    AudioWorkletProcessor: class { constructor() { this.port = new FakePort(); } },
    registerProcessor: (name, cls) => { Processor = cls; context.registeredName = name; },
    currentFrame: 0,
    sampleRate: 48000,
    Float32Array,
    ArrayBuffer,
    Math,
    Number,
  });
  vm.runInContext(read('capture.worklet.js'), context);
  return { context, Processor };
}

function createProcessor(options = {}) {
  const { context, Processor } = loadWorklet();
  const processor = new Processor({
    processorOptions: { release: RELEASE, protocol: 1, generation: 3, chunkSize: 256, poolSize: 2, ...options },
  });
  const out = new FakePort();
  processor.port.onmessage({ data: { type: 'connect', port: out } });
  let counter = 0;
  function block(length) {
    const input = Float32Array.from({ length }, () => { counter += 1; return counter; });
    const output = [new Float32Array(length).fill(9)];
    const keepAlive = processor.process([[input]], [output]);
    context.currentFrame += length;
    return { keepAlive, output };
  }
  return { context, processor, out, block };
}

describe('tuner capture worklet', () => {
  it('registers, reports ready with its release, and keeps the output silent', () => {
    const { context, processor, block } = createProcessor();
    expect(context.registeredName).toBe('portal-tuner-capture');
    expect(processor.port.sent[0].message).toMatchObject({ type: 'ready', release: RELEASE, protocol: 1, generation: 3 });
    const { keepAlive, output } = block(128);
    expect(keepAlive).toBe(true);
    expect(Array.from(output[0]).every((v) => v === 0)).toBe(true);
  });

  it('packs variable-length blocks into contiguous chunks and transfers the buffers', () => {
    const { out, block } = createProcessor({ poolSize: 4 });
    for (const length of [100, 128, 37, 200, 47]) block(length); // 512 frames
    const chunks = out.sent.map((s) => s.message).filter((m) => m.type === 'audio');
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({ sequence: 1, startFrame: 0, gap: true, generation: 3, release: RELEASE });
    expect(chunks[1]).toMatchObject({ sequence: 2, startFrame: 256, gap: false });
    const samples = [...new Float32Array(chunks[0].buffer), ...new Float32Array(chunks[1].buffer)];
    expect(samples).toEqual(Array.from({ length: 512 }, (_, i) => i + 1));
    expect(out.sent[0].transfer[0]).toBe(chunks[0].buffer);
  });

  it('drops audio when the bounded pool is empty and flags the next chunk as a gap', () => {
    const { out, block } = createProcessor({ poolSize: 2 });
    for (let i = 0; i < 6; i += 1) block(128); // 768 frames, pool holds 2 x 256
    let chunks = out.sent.map((s) => s.message).filter((m) => m.type === 'audio');
    expect(chunks).toHaveLength(2);
    // The worker returns one buffer; capture resumes but marks the discontinuity.
    out.onmessage({ data: { type: 'return', buffer: new ArrayBuffer(256 * 4) } });
    block(128);
    block(128);
    chunks = out.sent.map((s) => s.message).filter((m) => m.type === 'audio');
    expect(chunks).toHaveLength(3);
    expect(chunks[2].gap).toBe(true);
    expect(chunks[2].droppedFrames).toBe(256);
  });

  it('discards a partial chunk when input disappears and flags the next chunk as a gap', () => {
    const { out, block, processor, context } = createProcessor({ poolSize: 4 });
    block(128); // partial chunk: 128 of 256
    // A block with no input (source muted/disconnected).
    processor.process([[]], [[new Float32Array(128)]]);
    context.currentFrame += 128;
    block(128);
    block(128);
    const chunks = out.sent.map((s) => s.message).filter((m) => m.type === 'audio');
    expect(chunks).toHaveLength(1);
    // Only the 256 samples after the missing block, starting at their own frame.
    expect(chunks[0]).toMatchObject({ startFrame: 256, gap: true, droppedFrames: 256 });
    expect(Array.from(new Float32Array(chunks[0].buffer))).toEqual(Array.from({ length: 256 }, (_, i) => 129 + i));
  });

  it('rejects a different release and stops on request', () => {
    const mismatch = createProcessor({ release: 'other' });
    expect(mismatch.processor.port.sent[0].message.type).toBe('version-mismatch');
    expect(mismatch.block(128).keepAlive).toBe(false);
    const normal = createProcessor();
    normal.processor.port.onmessage({ data: { type: 'stop' } });
    expect(normal.block(128).keepAlive).toBe(false);
    expect(normal.out.closed).toBe(true);
  });
});

// ----- Analysis Worker -----------------------------------------------------

function loadWorker() {
  const posted = [];
  const context = vm.createContext({
    Float32Array, Float64Array, Uint32Array, ArrayBuffer, Math, Number, Object, Array, Error, Promise, Infinity, NaN,
    location: { search: `?rev=${RELEASE}` },
    postMessage: (message, transfer) => posted.push({ message, transfer }),
    close: () => { context.closed = true; },
  });
  context.self = context;
  context.importScripts = (...urls) => {
    for (const url of urls) vm.runInContext(read(url.split('?')[0]), context);
  };
  vm.runInContext(read('analysis.worker.js'), context);
  return { context, posted };
}

function sineChunks(frequency, seconds, chunkSize = 2048, sampleRate = 48000) {
  const total = Math.floor(seconds * sampleRate / chunkSize);
  return Array.from({ length: total }, (_, c) => Float32Array.from({ length: chunkSize }, (_, i) => {
    const n = c * chunkSize + i;
    return 0.5 * Math.sin((2 * Math.PI * frequency * n) / sampleRate);
  }));
}

function initWorker(options = {}) {
  const { context, posted } = loadWorker();
  const port = new FakePort();
  context.self.onmessage({ data: { type: 'init', release: RELEASE, protocol: 1, generation: 2, sampleRate: 48000, port, ...options } });
  let startFrame = 0;
  function send(samples, extra = {}) {
    port.onmessage({ data: { type: 'audio', release: RELEASE, protocol: 1, generation: 2, startFrame, gap: startFrame === 0, buffer: samples.buffer, ...extra } });
    startFrame += samples.length;
  }
  return { context, posted, port, send };
}

describe('tuner analysis worker', () => {
  it('handshakes with session information', () => {
    const { posted } = initWorker();
    expect(posted[0].message).toMatchObject({ type: 'ready', release: RELEASE, generation: 2 });
    expect(posted[0].message.session).toMatchObject({ sampleRate: 48000, fftSize: 16384, window: 'hann', displayMinFrequency: 500, displayMaxFrequency: 16000 });
    // The display axis comes as its own message (default: 500 Hz-16 kHz).
    expect(posted[1].message).toMatchObject({ type: 'display-axis', generation: 2, axis: { axisId: 0, min: 500, max: 16000, nyquist: 24000 } });
    expect(posted[1].message.axis.frequencies).toHaveLength(512);
  });

  it('switches the display axis without touching analysis, and tags frames with the axis id', () => {
    const { context, posted, send } = initWorker({ displayRange: { axisId: 4, min: 500, max: 16000 } });
    const chunks = sineChunks(110, 0.8);
    chunks.slice(0, 12).forEach((chunk) => send(chunk));
    context.self.onmessage({ data: { type: 'display-range', generation: 2, range: { axisId: 5, min: 25, max: 16000 } } });
    chunks.slice(12).forEach((chunk) => send(chunk));
    const messages = posted.map((p) => p.message);
    const axes = messages.filter((m) => m.type === 'display-axis');
    expect(axes.map((m) => [m.axis.axisId, m.axis.min, m.axis.max])).toEqual([[4, 500, 16000], [5, 25, 16000]]);
    const switchAt = messages.indexOf(axes[1]);
    const spectraBefore = messages.slice(0, switchAt).filter((m) => m.type === 'spectrum');
    const spectraAfter = messages.slice(switchAt).filter((m) => m.type === 'spectrum');
    expect(spectraAfter.length).toBeGreaterThan(0);
    expect(spectraBefore.every((m) => m.frame.axisId === 4)).toBe(true);
    expect(spectraAfter.every((m) => m.frame.axisId === 5)).toBe(true);
    // Low-note pitch detection continues regardless of the display axis (110 Hz < 500 Hz).
    const lastPitch = messages.filter((m) => m.type === 'pitch').at(-1).frame;
    expect(lastPitch.valid).toBe(true);
    expect(Math.abs(1200 * Math.log2(lastPitch.frequency / 110))).toBeLessThan(1);
    // A request from another generation, or a nonsensical range, cannot break the axis.
    context.self.onmessage({ data: { type: 'display-range', generation: 1, range: { axisId: 9, min: 25, max: 16000 } } });
    context.self.onmessage({ data: { type: 'display-range', generation: 2, range: { axisId: 10, min: 0, max: -1 } } });
    const lastAxis = posted.map((p) => p.message).filter((m) => m.type === 'display-axis').at(-1).axis;
    expect([lastAxis.axisId, lastAxis.min, lastAxis.max]).toEqual([10, 25, 16000]);
  });

  it('analyses pitch at most 20 times and spectrum at most 10 times per second, returning buffers', () => {
    const { posted, port, send } = initWorker();
    const chunks = sineChunks(440, 1.0);
    for (const chunk of chunks) send(chunk);
    const messages = posted.map((p) => p.message);
    const pitches = messages.filter((m) => m.type === 'pitch');
    const spectra = messages.filter((m) => m.type === 'spectrum');
    expect(pitches.length).toBeLessThanOrEqual(20);
    expect(pitches.length).toBeGreaterThanOrEqual(15);
    expect(spectra.length).toBeLessThanOrEqual(10);
    expect(spectra.length).toBeGreaterThanOrEqual(5); // needs 16,384 samples (~0.34 s) first
    const last = pitches.at(-1).frame;
    expect(last.valid).toBe(true);
    expect(Math.abs(1200 * Math.log2(last.frequency / 440))).toBeLessThan(1);
    expect(last.endFrame - last.startFrame).toBeGreaterThan(0);
    expect(last.rmsDbfs).toBeLessThan(0);
    const spectrumFrame = spectra.at(-1).frame;
    expect(spectrumFrame.display).toHaveLength(512);
    expect(spectrumFrame.fundamental).toBeCloseTo(440, 0);
    expect(spectrumFrame.harmonics[0]).toMatchObject({ number: 1, valid: true });
    expect(posted.find((p) => p.message.type === 'spectrum').transfer).toHaveLength(1);
    const returns = port.sent.filter((s) => s.message.type === 'return');
    expect(returns).toHaveLength(chunks.length);
    expect(returns[0].transfer).toHaveLength(1);
  });

  it('keeps sending status while silent so the main thread watchdog stays informed', () => {
    const { posted, send } = initWorker();
    for (let i = 0; i < 12; i += 1) send(new Float32Array(2048));
    const messages = posted.map((p) => p.message).filter((m) => m.type === 'pitch' || m.type === 'status');
    expect(messages.length).toBeGreaterThanOrEqual(8);
    expect(messages.filter((m) => m.type === 'pitch').every((m) => m.frame.valid === false && m.frame.reason === 'silent')).toBe(true);
  });

  it('never bridges a gap: continuity resets and the main thread is told', () => {
    const { posted, send } = initWorker();
    const chunks = sineChunks(440, 0.8);
    for (const chunk of chunks) send(chunk);
    expect(posted.some((p) => p.message.type === 'pitch' && p.message.frame.valid)).toBe(true);
    const before = posted.length;
    send(chunks[0], { gap: true, droppedFrames: 4096 });
    const after = posted.slice(before).map((p) => p.message);
    expect(after[0]).toMatchObject({ type: 'gap', droppedFrames: 4096 });
    // Only 2,048 contiguous samples exist after the gap: too few for a pitch frame.
    expect(after.some((m) => m.type === 'pitch')).toBe(false);
  });

  it('treats non-contiguous timestamps as a gap even without the gap flag', () => {
    const { posted, port } = initWorker();
    const chunks = sineChunks(440, 0.8);
    let frame = 0;
    for (const chunk of chunks) {
      port.onmessage({ data: { type: 'audio', release: RELEASE, protocol: 1, generation: 2, startFrame: frame, gap: frame === 0, buffer: chunk.buffer } });
      frame += 2048;
    }
    const before = posted.length;
    const next = sineChunks(440, 0.05)[0];
    port.onmessage({ data: { type: 'audio', release: RELEASE, protocol: 1, generation: 2, startFrame: frame + 512, gap: false, buffer: next.buffer } });
    const after = posted.slice(before).map((p) => p.message);
    expect(after[0]).toMatchObject({ type: 'gap', droppedFrames: 512 });
    expect(after.some((m) => m.type === 'pitch')).toBe(false);
  });

  it('ignores audio from another generation and reports a release mismatch once', () => {
    const { posted, send } = initWorker();
    send(new Float32Array(2048), { generation: 1 });
    expect(posted.filter((p) => p.message.type !== 'ready' && p.message.type !== 'display-axis')).toHaveLength(0);
    send(new Float32Array(2048), { release: 'other' });
    send(new Float32Array(2048), { release: 'other' });
    expect(posted.filter((p) => p.message.type === 'version-mismatch')).toHaveLength(1);
  });

  it('refuses to start for a different release', () => {
    const { posted } = initWorker({ release: 'other' });
    expect(posted[0].message).toMatchObject({ type: 'version-mismatch', source: 'worker' });
  });
});
