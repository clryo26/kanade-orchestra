// Local synthetic baseline: real loader/dispatcher, counted leaf calls, no live data.
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createCdeHarness, deferred } = require('../tests/frontend/helpers/portal_cde_harness.cjs');
async function run() {
    const report = { phase: process.argv[2], mode: 'Node VM, synthetic API, real loader/member dispatcher',
        dbQueries: null, gcsRequests: null, browserVerified: false, metrics: [] };
    const all = process.argv.includes('--collections');
    const sources = report.phase === 'before' && all ? {
        loader: execFileSync('git', ['show', 'eef4434:src/static/js/modules/bootstrap_loader.js'], { encoding: 'utf8' }),
        members: execFileSync('git', ['show', 'eef4434:src/static/js/modules/members/render.js'], { encoding: 'utf8' }),
    } : {};
    const collections = all ? ['absences', 'eventResponses', 'dateAdjustments', 'dateAdjustmentResponses', 'sheets',
        'payments', 'castings', 'pieceInfos', 'practiceInstructions', 'performanceDayInfos', 'desiredPieces',
        'promotions', 'albums', 'partSettings', 'venueSettings', 'flyerDistributions', 'flyerDistributionAssignments',
        'concertRecordVideos', 'orgSettings', 'snsSettings', 'connectionSettings'] : ['albums'];
    for (const collection of collections) for (const size of all ? [0, 1, 30, 60] : [30, 60]) {
        const fixture = Array.from({ length: size }, (_, i) => ({ id: i + 1, title: `Synthetic ${i}` }));
        for (let repeat = 0; repeat < 5; repeat++) {
            const gate = deferred();
            const h = createCdeHarness(() => gate.promise, sources);
            const pending = Promise.all([h.ctx.loadExtraData([collection]), h.ctx.loadExtraData([collection])]);
            gate.resolve(collection === 'sheets' ? { files: fixture } : fixture);
            await pending;
            report.metrics.push({ id: 'C01', collection, rows: size, repeat, sends: h.sends.length,
                applications: h.applied[collection === 'sheets' ? 'sheetLibrary' : collection], leafCalls: h.counts });
        }
    }
    const files = ['src/static/js/modules/bootstrap_loader.js', 'src/static/js/modules/members/render.js', 'src/static/js/utils/cache.js'];
    const hashSource = f => report.phase === 'before' && all ? execFileSync('git', ['show', `eef4434:${f}`]) : fs.readFileSync(f);
    report.sourceSha256 = Object.fromEntries(files.map(f => [f, crypto.createHash('sha256').update(hashSource(f)).digest('hex')]));
    report.baselineSource = report.phase === 'before' && all ? 'replayed immutable eef4434 source' : null;
    const dest = path.resolve(process.argv[3] || '');
    if (!dest.startsWith(path.resolve('.tmp/perf_stage2_cde') + path.sep)) throw new Error('Use .tmp/perf_stage2_cde output');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const { metrics, ...header } = report;
    // Preserve every sample on one line to keep repeated counters reviewable.
    const serialized = all ? JSON.stringify(header, null, 2).slice(0, -2)
        + ',\n  "metrics": [\n' + metrics.map(row => '    ' + JSON.stringify(row)).join(',\n') + '\n  ]\n}\n'
        : JSON.stringify(report, null, 2) + '\n';
    fs.writeFileSync(dest, serialized);
    console.log(JSON.stringify({ phase: report.phase, samples: report.metrics.length, sample: report.metrics[0] }));
}
run().catch(e => { console.error(e); process.exitCode = 1; });
