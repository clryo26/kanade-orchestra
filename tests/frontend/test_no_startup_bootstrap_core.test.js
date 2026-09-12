const fs = require('node:fs');
const path = require('node:path');

const SOURCE = fs.readFileSync(
    path.resolve(__dirname, '../../src/static/js/modules/navigation/events.js'),
    'utf8'
);

test('initial portal entry does not start background bootstrap loading', () => {
    const start = SOURCE.indexOf('async function enterPortal()');
    const end = SOURCE.indexOf('\nfunction bindNavigation()', start);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const enterPortalSource = SOURCE.slice(start, end);

    expect(enterPortalSource).not.toContain('loadFullDataInBackground()');
    expect(enterPortalSource).toContain('loadAttendanceReminderAfterStartup()');
});
