const fs = require('node:fs');
const crypto = require('node:crypto');
const { renderConcert, currentSource } = require('../tests/frontend/helpers/concert_record_harness.cjs');
const metrics = [];
for (const scale of [1, 2]) {
    const performances = Array.from({ length: 10 * scale }, (_, i) => ({ id: i + 1, title: `Synthetic ${i}`, date: '2026-12-01' }));
    const videos = Array.from({ length: 30 * scale }, (_, i) => ({ id: i + 1, performance_id: i % performances.length + 1, sort_order: 30 - i }));
    for (let repeat = 0; repeat < 5; repeat++) {
        const result = renderConcert(currentSource(), performances, videos);
        metrics.push({ scale, repeat, comparisons: result.comparisons, elapsedMs: result.elapsedMs,
            htmlSha256: crypto.createHash('sha256').update(result.html).digest('hex') });
    }
}
fs.writeFileSync(`.tmp/perf_stage2_cde/r12_${process.argv[2]}.json`, JSON.stringify({ mode: 'real renderer, synthetic DOM sink, counted String key comparisons', metrics }, null, 2) + '\n');
console.log(metrics.map(({ scale, comparisons }) => ({ scale, comparisons })).filter((_, i) => i % 5 === 0));
