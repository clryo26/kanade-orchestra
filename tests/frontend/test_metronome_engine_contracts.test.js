import path from 'node:path';
import { createRequire } from 'node:module';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';

// R-02 / R-03 regression tests (logic level, fake clocks and fakes):
// MT-06 / MT-08 / MT-09 / MT-10 fences and acks, MT-19 claim and permits.
// Real-browser two-tab checks and audible double-sound checks are separate
// (MD-17 / MD-19) and are not claimed by these tests.
const require = createRequire(import.meta.url);
const dir = path.join(process.cwd(), 'src/static/js/modules/metronome');
const R = require(path.join(dir, 'rational.js'));
const SM = require(path.join(dir, 'score_model.js'));
const TP = require(path.join(dir, 'transport.js'));
const PB = require(path.join(dir, 'playback.js'));
const OM = require(path.join(process.cwd(), 'src/static/js/modules/audio/output_manager.js'));

const SR = 48000;
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function snap(payload = {}) {
  const p = SM.defaultBasicPreset(uuid(1));
  p.payload = Object.assign({}, p.payload, payload);
  return SM.buildSnapshot({ [p.id]: { 1: SM.validatePreset(p).preset } }, p.id, 1);
}

// Backend whose replaceFrom replies are released by the test.
function deferredHarness() {
  const clock = { frame: 0 };
  const timers = [];
  const scheduled = [];
  const pendingReplies = [];
  let generation = 0;
  const backend = {
    kind: 'worklet',
    setGeneration(g) { if (g > generation) generation = g; },
    schedule(events, g) { if (g !== generation) return 0; events.forEach((e) => scheduled.push({ ...e, g })); return events.length; },
    replaceFrom(frame, events, g) {
      return new Promise((resolve, reject) => pendingReplies.push({ frame, events, g, resolve, reject }));
    },
    cancelFrom() { return Promise.resolve({}); },
    stop(g) { if (g > generation) generation = g; scheduled.length = 0; return Promise.resolve({}); },
    renewPermit() {},
    currentFrame() { return clock.frame; },
  };
  const states = [];
  const tp = TP.createTransport({ backend, sampleRate: SR, setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout: () => {}, onState: (s) => states.push(s) });
  const advance = (seconds) => {
    const steps = Math.round(seconds / 0.025);
    for (let i = 0; i < steps; i += 1) {
      clock.frame += Math.round(SR * 0.025);
      timers.splice(0).forEach((fn) => fn());
    }
  };
  const acceptLast = (accepted = true) => {
    const p = pendingReplies.shift();
    if (accepted) {
      for (let i = scheduled.length - 1; i >= 0; i -= 1) if (scheduled[i].frame >= p.frame) scheduled.splice(i, 1);
      p.events.forEach((e) => scheduled.push({ ...e, g: p.g }));
    }
    p.resolve(accepted ? { accepted: true, appliedFrame: Math.max(p.frame, clock.frame), late: p.frame < clock.frame } : { accepted: false, code: 'QUEUE_FULL' });
  };
  return { tp, clock, scheduled, pendingReplies, states, advance, acceptLast, backend };
}

const settle = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };

