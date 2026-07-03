const fs = require('node:fs');
const path = require('node:path');

describe('system access log management', () => {
    const appJs = fs.readFileSync(path.resolve(__dirname, '../../src/static/js/app.js'), 'utf8');
    const indexHtml = fs.readFileSync(path.resolve(__dirname, '../../src/index.html'), 'utf8');

    test('system menu has access log tab and renderer', () => {
        expect(indexHtml).toContain('data-tab="system-access-log"');
        expect(indexHtml).toContain('id="systemAccessLogTab"');
        expect(indexHtml).toContain('id="accessLogTable"');
        expect(appJs).toContain("'system-access-log': 'systemAccessLog'");
        expect(appJs).toContain("if (renderOnShow && tabName === 'system-access-log') renderAccessLogView()");
    });

    test('tab switching records access logs with authenticated device', () => {
        expect(appJs).toContain('function recordAccessLog(panelId, tabName)');
        expect(appJs).toContain("fetch('/api/system/access-logs'");
        expect(appJs).toContain("'X-Device-Id': deviceId");
        expect(appJs).toContain('recordAccessLog(panelId, tabName)');
    });

    test('access log list is loaded from system endpoint', () => {
        expect(appJs).toContain('/api/system/access-logs?limit=200&_=');
        expect(appJs).toContain('appState.accessLogs');
        expect(appJs).toContain('formatDateTimeLabel(item.accessed_at || item.created_at)');
    });
});
