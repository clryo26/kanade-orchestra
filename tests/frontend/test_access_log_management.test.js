const fs = require('node:fs');
const path = require('node:path');
const { systemAccessLogContract } = require('../../src/static/js/frontend_testable_logic.js');

describe('system access log management', () => {
    const indexHtml = fs.readFileSync(path.resolve(__dirname, '../../src/index.html'), 'utf8');
    const contract = systemAccessLogContract();

    test('system menu has access log tab and renderer', () => {
        expect(indexHtml).toContain('data-tab="system-access-log"');
        expect(indexHtml).toContain('id="systemAccessLogTab"');
        expect(indexHtml).toContain('id="accessLogTable"');
        expect(contract.tabName).toBe('system-access-log');
        expect(contract.targetPaneId).toBe('systemAccessLog');
    });

    test('tab switching records access logs with authenticated device', () => {
        expect(contract.endpoint).toBe('/api/system/access-logs');
        expect(contract.requiredHeader).toBe('X-Device-Id');
    });

    test('access log list is loaded from system endpoint', () => {
        expect(contract.listEndpointPrefix).toContain('/api/system/access-logs?limit=200&_=');
    });
});
