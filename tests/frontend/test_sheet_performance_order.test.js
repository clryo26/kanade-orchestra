const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createSandbox(performances) {
    const state = { performances, sheetLibrary: [], sheetFilters: {}, selectedSheetIds: [] };
    const container = { innerHTML: '', querySelectorAll: () => [], addEventListener: () => {} };
    const sandbox = {
        URLSearchParams,
        window: { portalRuntimeContext: { appState: state, today: () => '2026-10-08', getById: () => container } },
        escapeHtml: String,
        groupBy: (items, key) => items.reduce((groups, item) => {
            (groups[item[key]] ||= []).push(item);
            return groups;
        }, {}),
        bindSheetLibraryFilters: () => {},
        displayNameWithoutExtension: String,
        partOptionHtml: () => '',
    };
    vm.createContext(sandbox);
    for (const file of ['common_helpers/pure.js', 'admin_system/helpers.js', 'scores/helpers.js']) {
        vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../src/static/js/modules', file), 'utf8'), sandbox);
    }
    return { sandbox, state, container };
}

describe('sheet performance order', () => {
    const performances = [
        { id: 1, date: '2025-12-01', title: 'old' },
        { id: 2, date: '2026-10-10', title: 'nearest' },
        { id: 3, date: '2027-04-01', title: 'future' },
        { id: 4, date: '2026-09-01', title: 'recent' },
        { id: 5, date: '', title: 'undated' },
        { id: 6, date: '2026-02-30', title: 'invalid' },
    ];

    test('promotes only the nearest upcoming performance without changing input', () => {
        const { sandbox } = createSandbox(performances);
        const ids = ['1', '2', '3', '4', '5', '6', '99'];
        expect(Array.from(sandbox.sortedSheetPerformanceIds(ids))).toEqual(['2', '3', '4', '1', '5', '6', '99']);
        expect(ids).toEqual(['1', '2', '3', '4', '5', '6', '99']);
    });

    test('includes today, preserves same-date order, and limits candidates to supplied IDs', () => {
        const { sandbox } = createSandbox([...performances, { id: 7, date: '2026-10-08' }, { id: 8, date: '2026-10-08' }]);
        expect(Array.from(sandbox.sortedSheetPerformanceIds(['3', '7', '8', '2']))).toEqual(['7', '3', '2', '8']);
        expect(Array.from(sandbox.sortedSheetPerformanceIds(['3', '1']))).toEqual(['3', '1']);
    });

    test('sorts past performances descending when none are upcoming', () => {
        const { sandbox } = createSandbox(performances);
        expect(Array.from(sandbox.sortedSheetPerformanceIds(['1', '5', '4']))).toEqual(['4', '1', '5']);
        expect(Array.from(sandbox.sortedSheetPerformanceIds([]))).toEqual([]);
    });

    test.each(['scores/render.js', 'scores.js'])('renders the list and filter in the same order: %s', (file) => {
        const { sandbox, state, container } = createSandbox(performances);
        state.sheetLibrary = performances.map((perf) => ({ id: perf.id, performance_id: perf.id, piece: '', name: 'score' }));
        vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../src/static/js/modules', file), 'utf8'), sandbox);
        sandbox.renderSheetLibraryView();
        const headings = [...container.innerHTML.matchAll(/<strong class="sheet-library-heading">(.*?)<\/strong>/g)].map((match) => match[1]);
        expect(headings).toEqual(['nearest', 'future', 'recent', 'old', 'undated', 'invalid']);
        const options = [...sandbox.sheetFilterPerformanceOptions().matchAll(/<option value="(\d+)"/g)].map((match) => match[1]);
        expect(options).toEqual(['2', '3', '4', '1', '5', '6']);
        // 先頭の演奏会だけ曲名を見せ、曲単位の楽譜一覧は閉じておく。
        const performanceDetails = [...container.innerHTML.matchAll(/<details class="[^"]*sheet-performance-details"([^>]*)>/g)];
        expect(performanceDetails.map((match) => /\bopen\b/.test(match[1]))).toEqual([true, false, false, false, false, false]);
        const pieceDetails = [...container.innerHTML.matchAll(/<details class="[^"]*sheet-piece-details"([^>]*)>/g)];
        expect(pieceDetails).toHaveLength(6);
        expect(pieceDetails.every((match) => !/\bopen\b/.test(match[1]))).toBe(true);

        // 絞り込み後も表示される演奏会の先頭を展開する。
        state.sheetFilters.performanceId = '4';
        sandbox.renderSheetLibraryView();
        const filteredDetails = [...container.innerHTML.matchAll(/<details class="[^"]*sheet-performance-details"([^>]*)>/g)];
        expect(filteredDetails).toHaveLength(1);
        expect(filteredDetails[0][1]).toContain('open');
    });
    test.each(['scores/render.js', 'scores.js'])('sorts admin performance options and existing sheet groups: %s', (file) => {
        const { sandbox, state, container } = createSandbox(performances);
        const select = { value: '4', innerHTML: '' };
        sandbox.window.portalRuntimeContext.getById = (id) => id === 'sheetPerformanceSelect' ? select : id === 'sheetAdminList' ? container : null;
        // 楽譜未登録の演奏会も選択欄に残し、登録済み一覧はライブラリと一致させる。
        state.performances = [...performances, { id: 7, date: '2028-01-01', title: 'no sheets' }];
        state.sheetLibrary = performances.map((perf) => ({ id: perf.id, performance_id: perf.id, name: 'score' }));
        vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../src/static/js/modules', file), 'utf8'), sandbox);
        sandbox.renderSheetAdmin();
        const options = [...select.innerHTML.matchAll(/<option value="(\d+)"/g)].map((match) => match[1]);
        expect(options).toEqual(['2', '7', '3', '4', '1', '5', '6']);
        expect(select.value).toBe('4');
        expect(select.innerHTML).toMatch(/value="4" selected/);
        const headings = [...container.innerHTML.matchAll(/<h5 class="mb-0">(.*?)<\/h5>/g)].map((match) => match[1]);
        expect(headings).toEqual(['nearest', 'future', 'recent', 'old', 'undated', 'invalid']);
    });
    test.each(['scores/render.js', 'scores.js'])('sorts sheets within each piece by configured parts in both views: %s', (file) => {
        const { sandbox, state, container } = createSandbox(performances);
        state.partSettings = [{ name: 'Violin', display_order: 20 }, { name: 'Flute', display_order: 10 }];
        const sheets = [
            { id: 1, part: 'Violin' }, { id: 2, part: '' }, { id: 3, part: 'Flute' },
            { id: 4, part: 'Flute' }, { id: 5 }, { id: 6, part: 'Retired part' },
        ].map((sheet) => ({ ...sheet, performance_id: 2, piece: 'piece', name: `score-${sheet.id}` }));
        state.sheetLibrary = sheets;
        vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../src/static/js/modules', file), 'utf8'), sandbox);
        sandbox.renderSheetLibraryView();
        const memberIds = [...container.innerHTML.matchAll(/data-sheet-view="(\d+)"/g)].map((match) => match[1]);
        expect(memberIds).toEqual(['2', '5', '3', '4', '1', '6']);
        sandbox.renderSheetAdminList();
        const adminIds = [...container.innerHTML.matchAll(/class="form-check-input sheet-select-checkbox" data-sheet-id="(\d+)"/g)].map((match) => match[1]);
        expect(adminIds).toEqual(memberIds);
        expect(sheets.map((sheet) => sheet.id)).toEqual([1, 2, 3, 4, 5, 6]);
        state.partSettings[0].display_order = 5;
        expect(Array.from(sandbox.sortedSheetsByPart(sheets), (sheet) => sheet.id)).toEqual([2, 5, 1, 3, 4, 6]);
    });
});
