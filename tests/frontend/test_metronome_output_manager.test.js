import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

// Design 4 / MT-05 / MT-19: shared output manager — leases, gain budget and
// the cross-tab claim (Web Locks, IndexedDB fallback with confirmed takeover).
const require = createRequire(import.meta.url);
const { IDBFactory } = require('fake-indexeddb');
const OM = require(path.join(process.cwd(), 'src/static/js/modules/audio/output_manager.js'));

function fakeContext() {
  const nodes = [];
  class Ctx {
    constructor() { this.state = 'running'; this.currentTime = 0; this.destination = { kind: 'destination' }; this.closed = false; }
    resume() { return Promise.resolve(); }
    close() { this.closed = true; this.state = 'closed'; return Promise.resolve(); }
    createGain() {
      const g = { gain: { value: 1, setTargetAtTime(v) { this.value = v; } }, out: [], connect(t) { this.out.push(t); return t; }, disconnect() { this.out = []; } };
      nodes.push(g);
      return g;
    }
  }
  return { Ctx, nodes };
}

function timers() {
  let id = 0;
  const intervals = new Map();
  const timeouts = new Map();
  return {
    setTimeout: (fn, ms) => { id += 1; timeouts.set(id, { fn, ms }); return id; },
    clearTimeout: (t) => timeouts.delete(t),
    setInterval: (fn) => { id += 1; intervals.set(id, fn); return id; },
    clearInterval: (t) => intervals.delete(t),
    beat: () => [...intervals.values()].forEach((fn) => fn()),
    runTimeouts: () => { const due = [...timeouts.values()]; timeouts.clear(); due.forEach((t) => t.fn()); },
  };
}

const settle = async () => { for (let i = 0; i < 30; i += 1) await new Promise((r) => setTimeout(r, 0)); };

describe('output manager: context, leases and gain budget', () => {
  it('creates the context only in unlockFromGesture and caps the master at 0.25', () => {
    const { Ctx, nodes } = fakeContext();
    const m = OM.createOutputManager({ AudioContext: Ctx, now: () => 0, ...timers() });
    expect(m.context()).toBeNull();
    expect(m.acquire('metronome', 2)).toEqual({ ok: false, code: 'NO_CONTEXT' });
    const u = m.unlockFromGesture();
    expect(u.ok).toBe(true);
    expect(nodes[0].gain.value).toBe(0.25);
    const l = m.acquire('metronome', 4);
    expect(l.ok).toBe(true);
    expect(l.lease.bus.gain.value).toBe(0.25); // 1 / 4 voices
    // Worst case: 4 voices at peak 1 -> 4 * 0.25 * 0.25 = 0.25 < 1.
  });

  it('exclusive by default: another consumer gets OUTPUT_BUSY, nothing is stopped silently', () => {
    const { Ctx } = fakeContext();
    const m = OM.createOutputManager({ AudioContext: Ctx, now: () => 0, ...timers() });
    m.unlockFromGesture();
    const a = m.acquire('metronome', 1);
    expect(m.acquire('tuner', 1)).toEqual({ ok: false, code: 'OUTPUT_BUSY' });
    m.release(a.lease);
    expect(m.acquire('tuner', 1).ok).toBe(true);
  });

  it('shutdown releases leases and the claim and closes the context; Audio Session is set and restored', () => {
    const { Ctx } = fakeContext();
    const session = { type: 'auto' };
    const m = OM.createOutputManager({ AudioContext: Ctx, audioSession: session, now: () => 0, ...timers() });
    const u = m.unlockFromGesture();
    expect(session.type).toBe('playback');
    m.shutdown();
    expect(u.context.closed).toBe(true);
    expect(m.context()).toBeNull();
    expect(session.type).toBe('auto');
  });
});

describe('cross-tab claim', () => {
  it('Web Locks: ifAvailable — the second tab is told "busy"; release lets it in', async () => {
    const held = new Set();
    const locks = {
      request(name, opts, cb) {
        if (held.has(name)) return Promise.resolve(cb(null));
        held.add(name);
        const p = Promise.resolve(cb({ name }));
        return p.then(() => held.delete(name));
      },
    };
    const a = OM.createOutputManager({ locks, now: () => 0, ...timers() });
    const b = OM.createOutputManager({ locks, now: () => 0, ...timers() });
    expect(a.claimKind).toBe('web-locks');
    expect(await a.prepareClaim()).toEqual({ ok: true });
    expect(await b.prepareClaim()).toEqual({ ok: false, reason: 'busy' });
    a.releaseClaim();
    await settle();
    expect(await b.prepareClaim()).toEqual({ ok: true });
  });

  it('IndexedDB fallback: busy while the owner beats; stale only after the heartbeat stops (takeover rules: test_metronome_engine_contracts)', async () => {
    const idb = new IDBFactory();
    let t = 0;
    const ta = timers();
    const a = OM.createOutputManager({ indexedDB: idb, now: () => t, ...ta });
    const b = OM.createOutputManager({ indexedDB: idb, now: () => t, ...timers() });
    expect(a.claimKind).toBe('indexeddb');
    expect(await a.prepareClaim()).toMatchObject({ ok: true });
    t += 5000;
    ta.beat();
    await settle();
    expect(await b.prepareClaim()).toMatchObject({ ok: false, reason: 'busy' });
    t += OM.STALE_MS + 1;
    expect(await b.prepareClaim()).toMatchObject({ ok: false, reason: 'stale' });
  });
});
