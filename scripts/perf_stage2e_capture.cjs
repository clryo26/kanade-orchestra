const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { createCacheHarness } = require('../tests/frontend/helpers/portal_cache_harness.cjs');
async function main() {
    const before = process.argv[2] === 'before';
    const source = before ? execFileSync('git', ['show', 'eef4434:src/static/js/utils/cache.js'], { encoding: 'utf8' })
        : fs.readFileSync('src/static/js/utils/cache.js', 'utf8');
    const h = createCacheHarness(source); await h.cache.init();
    try {
        const now = Date.now();
        await h.seed(Array.from({ length: 205 }, (_, i) => ({ key: `/api/fixture/${String(i).padStart(3, '0')}`,
            timestamp: now - (i < 5 ? 8 * 86400000 : i * 1000), data: [{ id: i, title: 'synthetic' }] })));
        const initial = await h.records();
        const started = performance.now();
        const cleanup = h.cache.cleanup ? await h.cache.cleanup() : null;
        const elapsedMs = performance.now() - started;
        const remaining = await h.records();
        fs.mkdirSync('.tmp/perf_stage2_cde', { recursive: true });
        fs.writeFileSync(`.tmp/perf_stage2_cde/e2_${before ? 'before' : 'after'}.json`, JSON.stringify({
            phase: before ? 'before (committed eef4434 source)' : 'after (working source)',
            mode: 'fake-indexeddb, 205 synthetic response records, 5 expired',
            initialCount: initial.length, remainingCount: remaining.length,
            initialApproximateBytes: initial.reduce((sum, e) => sum + JSON.stringify(e.data).length * 2, 0),
            remainingApproximateBytes: remaining.reduce((sum, e) => sum + JSON.stringify(e.data).length * 2, 0),
            cleanup, elapsedMs, browserVerified: false, physicalStorageBytes: null,
        }, null, 2) + '\n');
        console.log({ before, initial: initial.length, remaining: remaining.length });
    } finally { h.cache.db.close(); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
