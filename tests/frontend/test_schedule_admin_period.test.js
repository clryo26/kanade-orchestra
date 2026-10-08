const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup(schedules) {
    const state = { schedules, performances: [], suppressDerivedRender: true };
    const rows = [];
    let buttons = [];
    let html = '';
    const container = {
        get innerHTML() { return html; },
        set innerHTML(value) {
            html = value;
            rows.length = 0;
            buttons = ['future', 'past'].map((period) => ({
                dataset: { schedulePeriod: period },
                addEventListener(type, handler) { this.click = handler; },
            }));
        },
        insertAdjacentHTML(position, value) { html += value; },
        querySelectorAll: () => buttons,
        querySelector: () => ({ appendChild: (row) => rows.push(row) }),
    };
    const selected = [];
    const sandbox = {
        window: { portalRuntimeContext: { appState: state, getById: () => container, today: () => '2026-10-08' } },
        document: { createElement: () => ({ innerHTML: '', addEventListener(type, handler) { this.click = handler; } }) },
        escapeHtml: String,
        formatDateWithWeekday: String,
        splitTimeRange: () => ({ start: '', end: '' }),
        formatTimeRange: () => '',
        formatClockTime: () => '',
    };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../src/static/js/modules/schedules.js'), 'utf8'), sandbox);
    sandbox.selectSchedule = (id) => selected.push(id);
    return { state, rows, container, selected, sandbox, click: (period) => buttons.find((button) => button.dataset.schedulePeriod === period).click() };
}

describe('schedule admin period switching', () => {
    test('defaults to future including today, sorts descending, and keeps row selection', () => {
        const schedules = [
            { id: 1, date: '2026-10-07' }, { id: 2, date: '2026-10-08' },
            { id: 3, date: '2026-12-01' }, { id: 4, date: '2026-09-01' },
            { id: 5, date: '2026-11-01' },
        ];
        const view = setup(schedules);
        const dates = () => view.rows.map((row) => row.innerHTML.match(/<td>(.*?)<\/td>/)[1]);
        view.sandbox.renderSchedules();
        expect(dates()).toEqual(['2026-12-01', '2026-11-01', '2026-10-08']);
        expect(view.container.innerHTML).toContain('data-schedule-period="future" aria-pressed="true"');
        view.rows[0].click();
        expect(view.selected).toEqual([3]);
        view.click('past');
        expect(dates()).toEqual(['2026-10-07', '2026-09-01']);
        expect(view.container.innerHTML).toContain('data-schedule-period="past" aria-pressed="true"');
        view.sandbox.renderSchedules();
        expect(dates()).toEqual(['2026-10-07', '2026-09-01']);
        view.click('future');
        expect(dates()).toEqual(['2026-12-01', '2026-11-01', '2026-10-08']);
        expect(schedules.map((schedule) => schedule.id)).toEqual([1, 2, 3, 4, 5]);
    });

    test('switches out of an empty period and handles an empty library', () => {
        const view = setup([{ id: 1, date: '2026-10-07' }]);
        view.sandbox.renderSchedules();
        expect(view.rows).toHaveLength(0);
        expect(view.container.innerHTML).toContain('当日以降の練習予定はありません');
        view.click('past');
        expect(view.rows).toHaveLength(1);
        view.state.schedules = [];
        view.sandbox.renderSchedules();
        expect(view.container.innerHTML).toContain('過去の練習予定はありません');
        view.click('future');
        expect(view.container.innerHTML).toContain('当日以降の練習予定はありません');
    });
});
