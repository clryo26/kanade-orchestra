import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const dir = path.join(process.cwd(), 'src/static/js/modules/tuner');
const C = require(path.join(dir, 'session_coordinator.js'));
const M = require(path.join(dir, 'measurement_store.js'));

describe('session coordinator', () => {
  it('exclusive by default: no output while capturing, no capture while playing', () => {
    const c = C.createSessionCoordinator();
    expect(c.setCapture('starting')).toBe(true);
    expect(c.setCapture('running')).toBe(true);
    expect(c.outputPolicy()).toEqual({ allowed: true, stopCapture: true, simultaneous: false });
    expect(c.setOutput('playing')).toBeNull();
    c.setCapture('stopped');
    expect(c.setOutput('playing')).toBe(1);
    expect(c.setCapture('running')).toBe(false);
  });

  it('simultaneous mode needs the explicit switch and the earphone declaration', () => {
    const c = C.createSessionCoordinator();
    c.setSimultaneous(true, false);
    c.setCapture('running');
    expect(c.setOutput('playing')).toBeNull();
    c.setSimultaneous(true, true);
    expect(c.outputPolicy()).toMatchObject({ stopCapture: false, simultaneous: true });
    expect(c.setOutput('playing')).not.toBeNull();
    expect(c.setSimultaneous(false).earphonesDeclared).toBe(false);
  });

  it('leave stops everything, invalidates playback/save generations and resets the mode', () => {
    const c = C.createSessionCoordinator();
    c.setSimultaneous(true, true);
    c.setCapture('starting');
    c.setCapture('running');
    const gen = c.setOutput('playing');
    const save = c.nextSaveGeneration();
    c.setPractice('performing');
    c.setDisplayFrozen(true);
    c.leave('background');
    const s = c.get();
    expect(s).toMatchObject({ capture: 'stopped', output: 'idle', simultaneous: false, earphonesDeclared: false, displayFrozen: false, practice: 'interrupted' });
    expect(c.isCurrentPlayback(gen)).toBe(false);
    expect(c.isCurrentSave(save)).toBe(false);
    expect(s.ids.captureEpoch).toBe(1);
    expect(c.history().at(-1)).toMatchObject({ type: 'leave', value: 'background' });
  });

  it('each microphone start is a new capture epoch; invalid states are refused', () => {
    const c = C.createSessionCoordinator();
    c.setCapture('starting');
    c.setCapture('paused');
    c.setCapture('starting');
    expect(c.get().ids.captureEpoch).toBe(2);
    expect(c.setCapture('recording')).toBe(false);
    expect(c.setOutput('loud')).toBeNull();
    expect(c.nextOwnerEpoch()).toBe(1);
  });
});

describe('measurement store', () => {
  const SR = 48000;
  const frame = (f2, extra = {}) => Object.assign({ captureEpoch: 1, effectiveFrame2: f2, analysisEndFrameExclusive: Math.ceil(f2 / 2) + 2048, frequencyHz: 440, confidence: 0.9, rmsDbfs: -30, qualityFlags: 0, invalidReason: 0, windowSamples: 4096 }, extra);

  it('releases frames of different windows in effective-time order and keeps late frames marked', () => {
    const s = M.createMeasurementStore();
    s.beginEpoch({ captureEpoch: 1, sampleRate: SR, maxWindowSamples: 8192 });
    const seen = [];
    s.onConfirmed((e) => { if (e.type === 'pitch') seen.push(e.frame.effectiveFrame2); });
    // A long-window result (earlier effective time) arrives after short-window ones.
    s.pushPitch(frame(100000, { windowSamples: 1024 }));
    s.pushPitch(frame(98000, { windowSamples: 8192 }));
    for (let k = 1; k <= 20; k += 1) s.pushPitch(frame(100000 + k * 2400));
    expect(seen.slice(0, 2)).toEqual([98000, 100000]);
    const released = seen.at(-1);
    s.pushPitch(frame(released - 10)); // too late: stored, not re-fed live
    expect(seen.includes(released - 10)).toBe(false);
    s.flush();
    const snap = s.snapshot();
    const lateIndex = Array.from(snap.series.frame2).indexOf(released - 10);
    expect(snap.series.late[lateIndex]).toBe(1);
    expect(Array.from(snap.series.frame2)).toEqual(Array.from(snap.series.frame2).slice().sort((a, b) => a - b));
  });

  it('missing values stay NaN (never 0 Hz); other epochs are not mixed', () => {
    const s = M.createMeasurementStore();
    s.beginEpoch({ captureEpoch: 1, sampleRate: SR });
    s.pushPitch(frame(1000, { frequencyHz: null, invalidReason: 3 }));
    expect(s.pushPitch(frame(2000, { captureEpoch: 0 }))).toBe(false); // old epoch dropped
    s.beginEpoch({ captureEpoch: 2, sampleRate: 44100 });
    s.pushPitch(frame(5000, { captureEpoch: 2 }));
    s.flush();
    const one = s.snapshot({ epoch: 1 });
    expect(one.series.frame2.length).toBe(1);
    expect(Number.isNaN(one.series.hz[0])).toBe(true);
    expect(one.series.reason[0]).toBe(3);
    expect(s.snapshot({ epoch: 2 }).series.sampleRate).toBe(44100);
  });

  it('counts frames lost when the ring is full and keeps the newest', () => {
    const s = M.createMeasurementStore({ pitchCapacity: 10 });
    s.beginEpoch({ captureEpoch: 1, sampleRate: SR, maxWindowSamples: 1 });
    for (let k = 0; k < 25; k += 1) s.pushPitch(frame(k * 4000, { analysisEndFrameExclusive: k * 2000 + 1 }));
    s.flush();
    expect(s.frameCount()).toBe(10);
    expect(s.lostPitchFrames()).toBe(15);
    expect(s.totalPitchFrames()).toBe(25);
    expect(s.snapshot().series.frame2[0]).toBe(15 * 4000);
  });

  it('gaps, intervals and boundaries are annotations; snapshots are independent copies', () => {
    const s = M.createMeasurementStore();
    s.beginEpoch({ captureEpoch: 1, sampleRate: SR });
    s.pushPitch(frame(1000));
    s.markGap(1, 3000, 2);
    const it = s.addInterval('playback', 4000, Infinity, { generation: 3 });
    s.closeInterval(it, 9000);
    s.addBoundary('targetChange', 5000, { midi: 60 });
    s.pushPitch(frame(6000));
    s.flush();
    const snap = s.snapshot();
    expect(snap.gaps).toEqual([3000]);
    expect(snap.intervals[0]).toMatchObject({ kind: 'playback', startFrame2: 4000, endFrame2: 9000 });
    expect(snap.boundaries[0]).toMatchObject({ type: 'targetChange', frame2: 5000 });
    expect(Array.from(snap.series.hz)).toEqual([440, 440]); // raw values untouched
    snap.series.hz[0] = 0;
    expect(s.snapshot().series.hz[0]).toBe(440);
  });
});
