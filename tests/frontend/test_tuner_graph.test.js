import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const root = process.cwd();
const graph = require(path.join(root, 'src/static/js/modules/tuner/graph.js'));

function linearLogAxis(range, width) {
  const span = Math.log(range.max / range.min);
  return (f) => (width * Math.log(f / range.min)) / span;
}

describe('spectrum display ranges', () => {
  it('offers "倍音重視" 500 Hz-16 kHz (default) and "全音域" 25 Hz-16 kHz', () => {
    expect(graph.DEFAULT_DISPLAY_RANGE).toBe('harmonics');
    expect(graph.DISPLAY_RANGES.harmonics).toMatchObject({ label: '倍音重視', min: 500, max: 16000 });
    expect(graph.DISPLAY_RANGES.full).toMatchObject({ label: '全音域', min: 25, max: 16000 });
    expect(graph.resolveRange('unknown')).toBe(graph.DISPLAY_RANGES.harmonics);
  });

  it('limits measurable data to the lower of the display max and Nyquist', () => {
    const range = graph.DISPLAY_RANGES.harmonics;
    expect(graph.measurableLimit(range, 22050)).toBe(16000); // 44.1 kHz
    expect(graph.measurableLimit(range, 24000)).toBe(16000); // 48 kHz
    expect(graph.measurableLimit(range, 8000)).toBe(8000); // 16 kHz device: no data above 8 kHz
    expect(graph.measurableLimit(range, 0)).toBe(16000);
  });

  it('thins tick labels so they do not overlap on a narrow phone', () => {
    const full = graph.DISPLAY_RANGES.full;
    const narrow = graph.visibleTicks(full, linearLogAxis(full, 280));
    expect(narrow.map((t) => t.frequency)).toEqual([25, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 16000]);
    const labelled = narrow.filter((t) => t.label);
    for (let i = 1; i < labelled.length; i += 1) {
      expect(labelled[i].x - labelled[i - 1].x).toBeGreaterThanOrEqual(graph.MIN_TICK_LABEL_SPACING);
    }
    expect(labelled[0].label).toBe('25');
    const harmonics = graph.visibleTicks(graph.DISPLAY_RANGES.harmonics, linearLogAxis(graph.DISPLAY_RANGES.harmonics, 280));
    expect(harmonics[0].frequency).toBe(500);
    expect(harmonics.every((t) => t.frequency >= 500 && t.frequency <= 16000)).toBe(true);
  });

  it('marks harmonics inside the range, also for a fundamental below the range', () => {
    const range = graph.DISPLAY_RANGES.harmonics;
    const x = linearLogAxis(range, 300);
    const markers = graph.harmonicMarkers(110, range, 16000, x, 4);
    expect(markers[0]).toMatchObject({ number: 5, frequency: 550 }); // first multiple >= 500 Hz
    expect(markers.every((m) => m.frequency >= 500 && m.frequency <= 16000)).toBe(true);
    for (let i = 1; i < markers.length; i += 1) expect(markers[i].x - markers[i - 1].x).toBeGreaterThanOrEqual(4);
    // Nyquist-limited device: nothing above the measurable limit.
    expect(graph.harmonicMarkers(2000, range, 8000, x, 4).map((m) => m.frequency)).toEqual([4000, 6000, 8000]);
    expect(graph.harmonicMarkers(0, range, 16000, x, 4)).toEqual([]);
  });

  it('drops spectrum frames that belong to another display axis', () => {
    const canvas = { getContext: () => null, clientWidth: 300, clientHeight: 200 };
    const g = graph.createSpectrumGraph(canvas);
    g.setRange('full', 7);
    const frequencies = new Array(512).fill(0).map((_, i) => 25 * (16000 / 25) ** (i / 511));
    expect(g.setAxis({ axisId: 6, frequencies })).toBe(false); // stale axis answer
    expect(g.setAxis({ axisId: 7, frequencies, nyquist: 24000 })).toBe(true);
    expect(g.setSpectrum({ axisId: 6, display: new Float32Array(512) })).toBe(false);
    expect(g.setSpectrum({ axisId: 7, display: new Float32Array(512) })).toBe(true);
    g.setRange('harmonics', 8);
    expect(g.setSpectrum({ axisId: 7, display: new Float32Array(512) })).toBe(false); // waits for axis 8
    expect(g.getRange().id).toBe('harmonics');
  });
});