describe('R-03 transport fence: prepare -> ack -> commit', () => {
  it('until the ack, positions and the timeline still follow the old plan', async () => {
    const h = deferredHarness();
    h.tp.load(snap(), 1);
    h.tp.start({ countInBars: 0 });
    h.advance(0.6);
    const editing = h.tp.edit(snap({ tempo: { bpmTenths: 600, reference: { n: 1, d: 4 } } }), 2, 'nextPulse');
    await settle();
    expect(h.pendingReplies).toHaveLength(1);
    expect(h.tp.getRevision()).toBe(1); // not committed
    expect(h.tp.isEditPending()).toBe(true);
    const fence = h.pendingReplies[0].frame;
    expect(h.tp.positionAt(fence + 24000).revision).toBe(1);
    h.acceptLast(true);
    const r = await editing;
    expect(r.accepted).toBe(true);
    expect(h.tp.getRevision()).toBe(2);
    // Before the fence: old map (120 BPM); after: new map (60 BPM).
    const before = h.tp.positionAt(fence - 12000);
    const after = h.tp.positionAt(fence + 24000);
    expect(before.revision).toBe(1);
    expect(after.revision).toBe(2);
    expect(after.tempo.bpm).toBeCloseTo(60, 9);
    expect(before.tempo.bpm).toBeCloseTo(120, 9);
  });

  it('accepted:false keeps the old plan (no gap, nothing doubled) and reports queue-full', async () => {
    const h = deferredHarness();
    h.tp.load(snap(), 1);
    const start = h.tp.start({ countInBars: 0 });
    h.advance(0.6);
    const editing = h.tp.edit(snap({ tempo: { bpmTenths: 600, reference: { n: 1, d: 4 } } }), 2, 'nextBar');
    await settle();
    h.acceptLast(false);
    await expect(editing).rejects.toMatchObject({ code: 'queue-full' });
    expect(h.tp.getRevision()).toBe(1);
    expect(h.tp.getState()).toBe('running');
    h.advance(3);
    const beats = h.scheduled.filter((e) => e.layerId === 'meter').map((e) => e.frame).sort((a, b) => a - b);
    beats.forEach((f, i) => expect(f).toBe(start.originFrame + i * 24000)); // 120 BPM throughout, no duplicates
    expect(new Set(beats).size).toBe(beats.length);
  });

  it('an ack timeout interrupts (neither plan can be confirmed); a late ack of an old generation is ignored', async () => {
    const h = deferredHarness();
    h.tp.load(snap(), 1);
    h.tp.start({ countInBars: 0 });
    h.advance(0.3);
    const editing = h.tp.edit(snap({ tempo: { bpmTenths: 900, reference: { n: 1, d: 4 } } }), 2, 'nextPulse');
    await settle();
    h.pendingReplies.shift().reject(new Error('ACK_TIMEOUT'));
    await expect(editing).rejects.toMatchObject({ code: 'ack-timeout' });
    expect(h.tp.getState()).toBe('interrupted');
    // A second run; an ack for the old one arrives late and changes nothing.
    h.tp.start({ countInBars: 0 });
    const g = h.tp.getGeneration();
    h.advance(0.3);
    const second = h.tp.edit(snap({ tempo: { bpmTenths: 900, reference: { n: 1, d: 4 } } }), 3, 'nextPulse');
    await settle();
    h.tp.stop();
    h.acceptLast(true);
    expect(await second).toEqual({ stale: true });
    expect(h.tp.getGeneration()).toBe(g + 1);
    expect(h.tp.getState()).toBe('stopped');
  });

  it('edits run one after another: the second waits until the first is settled', async () => {
    const h = deferredHarness();
    h.tp.load(snap(), 1);
    h.tp.start({ countInBars: 0 });
    h.advance(0.3);
    const a = h.tp.edit(snap({ tempo: { bpmTenths: 900, reference: { n: 1, d: 4 } } }), 2, 'nextPulse');
    const b = h.tp.edit(snap({ tempo: { bpmTenths: 1500, reference: { n: 1, d: 4 } } }), 3, 'nextPulse');
    await settle();
    expect(h.pendingReplies).toHaveLength(1);
    h.acceptLast(true);
    await a;
    await settle();
    expect(h.pendingReplies).toHaveLength(1);
    h.acceptLast(true);
    await b;
    expect(h.tp.getRevision()).toBe(3);
  });

  it('nothing new is filled while a fence waits; pause during a pending fence makes the ack stale', async () => {
    const h = deferredHarness();
    h.tp.load(snap(), 1);
    h.tp.start({ countInBars: 0 });
    h.advance(0.3);
    const editing = h.tp.edit(snap({ tempo: { bpmTenths: 600, reference: { n: 1, d: 4 } } }), 2, 'nextBar');
    await settle();
    const fence = h.pendingReplies[0].frame;
    const count = h.scheduled.length;
    h.advance(0.2);
    expect(h.scheduled.length).toBe(count);
    expect(h.scheduled.every((e) => e.frame < fence)).toBe(true);
    await h.tp.pause();
    h.acceptLast(true);
    expect(await editing).toEqual({ stale: true });
    expect(h.tp.getState()).toBe('paused');
  });
});

// ----- AudioWorklet processor (run in Node with a fake worklet scope) -----------

