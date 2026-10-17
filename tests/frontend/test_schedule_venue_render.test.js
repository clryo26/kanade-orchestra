const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { formatTimeRange, splitTimeRange, formatClockTime } = require('../../src/static/js/testable/formatting.js');

describe('member schedule venue rendering', () => {
    test.each([
        ['市民センター 音楽室', '市民センター 音楽室'],
        ['', '未定'],
        [undefined, '未定'],
        ['<img src=x onerror=alert(1)>', '&lt;img src=x onerror=alert(1)&gt;'],
    ])('renders the saved venue safely: %s', (venue, expected) => {
        const container = { innerHTML: '', querySelectorAll: () => [] };
        const state = { schedules: [{
            id: 1, date: '2026-09-20', venue,
            start_time: '13:00', end_time: '16:30',
            available_start_time: '12:30', available_end_time: '17:00',
        }], performances: [] };
        const sandbox = {
            window: { portalRuntimeContext: {
                appState: state,
                getById: (id) => id === 'memberSchedInfo' ? container : null,
                today: () => '2026-09-12',
            } },
            formatDateWithWeekday: (value) => value,
            formatTimeRange,
            splitTimeRange,
            formatClockTime,
            escapeHtml: (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
        };
        vm.createContext(sandbox);
        vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../src/static/js/modules/schedules.js'), 'utf8'), sandbox);
        sandbox.renderMemberSchedules();
        expect(container.innerHTML).toContain(`練習場所: ${expected}</div>`);
        expect(container.innerHTML).not.toContain('<img');
        expect(container.innerHTML).toContain('練習時間: 13:00 - 16:30</div>');
        expect(container.innerHTML).toContain('練習可能時間: 12:30 - 17:00</div>');
        expect(container.innerHTML).toContain('data-google-calendar="1"');
    });
});
