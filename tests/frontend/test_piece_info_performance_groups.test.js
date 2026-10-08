const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup(performances) {
    const state = { performances, pieceInfos: [], selectedPieceInfoContext: null };
    const container = { innerHTML: '', querySelectorAll: () => [], addEventListener: () => {} };
    const sandbox = {
        window: { portalRuntimeContext: { appState: state, today: () => '2026-10-08', getById: () => container } },
        formatDateWithWeekday: (value) => value || 'no date',
        convertUrlsToLinks: (value) => value,
        escapeHtml: (value) => String(value).replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    };
    vm.createContext(sandbox);
    for (const file of ['common_helpers/pure.js', 'date_piece_promotion/render_piece_practice.js']) {
        vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../src/static/js/modules', file), 'utf8'), sandbox);
    }
    // このテストでは日付装飾ではなく順序と折りたたみを検証する。
    sandbox.formatDateWithWeekday = (value) => value || 'no date';
    return { state, container, sandbox };
}

describe('piece info performance groups', () => {
    const performances = [
        { id: 1, date: '2025-01-01', title: 'old', pieces: [{ title: 'old piece' }] },
        { id: 2, date: '2026-10-10', title: 'nearest', pieces: [{ title: 'new piece' }] },
        { id: 3, date: '2027-01-01', title: 'future', pieces: [] },
        { id: 4, date: '2026-09-01', title: 'recent', pieces: [] },
    ];
    const groups = (html) => [...html.matchAll(/<details class="mb-3 piece-info-performance-group"([^>]*)><summary>(.*?)<\/summary>/g)].map((match) => ({ open: match[1].includes('open'), heading: match[2] }));

    test('includes past performances, sorts like the sheet library, and collapses past groups', () => {
        const view = setup(performances);
        view.sandbox.renderPieceInfoView();
        expect(groups(view.container.innerHTML)).toEqual([
            { open: true, heading: '2026-10-10 nearest' },
            { open: true, heading: '2027-01-01 future' },
            { open: false, heading: '2026-09-01 recent' },
            { open: false, heading: '2025-01-01 old' },
        ]);
        expect(view.container.innerHTML).toContain('old piece');
        expect(performances.map((perf) => perf.id)).toEqual([1, 2, 3, 4]);
    });

    test('today is upcoming and undated performances sort last', () => {
        const view = setup([...performances, { id: 5, date: '2026-10-08', title: 'today' }, { id: 6, date: '', title: '<undated>' }]);
        view.sandbox.renderPieceInfoView();
        const result = groups(view.container.innerHTML);
        expect(result[0]).toEqual({ open: true, heading: '2026-10-08 today' });
        expect(result.at(-1).heading).toBe('no date &lt;undated&gt;');
    });

    test('past-only performances remain visible descending, including selected past detail', () => {
        const view = setup([performances[0], performances[3]]);
        view.sandbox.renderPieceInfoView();
        expect(groups(view.container.innerHTML).map((group) => group.heading)).toEqual(['2026-09-01 recent', '2025-01-01 old']);
        view.state.selectedPieceInfoContext = { performanceId: '1', piece: 'old piece' };
        view.state.pieceInfos = [{ performance_id: 1, piece: 'old piece', description: 'saved intro' }];
        view.sandbox.renderPieceInfoView();
        expect(view.state.selectedPieceInfoContext).not.toBeNull();
        expect(view.container.innerHTML).toContain('saved intro');
    });

    test('empty performance list clears obsolete selection', () => {
        const view = setup([]);
        view.state.selectedPieceInfoContext = { performanceId: '1', piece: 'old piece' };
        view.sandbox.renderPieceInfoView();
        expect(view.state.selectedPieceInfoContext).toBeNull();
        expect(view.container.innerHTML).toContain('演奏会はありません');
    });
});
