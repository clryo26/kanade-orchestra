const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup(performances = []) {
    const state = { performances, performancePieces: [], suppressDerivedRender: true };
    const rows = [];
    const elements = {};
    const getById = (id) => {
        elements[id] ??= { value: '', files: [], innerHTML: '' };
        return elements[id];
    };
    const requests = [];
    const alerts = [];
    const sandbox = {
        window: {
            portalRuntimeContext: { appState: state, getById, today: () => '2026-11-25' },
            normalizePerformancePieces: (pieces) => [...pieces],
        },
        FormData,
        request: async (url, options) => { requests.push({ url, ...options }); },
        showAlert: (...args) => alerts.push(args),
        loadPerformances: async () => {},
        venueSelectOptionsHtml: () => '',
        renderPerformanceFlyerPreview: () => {},
        document: {
            createElement: () => ({ innerHTML: '', addEventListener() {} }),
        },
    };
    vm.createContext(sandbox);
    // Use the actual date formatter so the display assertion also covers its
    // empty-date fallback, rather than duplicating that behavior in a stub.
    vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../src/static/js/modules/common_helpers/pure.js'), 'utf8'), sandbox);
    sandbox.window.performancePieceLabel = sandbox.performancePieceLabel;
    sandbox.window.performancePieceFormalLabel = sandbox.performancePieceFormalLabel;
    vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../src/static/js/modules/performances.js'), 'utf8'), sandbox);
    sandbox.renderPerformancePieceList = () => {};
    getById('perfListItems').appendChild = (row) => rows.push(row);
    getById('perfTitle').value = '日程未定の演奏会';
    return { sandbox, getById, requests, alerts, rows };
}

function undecidedPerformance() {
    return {
        id: 7,
        title: '日程未定の演奏会',
        date: '',
        venue: '旧会場',
        updated_at: '2026-11-24T12:00:00+09:00',
        performance_fee_amount: 5000,
        pieces: [{ title: 'Symphony' }],
    };
}

function setupSchedules(performances, schedules = []) {
    const view = setup(performances);
    const { sandbox, getById } = view;
    sandbox.appState.schedules = schedules;
    sandbox.loadSchedules = async () => {};
    sandbox.jsonOptions = (method, payload) => ({ method, body: JSON.stringify(payload) });
    // Date formatting is covered separately; these tests exercise schedule
    // selection, request payloads and the actual member grouping/rendering.
    sandbox.formatDateWithWeekday = String;
    vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../src/static/js/modules/schedules.js'), 'utf8'), sandbox);
    for (const id of ['memberSchedInfo', 'scheduleBulkCalendarBtn', 'schedPieces']) {
        getById(id).addEventListener = () => {};
        getById(id).querySelectorAll = () => [];
    }
    Object.defineProperty(getById('schedPerformance'), 'options', {
        get() {
            return [...this.innerHTML.matchAll(/<option value="([^"]*)"/g)]
                .map((match) => ({ value: match[1] }));
        },
    });
    return view;
}

