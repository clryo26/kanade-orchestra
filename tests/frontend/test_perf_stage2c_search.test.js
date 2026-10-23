const crypto = require('node:crypto');
const { renderConcert, currentSource } = require('./helpers/concert_record_harness.cjs');
// Captured with the real pre-C renderer; also works in shallow CI checkouts.
const { fixtures } = require('./fixtures/perf_stage2c_concert_baseline.json');

test.each([0, 1, 30, 60])('grouped lookup preserves exact HTML, sort and source arrays for %i videos', size => {
    const performances = [{ id: 2, title: 'B' }, { id: 1, title: 'A' }, { id: 3, title: 'empty' }];
    const videos = Array.from({ length: size }, (_, i) => Object.freeze({ id: i + 1,
        performance_id: i % 2 ? '1' : 2, sort_order: i % 3, title: `Video ${i}` }));
    Object.freeze(videos);
    const after = renderConcert(currentSource(), performances, videos);
    expect(crypto.createHash('sha256').update(after.html).digest('hex')).toBe(fixtures[size].htmlSha256);
    if (size > 1) expect(after.comparisons).toBeLessThan(fixtures[size].comparisons);
});

test('next render observes replacements/deletions without a persistent index', () => {
    const performances = [{ id: 1, title: 'A' }];
    expect(renderConcert(currentSource(), performances, [{ id: 1, performance_id: 1, title: 'keep' }]).html).toContain('keep');
    expect(renderConcert(currentSource(), performances, []).html).not.toContain('card-title');
});
