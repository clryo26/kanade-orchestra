const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');

// D: playback method comparison (design 7, MT-04 / MT-07 / MT-08) in headless
// Chromium. The same compiled event list goes through the AudioWorklet, the
// main-thread look-ahead and the short-buffer backends.
// - OfflineAudioContext: rendered onset samples vs the theoretical frames.
// - Real time: main-thread stalls of 0.5H, H, 1.5H, 2H and 2 s (H = look-ahead
//   of the backend) with the telemetry, and edit / pause / stop reaction.
// The measured numbers are written to .tmp/metronome-backend-report.json
// (not part of the source ZIP). They are headless desktop measurements: no
// adopted look-ahead value and no device result follows from them (M-OPEN-01).
test.use({ channel: 'chromium', launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] } });

const MODULES = ['rational', 'score_model', 'tempo_map', 'event_compiler', 'sounds', 'playback', 'transport'];

async function loadEngine(page) {
  await page.goto('/');
  await page.addScriptTag({ url: '/static/js/modules/audio/output_manager.js' });
  for (const name of MODULES) await page.addScriptTag({ url: `/static/js/modules/metronome/${name}.js` });
}

function writeReport(name, data) {
  const out = path.join(process.cwd(), '.tmp', `metronome-backend-${name}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ measuredAt: new Date().toISOString(), environment: 'Playwright headless Chromium (desktop)', [name]: data }, null, 2));
}

test('offline render: every backend places the same clicks on the same samples', async ({ page }) => {
  await loadEngine(page);
  const result = await page.evaluate(async () => {
    const L = window.PortalMetronomeLib;
    const R = L.rational;
    const SR = 48000;
    const preset = L.scoreModel.defaultBasicPreset('00000000-0000-4000-8000-000000000001');
    preset.payload.subdivision = { unit: { n: 1, d: 16 } };
    const adv = { schemaVersion: 1, id: '00000000-0000-4000-8000-00000000a001', revision: 1, kind: 'advanced', title: 'x', payload: { basePresetId: preset.id, baseRevision: 1, layers: [{ id: 'l1', cycle: { n: 1, d: 1 }, pulses: 3, phase: { n: 1, d: 32 }, soundId: 'wood', volume: 1 }] } };
    const store = { [preset.id]: { 1: L.scoreModel.validatePreset(preset).preset }, [adv.id]: { 1: L.scoreModel.validatePreset(adv).preset } };
    const snap = L.scoreModel.buildSnapshot(store, adv.id, 1);
    const map = L.tempoMap.fromSnapshot(snap);
    const origin = 4800;
    const events = L.eventCompiler.compile({ snapshot: snap, tempoMap: map, origin: { score: R.ZERO, frame: origin }, sampleRate: SR, from: R.ZERO, to: R.make(3, 2) }).events.filter((e) => e.emit);
    const expected = [...new Set(events.map((e) => e.frame))].sort((a, b) => a - b);
    const seconds = 3.6;
    const permit = { seq: 1, expiresAtUtcMs: Date.now() + 1e9, claimGeneration: 1 };
    async function render(kind) {
      const ctx = new OfflineAudioContext(1, Math.round(SR * seconds), SR);
      const bank = L.sounds.createBank(SR);
      const env = { context: ctx, bus: ctx.destination, bank, volume: () => 1, now: () => Date.now(), moduleUrl: '/static/js/modules/metronome/click_processor.js?rev=' + L.releases.playback, release: L.releases.playback, setTimeout: setTimeout.bind(window), clearTimeout: clearTimeout.bind(window) };
      const b = kind === 'worklet' ? L.playback.createWorkletBackend(env) : kind === 'chunk' ? L.playback.createChunkBackend(env) : L.playback.createMainBackend(env);
      await b.init();
      b.setGeneration(1);
      b.renewPermit(Math.round(SR * seconds) + SR, permit);
      b.schedule(events, 1);
      await new Promise((r) => setTimeout(r, 100)); // worklet messages before rendering
      const buf = await ctx.startRendering();
      const x = buf.getChannelData(0);
      // Onsets: first sample above the threshold after >= 2 ms of silence.
      const onsets = [];
      let quiet = 1000;
      for (let i = 0; i < x.length; i += 1) {
        if (Math.abs(x[i]) > 1e-5) {
          if (quiet >= 96) onsets.push(i);
          quiet = 0;
        } else quiet += 1;
      }
      let peak = 0;
      for (let i = 0; i < x.length; i += 1) peak = Math.max(peak, Math.abs(x[i]));
      return { onsets, peak };
    }
    const out = {};
    for (const kind of ['worklet', 'main', 'chunk']) {
      const r = await render(kind);
      // Each expected click is matched to the nearest detected onset.
      let maxErr = 0;
      const missingFrames = [];
      for (const f of expected) {
        let best = Infinity;
        for (const o of r.onsets) best = Math.min(best, Math.abs(o - f));
        if (best > 48) missingFrames.push(f); else maxErr = Math.max(maxErr, best);
      }
      // A click that starts inside the tail of an earlier one cannot be told
      // apart by this silence-based detector (overlap, not a missing click).
      const overlapped = missingFrames.filter((f) => expected.some((g) => g < f && f - g < 4800));
      out[kind] = { expected: expected.length, detected: r.onsets.length, onsets: r.onsets, missing: missingFrames.length - overlapped.length, overlapped: overlapped.length, missingFrames, maxErrorSamples: maxErr, peak: r.peak };
    }
    return out;
  });
  writeReport('offline', Object.fromEntries(Object.entries(result).map(([k, v]) => [k, { ...v, onsets: undefined }])));
  // The three backends render the same onsets (same event list, same samples).
  expect(result.main.onsets).toEqual(result.worklet.onsets);
  expect(result.chunk.onsets).toEqual(result.worklet.onsets);
  for (const kind of ['worklet', 'main', 'chunk']) {
    delete result[kind].onsets;
    expect(result[kind].missing, kind).toBe(0);
    expect(result[kind].maxErrorSamples, kind).toBeLessThanOrEqual(2);
    expect(result[kind].peak, kind).toBeLessThanOrEqual(1.0001); // no clipping at the bus input
  }
});

test('real time: stalls longer than the look-ahead drop late clicks (counted) and never catch up; reaction times', async ({ page }) => {
  test.setTimeout(120000);
  await loadEngine(page);
  const result = await page.evaluate(async () => {
    const L = window.PortalMetronomeLib;
    const R = L.rational;
    const busy = (ms) => { const end = performance.now() + ms; while (performance.now() < end) { /* main-thread stall */ } };
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const preset = L.scoreModel.defaultBasicPreset('00000000-0000-4000-8000-000000000001');
    preset.payload.tempo = { bpmTenths: 2400, reference: { n: 1, d: 4 } }; // 4 clicks per second
    const store = { [preset.id]: { 1: L.scoreModel.validatePreset(preset).preset } };
    const snap = L.scoreModel.buildSnapshot(store, preset.id, 1);
    const out = {};
    for (const kind of ['worklet', 'main', 'chunk']) {
      const manager = window.PortalAudioLib.outputManager.createOutputManager({ AudioContext: window.AudioContext, now: () => Date.now(), setTimeout: setTimeout.bind(window), clearTimeout: clearTimeout.bind(window), setInterval: setInterval.bind(window), clearInterval: clearInterval.bind(window) });
      await manager.prepareClaim();
      manager.unlockFromGesture();
      const ctx = manager.context();
      await ctx.resume();
      const lease = manager.acquire('metronome', 1).lease;
      const bank = L.sounds.createBank(ctx.sampleRate);
      const env = { context: ctx, bus: lease.bus, bank, volume: () => 0.05, now: () => Date.now(), moduleUrl: '/static/js/modules/metronome/click_processor.js?rev=' + L.releases.playback, release: L.releases.playback, setTimeout: setTimeout.bind(window), clearTimeout: clearTimeout.bind(window) };
      const backend = kind === 'worklet' ? L.playback.createWorkletBackend(env) : kind === 'chunk' ? L.playback.createChunkBackend(env) : L.playback.createMainBackend(env);
      await backend.init();
      await manager.renewPermit();
      const scheduledFrames = [];
      const original = backend.schedule;
      backend.schedule = (events, g) => { events.forEach((e) => scheduledFrames.push(e.frame)); return original.call(backend, events, g); };
      const tp = L.transport.createTransport({ backend, sampleRate: ctx.sampleRate, setTimeout: setTimeout.bind(window), clearTimeout: clearTimeout.bind(window), permit: () => manager.permit() });
      tp.load(snap, 1);
      const start = tp.start({ countInBars: 0 });
      const H = tp.horizonSeconds * 1000;
      const stalls = [];
      for (const factor of [0.5, 1, 1.5, 2, 'two-seconds']) {
        await wait(700);
        const ms = factor === 'two-seconds' ? 2000 : Math.round(H * factor);
        const t1 = backend.telemetry();
        const before = (t1.late || 0) + (t1.rejected || 0) + (t1.unpermitted || 0);
        busy(ms);
        await wait(600);
        const t2 = backend.telemetry();
        // Dropped clicks: late (past) or without a valid permit (expired during the stall).
        stalls.push({ stallMs: ms, factor, lateAdded: (t2.late || 0) + (t2.rejected || 0) + (t2.unpermitted || 0) - before, late: (t2.late || 0) - (t1.late || 0), unpermitted: (t2.unpermitted || 0) + (t2.rejected || 0) - (t1.unpermitted || 0) - (t1.rejected || 0) });
      }
      // Grid: every scheduled click is on the original 250 ms grid, none twice.
      const spacing = ctx.sampleRate / 4;
      const offGrid = scheduledFrames.filter((f) => Math.abs(((f - start.originFrame) / spacing) - Math.round((f - start.originFrame) / spacing)) > 1e-6).length;
      const duplicates = scheduledFrames.length - new Set(scheduledFrames).size;
      // MT-08 reaction: request -> applied (fence ack), pause -> cancel ack, stop.
      let t0 = performance.now();
      const fence = await tp.edit(L.scoreModel.buildSnapshot({ [preset.id]: { 1: Object.assign({}, L.scoreModel.validatePreset(Object.assign({}, preset, { payload: Object.assign({}, preset.payload, { tempo: { bpmTenths: 1200, reference: { n: 1, d: 4 } } }) })).preset) } }, preset.id, 1), 2, 'immediate');
      const editAckMs = performance.now() - t0;
      const fenceLeadMs = (fence.fenceFrame - backend.currentFrame()) / ctx.sampleRate * 1000;
      await wait(400);
      t0 = performance.now();
      const p = await tp.pause();
      const pauseAckMs = performance.now() - t0;
      const pauseLeadMs = (p.frame - backend.currentFrame()) / ctx.sampleRate * 1000;
      tp.resume({ countInBars: 0 });
      await wait(300);
      t0 = performance.now();
      tp.stop();
      const stopMs = performance.now() - t0;
      await wait(100);
      const afterStop = backend.telemetry();
      backend.dispose();
      manager.shutdown();
      out[kind] = { horizonMs: H, stalls, offGrid, duplicates, editAccepted: fence.accepted === true, editAckMs, fenceLeadMs, pauseAckMs, pauseLeadMs, stopMs, queuedAfterStop: afterStop.queued };
    }
    return out;
  });
  writeReport('realtime', result);
  for (const kind of ['worklet', 'main', 'chunk']) {
    const r = result[kind];
    expect(r.duplicates, kind).toBe(0); // no click scheduled twice
    expect(r.offGrid, kind).toBe(0); // the phase never shifts after a stall
    expect(r.editAccepted, kind).toBe(true);
    // A stall clearly longer than the look-ahead loses clicks (counted, not squeezed in).
    expect(r.stalls.find((s) => s.factor === 'two-seconds').lateAdded, kind).toBeGreaterThan(0);
  }
});