function loadProcessor() {
  const sent = [];
  globalThis.sampleRate = SR;
  globalThis.currentFrame = 0;
  globalThis.AudioWorkletProcessor = class { constructor() { this.port = { postMessage: (m) => sent.push(m), onmessage: null }; } };
  delete require.cache[require.resolve(path.join(dir, 'click_processor.js'))];
  const mod = require(path.join(dir, 'click_processor.js'));
  const proc = new mod.PortalMetronomeClickProcessor({ processorOptions: { release: 'r', capacity: 8, maxVoices: 8 } });
  const msg = (m) => proc.onMessage({ data: Object.assign({ release: 'r', protocol: mod.PROTOCOL }, m) });
  msg({ type: 'init', requestId: 1, buffers: [new Float32Array(4800).fill(0.5)], generation: 1 });
  const render = (frames = 128) => {
    const out = [new Float32Array(frames)];
    proc.process([], [out]);
    globalThis.currentFrame += frames;
    return out[0];
  };
  const events = (frames) => { const a = new Float64Array(frames.length * 3); frames.forEach((f, i) => { a[i * 3] = f; a[i * 3 + 1] = 0; a[i * 3 + 2] = 1; }); return a; };
  return { proc, msg, render, events, sent };
}

describe('R-03 / R-02 click processor', () => {
  it('replaceFrom that does not fit is rejected and the old queue is kept', () => {
    const p = loadProcessor();
    p.msg({ type: 'append', generation: 1, events: p.events([1000, 2000, 3000, 4000, 5000, 6000]) });
    expect(p.proc.qCount).toBe(6);
    p.msg({ type: 'replaceFrom', requestId: 2, generation: 1, frame: 3000, events: p.events([3000, 3100, 3200, 3300, 3400, 3500, 3600]) });
    const reply = p.sent.find((m) => m.requestId === 2);
    expect(reply.accepted).toBe(false);
    expect(reply.code).toBe('QUEUE_FULL');
    expect(p.proc.qCount).toBe(6);
    expect(Array.from(p.proc.qFrame.slice(0, 6))).toEqual([1000, 2000, 3000, 4000, 5000, 6000]);
    p.msg({ type: 'replaceFrom', requestId: 3, generation: 1, frame: 3000, events: p.events([3000, 3500]) });
    expect(p.sent.find((m) => m.requestId === 3).accepted).toBe(true);
    expect(Array.from(p.proc.qFrame.slice(0, p.proc.qCount))).toEqual([1000, 2000, 3000, 3500]);
  });

  it('a late stop of an older generation never rewinds the generation or clears the new queue', () => {
    const p = loadProcessor();
    p.msg({ type: 'stop', requestId: 2, newGeneration: 5 });
    p.msg({ type: 'append', generation: 5, events: p.events([1000]) });
    p.msg({ type: 'stop', requestId: 3, newGeneration: 4 }); // delayed old message
    expect(p.proc.generation).toBe(5);
    expect(p.proc.qCount).toBe(1);
    expect(p.sent.find((m) => m.requestId === 3).stale).toBe(true);
  });

  it('needs a current permit; a revocation latches silence until a newer permit; old permits are ignored', () => {
    const p = loadProcessor();
    const wall = Date.now();
    p.msg({ type: 'append', generation: 1, events: p.events([10]) });
    expect(Math.max(...p.render())).toBe(0); // no permit: silent
    p.msg({ type: 'append', generation: 1, events: p.events([300]) });
    p.msg({ type: 'permit', generation: 1, seq: 3, until: 48000, expiresAtUtcMs: wall + 2000 });
    expect(Math.max(...p.render(128), ...p.render(256))).toBeGreaterThan(0);
    p.msg({ type: 'revoke', seq: 3 });
    p.msg({ type: 'permit', generation: 1, seq: 2, until: 96000, expiresAtUtcMs: wall + 5000 }); // older than the revocation
    for (let i = 0; i < 4; i += 1) p.render(); // the 5 ms fade of what was sounding
    expect(p.proc.voices).toBe(0);
    p.msg({ type: 'append', generation: 1, events: p.events([globalThis.currentFrame + 10]) });
    expect(Math.max(...p.render())).toBe(0);
    p.msg({ type: 'permit', generation: 1, seq: 4, until: 96000, expiresAtUtcMs: wall + 5000 });
    p.msg({ type: 'append', generation: 1, events: p.events([globalThis.currentFrame + 10]) });
    expect(Math.max(...p.render())).toBeGreaterThan(0);
  });

  it('an expired wall-clock permit is silent even when the frame clock did not advance (suspended context)', () => {
    const p = loadProcessor();
    p.msg({ type: 'permit', generation: 1, seq: 1, until: 480000, expiresAtUtcMs: Date.now() - 1 });
    p.msg({ type: 'append', generation: 1, events: p.events([10]) });
    expect(Math.max(...p.render())).toBe(0);
    expect(p.sent.some((m) => m.type === 'permit-expired')).toBe(true);
  });

  it('cancelFrom fades voices that started at or after the cut, keeps earlier ones', () => {
    const p = loadProcessor();
    p.msg({ type: 'permit', generation: 1, seq: 1, until: 480000, expiresAtUtcMs: Date.now() + 5000 });
    p.msg({ type: 'append', generation: 1, events: p.events([0, 64]) });
    p.render();
    expect(p.proc.voices).toBe(2);
    p.msg({ type: 'cancelFrom', requestId: 9, generation: 1, frame: 50 });
    for (let i = 0; i < 4; i += 1) p.render();
    expect(p.proc.voices).toBe(1);
    expect(p.proc.vStart[0]).toBe(0);
  });
});

