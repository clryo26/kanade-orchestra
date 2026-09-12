const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

describe('member schedule venue rendering', () => {
    test.each([
        ['市民センター 音楽室', '市民センター 音楽室'],
        ['', '未定'],
        [undefined, '未定'],
        ['<img src=x onerror=alert(1)>', '&lt;img src=x onerror=alert(1)&gt;'],
    ])('renders the saved venue safely: %s', (venue, expected) => {
        const container = { innerHTML: '', querySelectorAll: () => [] };
        const state = { schedules: [{ id: 1, date: '2026-09-20', venue }], performances: [] };
        const sandbox = {
            window: { portalRuntimeContext: {
                appState: state,
                getById: (id) => id === 'memberSchedInfo' ? container : null,
                today: () => '2026-09-12',
            } },
            formatDateWithWeekday: (value) => value,
            formatTimeRange: () => '',
            splitTimeRange: () => ({ start: '', end: '' }),
            formatClockTime: () => '',
            escapeHtml: (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
        };
        vm.createContext(sandbox);
        vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../src/static/js/modules/schedules.js'), 'utf8'), sandbox);
        sandbox.renderMemberSchedules();
        expect(container.innerHTML).toContain(`練習場所: ${expected}</div>`);
        expect(container.innerHTML).not.toContain('<img');
        expect(container.innerHTML).toContain('練習可能時間:');
        expect(container.innerHTML).toContain('data-google-calendar="1"');
    });
});
