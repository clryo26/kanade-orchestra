import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { THIRD_MARKERS, meterMarkerPercent } = require(path.join(process.cwd(), 'src/static/js/modules/tuner/view.js'));

describe('pure-third reference positions on the equal-temperament meter', () => {
  it('exports both pure-third offsets with their stable identifiers', () => {
    expect(THIRD_MARKERS.map((marker) => marker.id)).toEqual(['major-third', 'minor-third']);
    expect(THIRD_MARKERS[0].cents).toBeCloseTo(-13.686286, 3);
    expect(THIRD_MARKERS[1].cents).toBeCloseTo(15.641287, 3);
  });

  it.each([[50, 36.3137, 65.6413], [25, 22.6274, 81.2826], [100, 43.1569, 57.8206]])('places markers linearly at range ±%i', (range, major, minor) => {
    expect(meterMarkerPercent(THIRD_MARKERS[0].cents, range)).toBeCloseTo(major, 3);
    expect(meterMarkerPercent(THIRD_MARKERS[1].cents, range)).toBeCloseTo(minor, 3);
  });

  it('hides both markers outside ±10 cent and includes the exact endpoints', () => {
    for (const marker of THIRD_MARKERS) expect(meterMarkerPercent(marker.cents, 10)).toBeNull();
    expect(meterMarkerPercent(-10, 10)).toBe(0);
    expect(meterMarkerPercent(10, 10)).toBe(100);
    expect(meterMarkerPercent(0, 0)).toBeNull();
  });
});
