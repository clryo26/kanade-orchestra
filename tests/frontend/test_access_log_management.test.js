const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
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

    test('access log send failure does not throw in navigation helper', () => {
        const helperJs = fs.readFileSync(
            path.resolve(__dirname, '../../src/static/js/modules/navigation/helpers.js'),
            'utf8'
        );
        const sandbox = {
            window: null,
            globalThis: null,
            localStorage: {
                getItem: () => 'dev-1',
            },
            fetch: () => {
                throw new Error('network down');
            },
            console,
            document: {
                getElementById: () => null,
            },
        };
        sandbox.window = sandbox;
        sandbox.globalThis = sandbox;
        sandbox.portalRuntimeContext = {
            appState: { portalAuthVerified: true },
            getById: () => null,
            PORTAL_DEVICE_ID_KEY: 'kanadePortalDeviceId',
            today: () => '2026-07-03',
        };

        vm.runInNewContext(helperJs, sandbox);

        expect(() => sandbox.recordAccessLog('memberPanel', 'member-home')).not.toThrow();
    });
});
