const vm = require('node:vm');
const fs = require('node:fs');
function renderConcert(source, performances, videos) {
    let comparisons = 0;
    const container = { innerHTML: '' };
    const state = { performances, concertRecordVideos: videos };
    const ctx = { appState: state, $: () => container,
        String: value => { comparisons++; return String(value); },
        escapeHtml: value => String(value), formatDateWithWeekday: value => value };
    const start = source.indexOf('function renderConcertRecordView()');
    const end = source.indexOf('\n// renderMemberIntros', start);
    if (start < 0 || end < 0) throw new Error('Concert entry boundary changed');
    vm.createContext(ctx); vm.runInContext(source.slice(start, end), ctx);
    const began = performance.now(); ctx.renderConcertRecordView();
    return { html: container.innerHTML, comparisons, elapsedMs: performance.now() - began };
}
const currentSource = () => fs.readFileSync('src/static/js/modules/portal_views.js', 'utf8');
module.exports = { renderConcert, currentSource };
