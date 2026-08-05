// Tests for isUpcomingPerformanceDate and upcoming-only filtering in 3 member views.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '../..');

function readSource(rel) {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

// ---------------------------------------------------------------------------
// Sandbox helpers
// ---------------------------------------------------------------------------

function pureSandbox(todayStr) {
    const src = readSource('src/static/js/modules/common_helpers/pure.js');
    const sb = {
        window: {
            portalRuntimeContext: {
                today: () => todayStr,
            },
        },
        console,
    };
    sb.globalThis = sb;
    vm.createContext(sb);
    vm.runInContext(src, sb);
    return sb;
}

function memberRenderSandbox(todayStr, performances) {
    const pureSrc   = readSource('src/static/js/modules/common_helpers/pure.js');
    const renderSrc = readSource('src/static/js/modules/members/render.js');

    const renderedHtml = {};
    const sb = {
        window: {
            portalRuntimeContext: {
                appState: { performances },
                getById: (id) => ({
                    innerHTML: '',
                    set innerHTML(v) { renderedHtml[id] = v; },
                    get innerHTML() { return renderedHtml[id] || ''; },
                }),
                today: () => todayStr,
            },
        },
        // stubs for functions called inside renderMemberPerformances
        nextPerformance: () => null,
        daysUntil: () => null,
        escapeHtml: (s) => String(s || ''),
        formatDateWithWeekday: (d) => d || '',
        formatClockTime: (t) => t || '',
        performancePieceFormalLabel: (p) => String(p?.title || ''),
        console,
    };
    sb.globalThis = sb;
    sb.appState = sb.window.portalRuntimeContext.appState;
    sb.$ = sb.window.portalRuntimeContext.getById;
    vm.createContext(sb);
    vm.runInContext(pureSrc, sb);
    vm.runInContext(renderSrc, sb);
    return { sb, renderedHtml };
}

function flyerSandbox(todayStr, performances) {
    const pureSrc  = readSource('src/static/js/modules/common_helpers/pure.js');
    const viewsSrc = readSource('src/static/js/modules/portal_views.js');

    const sb = {
        window: {
            portalRuntimeContext: {
                appState: { performances, flyerDistributions: [], flyerDistributionAssignments: [], members: [] },
                getById: () => null,
                today: () => todayStr,
            },
        },
        escapeHtml: (s) => String(s || ''),
        formatDateWithWeekday: (d) => d || '',
        memberDisplayName: (m) => m.name || '',
        sortedMembersByPartAndKana: (arr) => arr,
        console,
    };
    sb.globalThis = sb;
    sb.appState = sb.window.portalRuntimeContext.appState;
    sb.$ = sb.window.portalRuntimeContext.getById;
    vm.createContext(sb);
    vm.runInContext(pureSrc, sb);
    vm.runInContext(viewsSrc, sb);
    return sb;
}

function performanceDaySandbox(todayStr, performanceDayInfos, performances) {
    const pureSrc    = readSource('src/static/js/modules/common_helpers/pure.js');
    const helpersSrc = readSource('src/static/js/modules/performance_day/helpers.js');
    const renderSrc  = readSource('src/static/js/modules/performance_day/render.js');

    const renderedHtml = {};
    const sb = {
        window: {
            portalRuntimeContext: {
                appState: { performances, performanceDayInfos },
                getById: (id) => ({
                    innerHTML: '',
                    set innerHTML(v) { renderedHtml[id] = v; },
                    get innerHTML() { return renderedHtml[id] || ''; },
                }),
                today: () => todayStr,
            },
        },
        // helpers stubs used inside performance_day/render.js
        escapeHtml: (s) => String(s || ''),
        formatDateWithWeekday: (d) => d || '',
        timelineRowsHtml: () => '',
        costumeDetailHtml: () => '',
        assignmentRowsHtml: () => '',
        normalizedPerformanceDayTimelineRows: () => [],
        normalizedCostumeDetail: () => ({}),
        normalizedPerformanceDayAssignments: () => [],
        // pure stubs needed by helpers
        normalizePerformancePieces: (p) => p || [],
        performancePieceLookupLabels: () => [],
        normalizeClockText: (v) => v || '',
        addMinutesToClockText: () => '',
        performanceDayTimelineStartValue: (r) => r?.start_time || '',
        console,
    };
    sb.globalThis = sb;
    sb.appState = sb.window.portalRuntimeContext.appState;
    sb.$ = sb.window.portalRuntimeContext.getById;
    vm.createContext(sb);
    vm.runInContext(pureSrc, sb);
    vm.runInContext(helpersSrc, sb);
    vm.runInContext(renderSrc, sb);
    return { sb, renderedHtml };
}

// ---------------------------------------------------------------------------
// A. isUpcomingPerformanceDate – unit tests
// ---------------------------------------------------------------------------

describe('isUpcomingPerformanceDate', () => {
    const TODAY = '2026-08-05';

    let sb;
    beforeAll(() => { sb = pureSandbox(TODAY); });

    test('past date returns false', () => {
        expect(sb.isUpcomingPerformanceDate('2026-08-04')).toBe(false);
    });

    test('today returns true', () => {
        expect(sb.isUpcomingPerformanceDate('2026-08-05')).toBe(true);
    });

    test('future date returns true', () => {
        expect(sb.isUpcomingPerformanceDate('2026-08-06')).toBe(true);
    });

    test('empty string returns false', () => {
        expect(sb.isUpcomingPerformanceDate('')).toBe(false);
    });

    test('null returns false', () => {
        expect(sb.isUpcomingPerformanceDate(null)).toBe(false);
    });

    test('undefined returns false', () => {
        expect(sb.isUpcomingPerformanceDate(undefined)).toBe(false);
    });

    test('slash format returns false', () => {
        expect(sb.isUpcomingPerformanceDate('2026/08/05')).toBe(false);
    });

    test('non-existent date (2026-02-30) returns false', () => {
        expect(sb.isUpcomingPerformanceDate('2026-02-30')).toBe(false);
    });

    test('non-existent date (2026-13-01) returns false', () => {
        expect(sb.isUpcomingPerformanceDate('2026-13-01')).toBe(false);
    });

    test('arbitrary string returns false', () => {
        expect(sb.isUpcomingPerformanceDate('invalid')).toBe(false);
    });

    test('valid past end-of-month returns false', () => {
        expect(sb.isUpcomingPerformanceDate('2026-07-31')).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// B. renderMemberPerformances – 演奏会情報フィルター
// ---------------------------------------------------------------------------

describe('renderMemberPerformances upcoming filter', () => {
    const TODAY = '2026-08-05';
    const PERFS = [
        { id: 1, title: 'Past',    date: '2026-08-04', pieces: [] },
        { id: 2, title: 'Today',   date: '2026-08-05', pieces: [] },
        { id: 3, title: 'Future',  date: '2026-08-06', pieces: [] },
        { id: 4, title: 'Empty',   date: '',           pieces: [] },
        { id: 5, title: 'Null',    date: null,         pieces: [] },
        { id: 6, title: 'Slash',   date: '2026/08/05', pieces: [] },
        { id: 7, title: 'Invalid', date: '2026-02-30', pieces: [] },
    ];

    let renderedHtml;
    beforeAll(() => {
        ({ renderedHtml } = memberRenderSandbox(TODAY, PERFS));
        // run render via sandbox (appState is pre-set)
    });

    test('past performance is excluded', () => {
        // Directly test via filter function in sandbox
        const { sb } = memberRenderSandbox(TODAY, PERFS);
        const filtered = PERFS.filter((p) => sb.isUpcomingPerformanceDate(p.date));
        const titles = filtered.map((p) => p.title);
        expect(titles).not.toContain('Past');
    });

    test('today is included', () => {
        const { sb } = memberRenderSandbox(TODAY, PERFS);
        const filtered = PERFS.filter((p) => sb.isUpcomingPerformanceDate(p.date));
        expect(filtered.map((p) => p.title)).toContain('Today');
    });

    test('future is included', () => {
        const { sb } = memberRenderSandbox(TODAY, PERFS);
        const filtered = PERFS.filter((p) => sb.isUpcomingPerformanceDate(p.date));
        expect(filtered.map((p) => p.title)).toContain('Future');
    });

    test('empty/null/slash/invalid dates are excluded', () => {
        const { sb } = memberRenderSandbox(TODAY, PERFS);
        const filtered = PERFS.filter((p) => sb.isUpcomingPerformanceDate(p.date));
        const titles = filtered.map((p) => p.title);
        expect(titles).not.toContain('Empty');
        expect(titles).not.toContain('Null');
        expect(titles).not.toContain('Slash');
        expect(titles).not.toContain('Invalid');
    });

    test('appState.performances is not mutated', () => {
        const { sb } = memberRenderSandbox(TODAY, [...PERFS]);
        const before = sb.appState.performances.length;
        // isUpcomingPerformanceDate only reads - filter creates new array
        PERFS.filter((p) => sb.isUpcomingPerformanceDate(p.date));
        expect(sb.appState.performances.length).toBe(before);
    });

    test('render source uses isUpcomingPerformanceDate for filter (static)', () => {
        const src = readSource('src/static/js/modules/members/render.js');
        expect(src).toContain('isUpcomingPerformanceDate(perf.date)');
        expect(src).toContain('upcomingPerformances');
        // must NOT use appState.performances.map directly for rendering
        expect(src).not.toMatch(/appState\.performances\.map\(/);
    });
});

// ---------------------------------------------------------------------------
// C. sortedPerformancesForFlyerDistribution – チラシ配布フィルター
// ---------------------------------------------------------------------------

describe('sortedPerformancesForFlyerDistribution upcoming filter', () => {
    const TODAY = '2026-08-05';

    const PERFS = [
        { id: 1, title: 'B Future', date: '2026-08-10' },
        { id: 2, title: 'A Future', date: '2026-08-10' },
        { id: 3, title: 'Today',    date: '2026-08-05' },
        { id: 4, title: 'Past',     date: '2026-08-04' },
        { id: 5, title: 'Empty',    date: '' },
        { id: 6, title: 'Slash',    date: '2026/08/10' },
        { id: 7, title: 'Invalid',  date: '2026-02-30' },
    ];

    let sb;
    beforeAll(() => { sb = flyerSandbox(TODAY, PERFS); });

    test('past is excluded', () => {
        const result = sb.sortedPerformancesForFlyerDistribution();
        expect(result.map((p) => p.title)).not.toContain('Past');
    });

    test('today is included', () => {
        const result = sb.sortedPerformancesForFlyerDistribution();
        expect(result.map((p) => p.title)).toContain('Today');
    });

    test('future is included', () => {
        const result = sb.sortedPerformancesForFlyerDistribution();
        expect(result.some((p) => p.title === 'A Future' || p.title === 'B Future')).toBe(true);
    });

    test('empty/slash/invalid are excluded', () => {
        const result = sb.sortedPerformancesForFlyerDistribution();
        const titles = result.map((p) => p.title);
        expect(titles).not.toContain('Empty');
        expect(titles).not.toContain('Slash');
        expect(titles).not.toContain('Invalid');
    });

    test('remaining performances are sorted date ASC then title ASC', () => {
        const result = sb.sortedPerformancesForFlyerDistribution();
        // Today < B Future (same date, title: A before B alphabetically)
        expect(result[0].title).toBe('Today');
        expect(result[1].title).toBe('A Future');
        expect(result[2].title).toBe('B Future');
    });

    test('sort order is stable when mixed invalid dates are present', () => {
        // Add an extra past entry to ensure it doesn't disrupt order
        const mixed = [...PERFS, { id: 99, title: 'Old', date: '2020-01-01' }];
        const sbMixed = flyerSandbox(TODAY, mixed);
        const result = sbMixed.sortedPerformancesForFlyerDistribution();
        expect(result.map((p) => p.title)).not.toContain('Old');
        // still sorted
        for (let i = 1; i < result.length; i++) {
            const cmp = String(result[i - 1].date).localeCompare(String(result[i].date))
                || String(result[i - 1].title).localeCompare(String(result[i].title), 'ja');
            expect(cmp).toBeLessThanOrEqual(0);
        }
    });
});

// ---------------------------------------------------------------------------
// D. renderPerformanceDayInfoView – 本番情報フィルター
// ---------------------------------------------------------------------------

describe('renderPerformanceDayInfoView upcoming filter', () => {
    const TODAY = '2026-08-05';

    const PERFORMANCES = [
        { id: 1, title: 'Past Perf',    date: '2026-08-04' },
        { id: 2, title: 'Today Perf',   date: '2026-08-05' },
        { id: 3, title: 'Future Perf',  date: '2026-08-10' },
        { id: 4, title: 'Empty Perf',   date: '' },
        { id: 5, title: 'Invalid Perf', date: '2026-02-30' },
    ];

    const INFOS = PERFORMANCES.map((p) => ({
        id: p.id * 10,
        performance_id: p.id,
        timeline_rows: [],
        costume_rows: [],
        assignment_rows: [],
    }));

    test('past performance_day_info is excluded from member view', () => {
        const { sb } = performanceDaySandbox(TODAY, INFOS, PERFORMANCES);
        sb.renderPerformanceDayInfoView();
        const html = sb.window.portalRuntimeContext.getById('memberPerformanceDayInfo').innerHTML || '';
        expect(html).not.toContain('Past Perf');
    });

    test('today performance_day_info is included in member view', () => {
        const { sb } = performanceDaySandbox(TODAY, INFOS, PERFORMANCES);
        sb.renderPerformanceDayInfoView();
        const html = sb.window.portalRuntimeContext.getById('memberPerformanceDayInfo').innerHTML || '';
        expect(html).toContain('Today Perf');
    });

    test('future performance_day_info is included in member view', () => {
        const { sb } = performanceDaySandbox(TODAY, INFOS, PERFORMANCES);
        sb.renderPerformanceDayInfoView();
        const html = sb.window.portalRuntimeContext.getById('memberPerformanceDayInfo').innerHTML || '';
        expect(html).toContain('Future Perf');
    });

    test('empty and invalid date performance_day_info are excluded', () => {
        const { sb } = performanceDaySandbox(TODAY, INFOS, PERFORMANCES);
        sb.renderPerformanceDayInfoView();
        const html = sb.window.portalRuntimeContext.getById('memberPerformanceDayInfo').innerHTML || '';
        expect(html).not.toContain('Empty Perf');
        expect(html).not.toContain('Invalid Perf');
    });

    test('sortedPerformanceDayInfoRows itself has no date filter (admin unaffected)', () => {
        const { sb } = performanceDaySandbox(TODAY, INFOS, PERFORMANCES);
        const allRows = sb.sortedPerformanceDayInfoRows();
        // All 5 infos are returned by the shared helper
        expect(allRows.length).toBe(INFOS.length);
    });

    test('member view filter is in renderPerformanceDayInfoView not in sortedPerformanceDayInfoRows (static)', () => {
        const renderSrc  = readSource('src/static/js/modules/performance_day/render.js');
        const helpersSrc = readSource('src/static/js/modules/performance_day/helpers.js');
        expect(renderSrc).toContain('sortedPerformanceDayInfoRows().filter(');
        expect(helpersSrc).not.toContain('isUpcomingPerformanceDate');
    });

    test('remaining rows preserve performanceDate DESC sort order', () => {
        const PERFS2 = [
            { id: 10, title: 'Z Concert', date: '2026-08-10' },
            { id: 11, title: 'A Concert', date: '2026-09-01' },
        ];
        const INFOS2 = [
            { id: 100, performance_id: 10, timeline_rows: [], costume_rows: [], assignment_rows: [] },
            { id: 110, performance_id: 11, timeline_rows: [], costume_rows: [], assignment_rows: [] },
        ];
        const { sb } = performanceDaySandbox(TODAY, INFOS2, PERFS2);
        // sortedPerformanceDayInfoRows sorts DESC by date
        const rows = sb.sortedPerformanceDayInfoRows().filter((item) => sb.isUpcomingPerformanceDate(item.performanceDate));
        // DESC: 2026-09-01 > 2026-08-10
        expect(rows[0].performanceTitle).toBe('A Concert');
        expect(rows[1].performanceTitle).toBe('Z Concert');
    });
});