describe('performance with an undecided date', () => {
    test('shows an undecided date in the admin performance list', () => {
        const view = setup([undecidedPerformance()]);
        view.sandbox.renderPerformances();

        expect(view.rows).toHaveLength(1);
        expect(view.rows[0].innerHTML).toContain('<strong>日程未定の演奏会</strong>');
        expect(view.rows[0].innerHTML).toContain('未定 / 旧会場');
        expect(view.rows[0].innerHTML).not.toContain('2026/11/25');
    });

    test('saves a title with an empty date using FormData without a warning', async () => {
        const view = setup();
        await view.sandbox.savePerformance();

        expect(view.requests).toHaveLength(1);
        const sent = view.requests[0];
        expect(sent.url).toBe('/api/performances');
        expect(sent.method).toBe('POST');
        expect(sent._portalFileOperation).toBe(true);
        expect(sent.body).toBeInstanceOf(FormData);
        expect(sent.body.get('date')).toBe('');
        expect(sent.body.get('title')).toBe('日程未定の演奏会');
        expect(view.alerts.some(([, type]) => type === 'warning')).toBe(false);
    });

    test.each(['', '   '])('rejects a blank title %j with a warning', async (title) => {
        const view = setup();
        view.getById('perfTitle').value = title;
        // A valid date isolates the title requirement from date validation.
        view.getById('perfDate').value = '2027-06-20';
        await view.sandbox.savePerformance();

        expect(view.requests).toHaveLength(0);
        expect(view.alerts).toEqual([['タイトルを入力してください', 'warning']]);
    });

    test('keeps the date empty when selecting an undecided performance', () => {
        const view = setup([undecidedPerformance()]);
        view.getById('perfDate').value = '2026-11-25';
        view.sandbox.selectPerformance(7);

        expect(view.getById('perfDate').value).toBe('');
    });

    test('preserves an empty date when updating only the venue', async () => {
        const performance = undecidedPerformance();
        const view = setup([performance]);
        view.sandbox.selectPerformance(7);
        view.getById('perfVenue').value = '新会場';
        await view.sandbox.savePerformance();

        expect(view.requests).toHaveLength(1);
        const sent = view.requests[0];
        expect(sent.url).toBe('/api/performances/7');
        expect(sent.method).toBe('PUT');
        expect(sent.body).toBeInstanceOf(FormData);
        expect(sent.body.get('date')).toBe('');
        expect(sent.body.get('venue')).toBe('新会場');
        expect(sent.body.get('expected_updated_at')).toBe(performance.updated_at);
        expect(sent.body.get('performance_fee_amount')).toBe('5000');
        expect(JSON.parse(sent.body.get('pieces'))).toEqual(performance.pieces);
    });

    test('sends the confirmed date when updating an undecided performance', async () => {
        const view = setup([undecidedPerformance()]);
        view.sandbox.selectPerformance(7);
        view.getById('perfDate').value = '2027-06-20';
        await view.sandbox.savePerformance();

        expect(view.requests).toHaveLength(1);
        const sent = view.requests[0];
        expect(sent.url).toBe('/api/performances/7');
        expect(sent.method).toBe('PUT');
        expect(sent.body).toBeInstanceOf(FormData);
        expect(sent.body.get('date')).toBe('2027-06-20');
    });

    test('offers an undated performance and its pieces and saves a future schedule linked to it', async () => {
        const performance = undecidedPerformance();
        const view = setupSchedules([performance]);
        const { sandbox, getById } = view;
        sandbox.renderSchedulePerformanceOptions();
        expect(getById('schedPerformance').innerHTML)
            .toContain('<option value="7">日程未定の演奏会</option>');
        getById('schedPerformance').value = '7';
        sandbox.updateSchedulePieceOptions();
        expect(getById('schedPieces').innerHTML).toContain('value="Symphony"');
        expect(sandbox.selectedSchedulePerformance()).toBe(performance);

        // Model checking the checkbox emitted above; keep the production
        // selectedSchedulePiecesValue() and saveSchedule() in the path.
        getById('schedPieces').querySelectorAll = (selector) => {
            expect(selector).toBe('input[type="checkbox"]:checked');
            return [{ value: 'Symphony' }];
        };
        getById('schedDate').value = '2026-12-01';
        getById('schedStartTime').value = '18:00';
        getById('schedEndTime').value = '21:00';
        await sandbox.saveSchedule();

        expect(view.requests).toHaveLength(1);
        expect(view.requests[0].url).toBe('/api/schedules');
        expect(view.requests[0].method).toBe('POST');
        expect(JSON.parse(view.requests[0].body)).toMatchObject({
            date: '2026-12-01', start_time: '18:00', end_time: '21:00',
            performance_id: 7, performance_title: performance.title, pieces: 'Symphony',
        });
        expect(view.alerts.some(([, type]) => type === 'warning')).toBe(false);
    });

    test('renders future practice under its undated concert after dated concerts and before the undecided group', () => {
        const performance = undecidedPerformance();
        const view = setupSchedules([
            performance,
            { id: 8, title: '開催日確定の演奏会', date: '2027-06-20' },
        ], [
            { id: 1, date: '2026-12-01', performance_id: 7, pieces: 'Symphony' },
            { id: 2, date: '2026-12-02', performance_id: null, pieces: '未定' },
            { id: 3, date: '2026-12-03', performance_id: 8 },
            { id: 4, date: '2026-11-24', performance_id: 7, pieces: '過去の練習曲' },
        ]);
        view.sandbox.renderMemberSchedules();

        const html = view.getById('memberSchedInfo').innerHTML;
        const groups = html.split('<details class="schedule-performance-group" open>').slice(1);
        expect(groups).toHaveLength(3);
        expect(groups.map((group) => group.match(/class="schedule-performance-title">([^<]*)/)[1]))
            .toEqual(['開催日確定の演奏会', performance.title, '未定']);
        expect(groups[1]).toContain('2026-12-01');
        expect(groups[1]).toContain('練習曲: Symphony');
        expect(html).not.toContain('過去の練習曲');
    });
});