// ----- main-thread backend (fake AudioContext) ---------------------------------------

function fakeAudio() {
  const started = [];
  const ctx = {
    sampleRate: SR,
    currentTime: 0,
    createBuffer: (ch, len) => ({ length: len, getChannelData: () => new Float32Array(len), copyToChannel() {} }),
    createBufferSource() {
      const src = { buffer: null, connect() {}, disconnect() {}, start(when) { this.when = when; started.push(this); }, stop(at) { this.stoppedAt = at; } };
      return src;
    },
    createGain() { return { gain: { value: 1, setTargetAtTime(v) { this.value = v; } }, connect() {}, disconnect() {} }; },
  };
  return { ctx, started };
}

describe('R-02 / R-03 main backend', () => {
  const bank = { buffers: [new Float32Array(10)], soundIndex: () => 0 };
  const ev = (frame) => ({ frame, emit: true, velocity: 1, soundId: 'click', accentLevel: 'pulse' });

  it('starts nothing without a current permit; a revocation stops what is scheduled', () => {
    const { ctx, started } = fakeAudio();
    let utc = 1000;
    const b = PB.createMainBackend({ context: ctx, bus: {}, bank, volume: () => 1, now: () => utc });
    b.init();
    b.setGeneration(1);
    b.schedule([ev(4800)], 1);
    expect(started).toHaveLength(0);
    b.renewPermit(96000, { seq: 1, expiresAtUtcMs: 3000 });
    b.schedule([ev(9600)], 1);
    expect(started).toHaveLength(1);
    utc = 4000; // wall-clock expiry
    b.schedule([ev(14400)], 1);
    expect(started).toHaveLength(1);
    utc = 1000;
    b.revoke(1);
    expect(started[0].stoppedAt).toBeDefined();
    b.renewPermit(96000, { seq: 1, expiresAtUtcMs: 3000 }); // the revoked permit cannot come back
    b.schedule([ev(19200)], 1);
    expect(started).toHaveLength(1);
  });

  it('a fence in the past is applied at now (late) with the same reply shape as the worklet', async () => {
    const { ctx } = fakeAudio();
    const b = PB.createMainBackend({ context: ctx, bus: {}, bank, volume: () => 1, now: () => 0 });
    b.init();
    b.setGeneration(1);
    b.renewPermit(480000, { seq: 1, expiresAtUtcMs: 10 });
    ctx.currentTime = 1;
    const r = await b.replaceFrom(24000, [ev(60000)], 1);
    expect(r).toEqual({ accepted: true, appliedFrame: 48000, late: true });
    expect(await b.replaceFrom(24000, [], 0)).toEqual({ stale: true });
  });
});

// ----- claim, takeover and permits (IndexedDB fallback and Web Locks) -------------------

function managerTimers() {
  let id = 0;
  const intervals = new Map();
  const timeouts = new Map();
  return {
    setTimeout: (fn) => { id += 1; timeouts.set(id, fn); return id; },
    clearTimeout: (t) => timeouts.delete(t),
    setInterval: (fn) => { id += 1; intervals.set(id, fn); return id; },
    clearInterval: (t) => intervals.delete(t),
    beat: () => [...intervals.values()].forEach((fn) => fn()),
    flushTimeouts: () => { const due = [...timeouts.values()]; timeouts.clear(); due.forEach((fn) => fn()); },
  };
}

