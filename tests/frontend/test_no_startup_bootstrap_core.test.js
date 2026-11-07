const fs = require('node:fs');
const path = require('node:path');

const SOURCE = fs.readFileSync(
    path.resolve(__dirname, '../../src/static/js/modules/navigation/events.js'),
    'utf8'
);

test('initial portal entry does not start background bootstrap loading', () => {
    const start = SOURCE.indexOf('async function enterPortal(options = {})');
    const end = SOURCE.indexOf('\nfunction bindNavigation()', start);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const enterPortalSource = SOURCE.slice(start, end);

    expect(enterPortalSource).not.toContain('loadFullDataInBackground()');
    expect(enterPortalSource).toContain('loadAttendanceReminderAfterStartup()');
    expect(enterPortalSource).toContain('loadPaymentAlertAfterStartup()');
});

function loadPaymentAlertSandbox(overrides = {}) {
    const vm = require('node:vm');
    const start = SOURCE.indexOf('async function loadPaymentAlertAfterStartup()');
    const end = SOURCE.indexOf('\n}\n', start) + 3;
    expect(start).toBeGreaterThanOrEqual(0);
    const sandbox = {
        appState: { currentUserMemberId: 'm1' },
        isExtraRestrictedMemberTab: vi.fn(() => false),
        isPortalMenuVisible: vi.fn(() => true),
        isDeferredPortalDataLoaded: vi.fn(() => false),
        loadExtraData: vi.fn(async () => {}),
        console: { warn: vi.fn() },
        ...overrides,
    };
    vm.runInNewContext(SOURCE.slice(start, end), sandbox);
    return sandbox;
}

test('payment alert castings are fetched once after startup for an eligible member', async () => {
    const sandbox = loadPaymentAlertSandbox();
    await sandbox.loadPaymentAlertAfterStartup();
    expect(sandbox.loadExtraData).toHaveBeenCalledWith(['castings'], { _requestOrigin: 'automatic' });
});

test.each([
    ['no member is linked', { appState: { currentUserMemberId: '' } }],
    ['the payment tab is restricted', { isExtraRestrictedMemberTab: vi.fn(() => true) }],
    ['the payment menu is hidden', { isPortalMenuVisible: vi.fn(() => false) }],
    ['castings are already loaded', { isDeferredPortalDataLoaded: vi.fn(() => true) }],
])('payment alert castings are not fetched when %s', async (_label, overrides) => {
    const sandbox = loadPaymentAlertSandbox(overrides);
    await sandbox.loadPaymentAlertAfterStartup();
    expect(sandbox.loadExtraData).not.toHaveBeenCalled();
});

test('payment alert load failure is contained', async () => {
    const sandbox = loadPaymentAlertSandbox({ loadExtraData: vi.fn(async () => { throw new Error('offline'); }) });
    await expect(sandbox.loadPaymentAlertAfterStartup()).resolves.toBeUndefined();
    expect(sandbox.console.warn).toHaveBeenCalled();
});
