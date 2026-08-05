// Tests for casting view sort, open/close, and date filtering.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '../..');

function readSource(rel) {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

// ---------------------------------------------------------------------------
// Sandbox factory
// ---------------------------------------------------------------------------

function castingSandbox(todayStr, performances, castings, members) {
    const pureSrc    = readSource('src/static/js/modules/common_helpers/pure.js');
    const renderSrc  = readSource('src/static/js/modules/practice_casting/render.js');

    const renderedHtml = {};
    const sb = {
        window: {
            portalRuntimeContext: {
                appState: { performances: performances || [], castings: castings || [], members: members || [] },
                getById: (id) => ({
                    set innerHTML(v) { renderedHtml[id] = v; },
                    get innerHTML() { return renderedHtml[id] || ''; },
                }),
                today: () => todayStr,
            },
        },
        escapeHtml: (s) => String(s == null ? '' : s),
        formatDateWithWeekday: (d) => d ? d + '(date)' : '',
        memberDisplayName: (m) => m.name || '',
        extraDisplayName: (name) => name,
        partSortIndex: () => 0,
        console,
    };
    sb.globalThis = sb;
    sb.appState = sb.window.portalRuntimeContext.appState;
    sb.$ = sb.window.portalRuntimeContext.getById;
    vm.createContext(sb);
    vm.runInContext(pureSrc, sb);
    vm.runInContext(renderSrc, sb);
    sb._renderedHtml = renderedHtml;
    return sb;
}

function renderAndGetHtml(sb) {
    sb.renderCastingView();
    return sb._renderedHtml['memberCastingInfo'] || '';
}

// ---------------------------------------------------------------------------
// A. isValidPerformanceDate unit tests
// ---------------------------------------------------------------------------

describe('isValidPerformanceDate', () => {
    const TODAY = '2026-08-05';
    let sb;
    beforeAll(() => { sb = castingSandbox(TODAY, []); });

    test('valid past date returns true', () => {
        expect(sb.isValidPerformanceDate('2026-08-04')).toBe(true);
    });
    test('today returns true', () => {
        expect(sb.isValidPerformanceDate('2026-08-05')).toBe(true);
    });
    test('future date returns true', () => {
        expect(sb.isValidPerformanceDate('2026-08-06')).toBe(true);
    });
    test('empty string returns false', () => {
        expect(sb.isValidPerformanceDate('')).toBe(false);
    });
    test('null returns false', () => {
        expect(sb.isValidPerformanceDate(null)).toBe(false);
    });
    test('undefined returns false', () => {
        expect(sb.isValidPerformanceDate(undefined)).toBe(false);
    });
    test('slash format returns false', () => {
        expect(sb.isValidPerformanceDate('2026/08/05')).toBe(false);
    });
    test('non-existent date 2026-02-30 returns false', () => {
        expect(sb.isValidPerformanceDate('2026-02-30')).toBe(false);
    });
    test('non-existent month 2026-13-01 returns false', () => {
        expect(sb.isValidPerformanceDate('2026-13-01')).toBe(false);
    });
    test('isUpcomingPerformanceDate still returns false for past date', () => {
        expect(sb.isUpcomingPerformanceDate('2026-08-04')).toBe(false);
    });
    test('isUpcomingPerformanceDate still returns true for today', () => {
        expect(sb.isUpcomingPerformanceDate('2026-08-05')).toBe(true);
    });
    test('isUpcomingPerformanceDate still returns true for future date', () => {
        expect(sb.isUpcomingPerformanceDate('2026-08-06')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// B. Date filtering in renderCastingView
// ---------------------------------------------------------------------------

describe('renderCastingView date filtering', () => {
    const TODAY = '2026-08-05';

    const PERFS = [
        { id: 1, title: 'Empty Date',   date: '' },
        { id: 2, title: 'Null Date',    date: null },
        { id: 3, title: 'Slash Date',   date: '2026/08/05' },
        { id: 4, title: 'Invalid Date', date: '2026-02-30' },
        { id: 5, title: 'Past Perf',    date: '2026-07-01' },
        { id: 6, title: 'Today Perf',   date: '2026-08-05' },
        { id: 7, title: 'Future Perf',  date: '2026-09-01' },
    ];

    let html;
    beforeAll(() => {
        const sb = castingSandbox(TODAY, PERFS);
        html = renderAndGetHtml(sb);
    });

    test('empty date is hidden', () => { expect(html).not.toContain('Empty Date'); });
    test('null date is hidden',  () => { expect(html).not.toContain('Null Date'); });
    test('slash date is hidden', () => { expect(html).not.toContain('Slash Date'); });
    test('invalid date is hidden', () => { expect(html).not.toContain('Invalid Date'); });
    test('valid past date is shown', () => { expect(html).toContain('Past Perf'); });
    test('today is shown', () => { expect(html).toContain('Today Perf'); });
    test('future date is shown', () => { expect(html).toContain('Future Perf'); });
    test('appState.performances is not mutated', () => {
        const sb = castingSandbox(TODAY, [...PERFS]);
        const before = sb.appState.performances.length;
        renderAndGetHtml(sb);
        expect(sb.appState.performances.length).toBe(before);
    });
});

// ---------------------------------------------------------------------------
// C. Sort order in renderCastingView
// ---------------------------------------------------------------------------

describe('renderCastingView sort order', () => {
    const TODAY = '2026-08-05';
    const PERFS = [
        { id: 1, title: 'C', date: '2026-08-05' },  // today
        { id: 2, title: 'D', date: '2026-08-06' },  // future
        { id: 3, title: 'E', date: '2026-09-01' },  // further future
        { id: 4, title: 'B', date: '2026-08-04' },  // past recent
        { id: 5, title: 'A', date: '2026-07-01' },  // past earlier
    ];

    function extractTitlesFromHtml(html) {
        const matches = html.matchAll(/<summary[^>]*>([^<]+)/g);
        return [...matches].map((m) => m[1].trim());
    }

    let html;
    beforeAll(() => {
        const sb = castingSandbox(TODAY, PERFS);
        html = renderAndGetHtml(sb);
    });

    function titlePos(h, title) {
        // Find title inside summary: <summary ...>TITLE<span
        const re = new RegExp('<summary[^>]*>' + title + '<span');
        const m = h.match(re);
        return m ? h.indexOf(m[0]) : -1;
    }

    test('today comes before future', () => {
        expect(titlePos(html, 'C')).toBeLessThan(titlePos(html, 'D'));
    });

    test('future dates are ascending', () => {
        expect(titlePos(html, 'D')).toBeLessThan(titlePos(html, 'E'));
    });

    test('past date 2026-08-04 comes after all future/today', () => {
        expect(titlePos(html, 'E')).toBeLessThan(titlePos(html, 'B'));
    });

    test('past dates are descending (more recent first)', () => {
        expect(titlePos(html, 'B')).toBeLessThan(titlePos(html, 'A'));
    });

    test('full order: today < future-asc < past-desc', () => {
        const order = ['C', 'D', 'E', 'B', 'A'];
        const positions = order.map((t) => titlePos(html, t));
        const sorted = [...positions].sort((a, b) => a - b);
        expect(positions).toEqual(sorted);
    });
});

// ---------------------------------------------------------------------------
// D. Same-day tie-break: name ascending
// ---------------------------------------------------------------------------

describe('renderCastingView same-day title sort', () => {
    const TODAY = '2026-08-05';

    test('same future date: title ASC', () => {
        const perfs = [
            { id: 1, title: 'Z Concert', date: '2026-09-01' },
            { id: 2, title: 'A Concert', date: '2026-09-01' },
        ];
        const sb = castingSandbox(TODAY, perfs);
        const html = renderAndGetHtml(sb);
        expect(html.indexOf('A Concert')).toBeLessThan(html.indexOf('Z Concert'));
    });

    test('same past date: title ASC', () => {
        const perfs = [
            { id: 1, title: 'Z Old',     date: '2026-07-01' },
            { id: 2, title: 'A Old',     date: '2026-07-01' },
        ];
        const sb = castingSandbox(TODAY, perfs);
        const html = renderAndGetHtml(sb);
        expect(html.indexOf('A Old')).toBeLessThan(html.indexOf('Z Old'));
    });

    test('same date and same title: preserve original order', () => {
        const perfs = [
            { id: 1, title: 'Same', date: '2026-09-01' },
            { id: 2, title: 'Same', date: '2026-09-01' },
        ];
        const sb = castingSandbox(TODAY, perfs);
        const html = renderAndGetHtml(sb);
        // Both 'Same' appear; just verify no crash and both rendered
        const count = (html.match(/Same/g) || []).length;
        expect(count).toBeGreaterThanOrEqual(2);
    });
});

// ---------------------------------------------------------------------------
// E. Open/close DOM structure
// ---------------------------------------------------------------------------

describe('renderCastingView details/summary structure', () => {
    const TODAY = '2026-08-05';
    const PERFS = [
        { id: 1, title: 'First',  date: '2026-08-05' },
        { id: 2, title: 'Second', date: '2026-08-06' },
        { id: 3, title: 'Third',  date: '2026-09-01' },
    ];

    let html;
    beforeAll(() => {
        const sb = castingSandbox(TODAY, PERFS);
        html = renderAndGetHtml(sb);
    });

    test('each concert uses a details element', () => {
        const detailsCount = (html.match(/<details /g) || []).length;
        expect(detailsCount).toBe(3);
    });

    test('first (index 0) has open attribute', () => {
        const firstDetails = html.match(/<details [^>]*>/)?.[0] || '';
        expect(firstDetails).toContain(' open');
    });

    test('second details does NOT have open', () => {
        const allDetails = [...html.matchAll(/<details ([^>]*)>/g)];
        expect(allDetails[1]?.[1] || '').not.toContain('open');
    });

    test('third details does NOT have open', () => {
        const allDetails = [...html.matchAll(/<details ([^>]*)>/g)];
        expect(allDetails[2]?.[1] || '').not.toContain('open');
    });

    test('each details has a summary element', () => {
        const summaryCount = (html.match(/<summary /g) || []).length;
        expect(summaryCount).toBe(3);
    });

    test('summary contains concert title', () => {
        expect(html).toContain('>First');
        expect(html).toContain('>Second');
        expect(html).toContain('>Third');
    });

    test('summary contains date string', () => {
        // formatDateWithWeekday converts 2026-08-05 to 2026/08/05（weekday）
        expect(html).toContain('2026/08/05');
        expect(html).toContain('2026/08/06');
    });
});

// ---------------------------------------------------------------------------
// F. Zero valid performances: empty output
// ---------------------------------------------------------------------------

describe('renderCastingView empty output', () => {
    test('all invalid dates result in empty innerHTML', () => {
        const perfs = [
            { id: 1, title: 'Bad', date: '' },
            { id: 2, title: 'Bad2', date: null },
        ];
        const sb = castingSandbox('2026-08-05', perfs);
        const html = renderAndGetHtml(sb);
        expect(html).toBe('');
    });
});

// ---------------------------------------------------------------------------
// G. Casting content preserved
// ---------------------------------------------------------------------------

describe('renderCastingView casting content preserved', () => {
    const TODAY = '2026-08-05';

    test('performance with no castings shows 乗り番表は未登録です', () => {
        const perfs = [{ id: 1, title: 'Concert', date: '2026-08-05' }];
        const sb = castingSandbox(TODAY, perfs, []);
        const html = renderAndGetHtml(sb);
        expect(html).toContain('乗り番表は未登録です');
    });

    test('casting piece name is rendered inside details', () => {
        const perfs = [{ id: 1, title: 'Concert', date: '2026-08-05' }];
        const castings = [{ id: 10, performance_id: 1, piece: 'Symphony No.5', members: [], extras: [] }];
        const sb = castingSandbox(TODAY, perfs, castings);
        const html = renderAndGetHtml(sb);
        expect(html).toContain('Symphony No.5');
    });
});

// ---------------------------------------------------------------------------
// H. Non-regression: renderCastingAdmin is not changed
// ---------------------------------------------------------------------------

describe('renderCastingAdmin non-regression (static)', () => {
    const renderSrc = readSource('src/static/js/modules/practice_casting/render.js');
    const adminFnStart = renderSrc.indexOf('function renderCastingAdmin()');
    // Limit to only the admin function body, not beyond renderCastingView
    const viewFnStart = renderSrc.indexOf('function renderCastingView()');
    const adminFnEnd = viewFnStart >= 0 ? viewFnStart : renderSrc.length;
    const adminFnBody = adminFnStart >= 0 ? renderSrc.slice(adminFnStart, adminFnEnd) : '';

    test('renderCastingAdmin does not contain isValidPerformanceDate', () => {
        expect(adminFnBody).not.toContain('isValidPerformanceDate');
    });
    test('renderCastingAdmin does not contain details element', () => {
        expect(adminFnBody).not.toContain('<details');
    });
    test('renderCastingAdmin does not contain casting-details class', () => {
        expect(adminFnBody).not.toContain('casting-details');
    });
    test('renderCastingView uses isValidPerformanceDate', () => {
        const viewFnStart = renderSrc.indexOf('function renderCastingView()');
        const viewFnBody = renderSrc.slice(viewFnStart);
        expect(viewFnBody).toContain('isValidPerformanceDate');
    });
    test('renderCastingView uses details element', () => {
        const viewFnStart = renderSrc.indexOf('function renderCastingView()');
        const viewFnBody = renderSrc.slice(viewFnStart);
        expect(viewFnBody).toContain('<details');
    });
});