const settleIdb = async () => { for (let i = 0; i < 40; i += 1) await new Promise((r) => setTimeout(r, 0)); };

function fakeCtxClass() {
  return class {
    constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; this.onstatechange = null; }
    resume() { return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
    createGain() { return { gain: { value: 1, setTargetAtTime(v) { this.value = v; } }, connect() {}, disconnect() {} }; }
  };
}

describe('R-02 IndexedDB claim: confirmed takeover only with an ack or a verified guard', () => {
  function tabs() {
    const idb = new IDBFactory();
    const clock = { t: 1000000 };
    const make = (name) => {
      const timers = managerTimers();
      const lost = [];
      const m = OM.createOutputManager({ indexedDB: idb, now: () => clock.t, AudioContext: fakeCtxClass(), onLost: (r) => lost.push(r), tabId: name, ...timers });
      return { m, timers, lost };
    };
    return { idb, clock, make };
  }

  it('takeover is refused when the old owner beat again (compare-and-set on what was shown)', async () => {
    const { clock, make } = tabs();
    const a = make('A');
    const b = make('B');
    expect((await a.m.prepareClaim()).ok).toBe(true);
    clock.t += OM.STALE_MS + 1;
    const seen = await b.m.prepareClaim();
    expect(seen.reason).toBe('stale');
    // Tab A comes back before the user confirms.
    a.timers.beat();
    await settleIdb();
    const r = await b.m.takeoverClaim(seen.observed);
    expect(r).toEqual({ ok: false, reason: 'changed' });
    expect(b.m.hasClaim()).toBe(false);
    expect(a.m.hasClaim()).toBe(true);
  });

  it('takeover is refused when a third tab took the claim meanwhile', async () => {
    const { clock, make } = tabs();
    const a = make('A');
    const b = make('B');
    const c = make('C');
    await a.m.prepareClaim();
    clock.t += OM.STALE_MS + 1;
    const seenB = await b.m.prepareClaim();
    const seenC = await c.m.prepareClaim();
    c.m.takeoverClaim(seenC.observed); // C is now the (pending) owner
    await settleIdb();
    const rB = await b.m.takeoverClaim(seenB.observed);
    expect(rB.reason).toBe('changed');
    expect(b.m.hasClaim()).toBe(false);
  });

  it('with an unverified old guard the new owner waits for the old tab\'s stop ack; then it may sound', async () => {
    const { clock, make } = tabs();
    const a = make('A');
    const b = make('B');
    await a.m.prepareClaim(); // A never reported a verified guard (main-thread backend)
    clock.t += OM.STALE_MS + 1;
    const seen = await b.m.prepareClaim();
    const take = b.m.takeoverClaim(seen.observed);
    let settled = null;
    take.then((r) => { settled = r; });
    // Even far beyond the old permit, no ack: still not allowed.
    for (let i = 0; i < 300 && !settled; i += 1) {
      await settleIdb();
      clock.t += 1500;
      b.timers.flushTimeouts();
    }
    expect(settled).toEqual({ ok: false, reason: 'waiting-old-tab' });
    expect(b.m.hasClaim()).toBe(false);
    expect(b.m.claimPending()).toBe(true);
    // A wakes up: notices the loss, stops (onLost) and acknowledges.
    a.timers.beat();
    await settleIdb();
    expect(a.lost).toEqual(['taken-over']);
    b.timers.beat();
    await settleIdb();
    expect(b.m.hasClaim()).toBe(true);
  }, 30000);

  it('with a verified old guard the new owner may sound after the old permit expiry plus the drain margin', async () => {
    const { clock, make } = tabs();
    const a = make('A');
    const b = make('B');
    await a.m.prepareClaim();
    a.m.unlockFromGesture();
    a.m.acquire('metronome', 1, { guard: 'verified' }); // worklet lease: verified time guard
    await a.m.renewPermit();
    await settleIdb();
    const permitEnd = clock.t + OM.PERMIT_MS;
    clock.t += OM.STALE_MS + 1; // A frozen
    const seen = await b.m.prepareClaim();
    expect(seen.observed.guard).toBe('verified');
    expect(seen.observed.lastPermitExpiresAtUtcMs).toBeGreaterThanOrEqual(permitEnd - 1);
    const r = await b.m.takeoverClaim(seen.observed);
    expect(r.ok).toBe(true); // the old permit already expired long ago
  });

  it('a released claim never reuses its generation', async () => {
    const { make } = tabs();
    const a = make('A');
    await a.m.prepareClaim();
    const g1 = a.m.claimGeneration();
    a.m.releaseClaim();
    await settleIdb();
    await a.m.prepareClaim();
    expect(a.m.claimGeneration()).toBeGreaterThan(g1);
  });

  it('permits only while owned and after the record update; a lost claim revokes; DB failure gives no permit', async () => {
    const { clock, make } = tabs();
    const a = make('A');
    const b = make('B');
    await a.m.prepareClaim();
    a.m.unlockFromGesture();
    const revoked = [];
    a.m.acquire('metronome', 1, { onRevoke: (why) => revoked.push(why) });
    expect(await a.m.renewPermit()).toMatchObject({ seq: expect.any(Number) });
    expect(a.m.permit()).not.toBeNull();
    clock.t += OM.STALE_MS + 1;
    const seen = await b.m.prepareClaim();
    b.m.takeoverClaim(seen.observed);
    await settleIdb();
    // A's next renewal finds the claim gone: no permit, consumers revoked.
    expect(await a.m.renewPermit()).toBeNull();
    await settleIdb();
    expect(a.m.permit()).toBeNull();
    expect(revoked.length).toBeGreaterThan(0);
  });

  it('a permit is revoked when the context leaves "running" (frame clock stops) and cannot come back', async () => {
    const { make } = tabs();
    const a = make('A');
    await a.m.prepareClaim();
    const u = a.m.unlockFromGesture();
    const revoked = [];
    a.m.acquire('metronome', 1, { onRevoke: (why) => revoked.push(why) });
    await a.m.renewPermit();
    expect(a.m.permit()).not.toBeNull();
    u.context.state = 'suspended';
    u.context.onstatechange();
    expect(revoked).toEqual(['context-suspended']);
    expect(a.m.permit()).toBeNull();
    u.context.state = 'running';
    expect(a.m.permit()).toBeNull(); // the old permit stays invalid; a new one needs a renewal
  });
});

