// PERF-R28/R29: compare exact fixed-environment screenshots and visible DOM.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const [beforeArg, afterArg, outputArg] = process.argv.slice(2);
if (!beforeArg || !afterArg || !outputArg) throw new Error('Usage: node scripts/perf_stage1_compare.cjs BEFORE AFTER OUTPUT');
const before = path.resolve(beforeArg), after = path.resolve(afterArg);
const read = dir => JSON.parse(fs.readFileSync(path.join(dir, 'report.json')));
const b = read(before), a = read(after);
for (const key of ['platform', 'node', 'browser', 'image', 'fixedTime', 'captureOnly']) {
  if (b[key] !== a[key]) throw new Error(`Incompatible capture environment: ${key}`);
}
if (b.platform !== 'linux' || !b.image || !a.image) throw new Error('Formal comparison requires a pinned Linux image');
if (JSON.stringify(b.assetHashes) !== JSON.stringify(a.assetHashes)) throw new Error('External fixture assets changed');
if (b.errors.length || a.errors.length) throw new Error('Capture contains browser errors');
const expected = b.cases.flatMap(c => c.screenshots.flatMap(name => ['png', 'json'].map(ext => `${c.permission}-${name}.${ext}`)));
const actual = a.cases.flatMap(c => c.screenshots.flatMap(name => ['png', 'json'].map(ext => `${c.permission}-${name}.${ext}`)));
if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error('Screenshot case sets differ');
const comparisons = expected.map(file => {
  const left = fs.readFileSync(path.join(before, file)), right = fs.readFileSync(path.join(after, file));
  return { file, equal: left.equals(right), beforeSha256: crypto.createHash('sha256').update(left).digest('hex'),
    afterSha256: crypto.createHash('sha256').update(right).digest('hex') };
});
const report = { beforeCommit: b.sourceCommit, afterCommit: a.sourceCommit, comparisons,
  previewObjectUrls: b.cases.map((c, i) => ({ permission: c.permission, before: c.previewObjectUrls, after: a.cases[i].previewObjectUrls })) };
fs.writeFileSync(outputArg, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ equal: comparisons.filter(c => c.equal).length, total: comparisons.length, previewObjectUrls: report.previewObjectUrls }, null, 2));
if (comparisons.some(c => !c.equal)) process.exitCode = 1;