describe('R-02 Web Locks claim', () => {
  it('a lock granted after the request was withdrawn (leave / hidden) is released at once', async () => {
    let grant;
    const released = [];
    const locks = {
      request(name, opts, cb) {
        return new Promise((resolve) => { grant = () => { const p = cb({ name }); resolve(p); if (p && p.then) p.then(() => released.push(name)); else released.push(name); }; });
      },
    };
    const m = OM.createOutputManager({ locks, now: () => 0, ...managerTimers() });
    const pending = m.prepareClaim();
    m.releaseClaim(); // left while the lock was pending
    grant();
    expect(await pending).toEqual({ ok: false, reason: 'withdrawn' });
    await Promise.resolve();
    expect(m.hasClaim()).toBe(false);
    expect(released).toEqual(['portal-audio-output']);
  });

  it('page manager: one context for every consumer; exclusive unless both chose concurrency; budget split', () => {
    const m = OM.createOutputManager({ AudioContext: fakeCtxClass(), now: () => 0, ...managerTimers() });
    m.unlockFromGesture();
    const a = m.acquire('metronome', 2);
    expect(m.acquire('tuner', 1)).toEqual({ ok: false, code: 'OUTPUT_BUSY' });
    m.release(a.lease);
    m.setConcurrentAllowed(true);
    const x = m.acquire('metronome', 2, { concurrent: true });
    const y = m.acquire('tuner', 1, { concurrent: true });
    expect(y.ok).toBe(true);
    expect(x.lease.bus.gain.value).toBeCloseTo(0.25, 9); // 1/2 share / 2 voices
    expect(y.lease.bus.gain.value).toBeCloseTo(0.5, 9);
    m.drop('tuner');
    expect(x.lease.bus.gain.value).toBeCloseTo(0.5, 9);
  });

  it('the context closes and the claim is given back only when the last consumer leaves, or after 60 s without leases', () => {
    const t = managerTimers();
    const m = OM.createOutputManager({ AudioContext: fakeCtxClass(), now: () => 0, ...t });
    m.retain('metronome');
    m.retain('tuner');
    const u = m.unlockFromGesture();
    m.drop('metronome');
    expect(u.context.state).toBe('running');
    const l = m.acquire('tuner', 1);
    m.release(l.lease);
    t.flushTimeouts(); // idle 60 s
    expect(u.context.state).toBe('closed');
  });
});
