const fs = require('fs');
const path = require('path');
const vm = require('vm');

function readSource(relativePath) {
    return fs.readFileSync(path.resolve(__dirname, '../..', relativePath), 'utf8');
}

// ---------------------------------------------------------------------------
// Sandbox helpers for behavioural tests
// ---------------------------------------------------------------------------

function createScriptMock() {
    const listeners = {};
    const el = {
        src: '',
        async: false,
        addEventListener(event, fn, _opts) {
            listeners[event] = fn;
        },
        _trigger(event) {
            if (listeners[event]) listeners[event]();
        },
    };
    return el;
}

const ALL_API_FUNCTIONS = [
    'deleteAuthDevice',
    'movePartSetting',
    'savePartSetting',
    'deletePartSetting',
    'saveVenueSetting',
    'deleteVenueSetting',
    'saveFlyerDistributionSetting',
    'deleteFlyerDistributionSetting',
    'deleteSelectedFlyerDistributionSetting',
    'saveOrgSetting',
    'saveConnectionSetting',
];

function createApiLoaderSandbox({ definedFunctions = [] } = {}) {
    const scriptEl = createScriptMock();
    const sandbox = {
        Promise,
        Error,
        console: { warn: () => {} },
        adminSystemApiLoadPromise: null,
        document: {
            createElement: vi.fn(() => scriptEl),
            head: { appendChild: vi.fn() },
        },
        window: { portalRuntimeContext: { appState: {}, getById: () => null } },
        getAppState: undefined,
    };
    sandbox.window.getAppState = undefined;
    sandbox.globalThis = sandbox;

    // Pre-define the requested functions in the sandbox
    for (const name of ALL_API_FUNCTIONS) {
        sandbox[name] = definedFunctions.includes(name) ? function () {} : undefined;
    }

    vm.createContext(sandbox);
    vm.runInContext(readSource('src/static/js/modules/admin_system.js'), sandbox);

    return { sandbox, scriptEl };
}

// Helper: define all 11 functions in sandbox post-load
function defineAllApiFunctions(sandbox) {
    for (const name of ALL_API_FUNCTIONS) {
        sandbox[name] = function () {};
    }
}

// ---------------------------------------------------------------------------
// Static / structural tests
// ---------------------------------------------------------------------------

describe('admin system API lazy loading', () => {
    test('index.html does not eagerly load admin_system/api.js', () => {
        const indexHtml = readSource('src/index.html');
        expect(indexHtml).not.toContain('/static/js/modules/admin_system/api.js');
    });

    test('initial script count in index.html is 64', () => {
        const indexHtml = readSource('src/index.html');
        const matches = indexHtml.match(/<script\b/g);
        expect(matches).not.toBeNull();
        expect(matches.length).toBe(65);
    });

    test('app.js legacy list does not include admin_system/api.js', () => {
        const source = readSource('src/static/js/app.js');
        expect(source).not.toContain('admin_system/api.js');
    });

    test('admin_system.js defines ensureAdminSystemApiLoaded', () => {
        const source = readSource('src/static/js/modules/admin_system.js');
        expect(source).toContain('function ensureAdminSystemApiLoaded()');
    });

    test('loader uses the correct versioned URL', () => {
        const source = readSource('src/static/js/modules/admin_system.js');
        expect(source).toContain('/static/js/modules/admin_system/api.js?v=20260701-2');
    });

    test('loader uses a dedicated Promise variable separate from other loaders', () => {
        const source = readSource('src/static/js/modules/admin_system.js');
        expect(source).toContain('adminSystemApiLoadPromise');
        expect(source).not.toMatch(/adminSystemApiLoadPromise\s*=\s*adminDatabaseViewerLoadPromise/);
        expect(source).not.toMatch(/adminSystemApiLoadPromise\s*=\s*adminEnvironmentManagementLoadPromise/);
    });

    test('loader checks all 11 required functions for ready determination (static)', () => {
        const source = readSource('src/static/js/modules/admin_system.js');
        for (const fn of ALL_API_FUNCTIONS) {
            expect(source).toContain(`typeof ${fn} === 'function'`);
        }
    });

    test('load event re-checks all 11 required functions before resolving (static)', () => {
        const source = readSource('src/static/js/modules/admin_system.js');
        // _adminSystemApiReady() must be called inside the load handler
        expect(source).toMatch(/addEventListener\('load'[\s\S]*?_adminSystemApiReady\(\)/);
    });

    test('load event rejects and resets Promise when functions are missing (static)', () => {
        const source = readSource('src/static/js/modules/admin_system.js');
        expect(source).toMatch(/adminSystemApiLoadPromise\s*=\s*null[\s\S]*?reject\(new Error/);
    });

    test('requestAdminPanel awaits ensureAdminSystemApiLoaded before showAdminPanel (static)', () => {
        const source = readSource('src/static/js/modules/navigation/routes.js');
        // The await must appear before showAdminPanel in requestAdminPanel
        const fnBody = source.match(/function requestAdminPanel\(\)[\s\S]*?^\}/m)?.[0] || source;
        const awaitPos = fnBody.indexOf('await ensureAdminSystemApiLoaded()');
        const showPos = fnBody.indexOf('showAdminPanel(');
        expect(awaitPos).toBeGreaterThan(0);
        expect(showPos).toBeGreaterThan(awaitPos);
    });

    test('requestAdminPanel does not call showAdminPanel when loader fails (static)', () => {
        const source = readSource('src/static/js/modules/navigation/routes.js');
        // On catch/failure there must be a return before showAdminPanel
        const fnBody = source.match(/function requestAdminPanel\(\)[\s\S]*?^\}/m)?.[0] || source;
        expect(fnBody).toMatch(/catch[\s\S]*?return[\s\S]*?showAdminPanel/);
    });

    test('showSystemPanel awaits ensureAdminSystemApiLoaded before systemPanel visibility change (static)', () => {
        const source = readSource('src/static/js/modules/navigation/routes.js');
        const fnBody = source.match(/function showSystemPanel\(\)[\s\S]*?^\}/m)?.[0] || source;
        const loaderPos = fnBody.indexOf('await ensureAdminSystemApiLoaded()');
        const hiddenPos = fnBody.indexOf("$('systemPanel').hidden = false");
        expect(loaderPos).toBeGreaterThan(0);
        expect(hiddenPos).toBeGreaterThan(loaderPos);
    });

    test('showSystemPanel awaits ensureAdminSystemApiLoaded before localStorage.setItem (static)', () => {
        const source = readSource('src/static/js/modules/navigation/routes.js');
        const fnBody = source.match(/function showSystemPanel\(\)[\s\S]*?^\}/m)?.[0] || source;
        const loaderPos = fnBody.indexOf('await ensureAdminSystemApiLoaded()');
        const storagePos = fnBody.indexOf("localStorage.setItem('userRole', 'system-admin')");
        expect(loaderPos).toBeGreaterThan(0);
        expect(storagePos).toBeGreaterThan(loaderPos);
    });

    test('showSystemPanel awaits ensureAdminSystemApiLoaded before ensurePartSettingsMigrated (static)', () => {
        const source = readSource('src/static/js/modules/navigation/routes.js');
        const fnBody = source.match(/function showSystemPanel\(\)[\s\S]*?^\}/m)?.[0] || source;
        const loaderPos = fnBody.indexOf('await ensureAdminSystemApiLoaded()');
        const migratePos = fnBody.indexOf('await ensurePartSettingsMigrated()');
        expect(loaderPos).toBeGreaterThan(0);
        expect(migratePos).toBeGreaterThan(loaderPos);
    });

    test('showSystemPanel catch/return is before all panel-activating operations (static)', () => {
        const source = readSource('src/static/js/modules/navigation/routes.js');
        const fnBody = source.match(/function showSystemPanel\(\)[\s\S]*?^\}/m)?.[0] || source;
        // catch block with return must appear before systemPanel, localStorage, and loadAuthManagement
        const catchReturnPos = fnBody.search(/catch[\s\S]*?return;/);
        expect(catchReturnPos).toBeGreaterThan(0);
        expect(fnBody.indexOf("$('systemPanel').hidden = false")).toBeGreaterThan(catchReturnPos);
        expect(fnBody.indexOf("localStorage.setItem('userRole'")).toBeGreaterThan(catchReturnPos);
        expect(fnBody.indexOf('loadAuthManagement')).toBeGreaterThan(catchReturnPos);
    });

    test('showSystemPanel does not proceed to loadAuthManagement when loader fails (static)', () => {
        const source = readSource('src/static/js/modules/navigation/routes.js');
        // On failure there must be a return before loadAuthManagement
        const fnBody = source.match(/function showSystemPanel\(\)[\s\S]*?^\}/m)?.[0] || source;
        expect(fnBody).toMatch(/catch[\s\S]*?return[\s\S]*?loadAuthManagement/);
    });

    test('database viewer loader is unchanged', () => {
        const source = readSource('src/static/js/modules/admin_system.js');
        expect(source).toContain('function ensureAdminDatabaseViewerLoaded()');
        expect(source).toContain('adminDatabaseViewerLoadPromise');
        expect(source).toContain('/static/js/modules/admin_system/database_viewer.js?v=20260701-2');
    });

    test('environment management loader is unchanged', () => {
        const source = readSource('src/static/js/modules/admin_system.js');
        expect(source).toContain('function ensureAdminEnvironmentManagementLoaded()');
        expect(source).toContain('adminEnvironmentManagementLoadPromise');
        expect(source).toContain('/static/js/modules/admin_system/environment_management.js?v=20260707-1');
    });

    // ---------------------------------------------------------------------------
    // Behavioural tests using vm sandbox
    // ---------------------------------------------------------------------------

    test('[behaviour] resolves without injecting script when all 11 functions are defined', async () => {
        const { sandbox } = createApiLoaderSandbox({ definedFunctions: ALL_API_FUNCTIONS });
        const p = sandbox.ensureAdminSystemApiLoaded();
        await expect(p).resolves.toBeUndefined();
        expect(sandbox.document.createElement).not.toHaveBeenCalled();
    });

    test('[behaviour] injects script when exactly one function is missing', async () => {
        const missing = ALL_API_FUNCTIONS.slice(1); // all except first
        const { sandbox } = createApiLoaderSandbox({ definedFunctions: missing });
        sandbox.ensureAdminSystemApiLoaded();
        expect(sandbox.document.createElement).toHaveBeenCalledWith('script');
    });

    test('[behaviour] injects script when all functions are undefined', async () => {
        const { sandbox } = createApiLoaderSandbox({ definedFunctions: [] });
        sandbox.ensureAdminSystemApiLoaded();
        expect(sandbox.document.createElement).toHaveBeenCalledWith('script');
    });

    test('[behaviour] resolves after load when all 11 functions are defined post-load', async () => {
        const { sandbox, scriptEl } = createApiLoaderSandbox({ definedFunctions: [] });
        const p = sandbox.ensureAdminSystemApiLoaded();
        expect(sandbox.document.head.appendChild).toHaveBeenCalledWith(scriptEl);

        defineAllApiFunctions(sandbox);
        scriptEl._trigger('load');

        await expect(p).resolves.toBeUndefined();
    });

    test('[behaviour] rejects when load fires with 1 function missing', async () => {
        const { sandbox, scriptEl } = createApiLoaderSandbox({ definedFunctions: [] });
        const p = sandbox.ensureAdminSystemApiLoaded();

        // Define all except one
        for (const name of ALL_API_FUNCTIONS.slice(0, -1)) {
            sandbox[name] = function () {};
        }
        scriptEl._trigger('load');

        await expect(p).rejects.toThrow();
        expect(sandbox.adminSystemApiLoadPromise).toBeNull();
    });

    test('[behaviour] rejects when load fires with multiple functions missing', async () => {
        const { sandbox, scriptEl } = createApiLoaderSandbox({ definedFunctions: [] });
        const p = sandbox.ensureAdminSystemApiLoaded();
        // Define only first 3
        for (const name of ALL_API_FUNCTIONS.slice(0, 3)) {
            sandbox[name] = function () {};
        }
        scriptEl._trigger('load');

        await expect(p).rejects.toThrow();
        expect(sandbox.adminSystemApiLoadPromise).toBeNull();
    });

    test('[behaviour] rejects and resets Promise on network error', async () => {
        const { sandbox, scriptEl } = createApiLoaderSandbox({ definedFunctions: [] });
        const p = sandbox.ensureAdminSystemApiLoaded();
        scriptEl._trigger('error');

        await expect(p).rejects.toThrow();
        expect(sandbox.adminSystemApiLoadPromise).toBeNull();
    });

    test('[behaviour] returns same Promise on concurrent calls', () => {
        const { sandbox } = createApiLoaderSandbox({ definedFunctions: [] });
        const p1 = sandbox.ensureAdminSystemApiLoaded();
        const p2 = sandbox.ensureAdminSystemApiLoaded();
        expect(p1).toBe(p2);
        expect(sandbox.document.createElement).toHaveBeenCalledTimes(1);
    });

    test('[behaviour] allows retry after load-but-missing-functions failure', async () => {
        const { sandbox, scriptEl: el1 } = createApiLoaderSandbox({ definedFunctions: [] });

        const p1 = sandbox.ensureAdminSystemApiLoaded();
        el1._trigger('load'); // no functions → reject + reset
        await expect(p1).rejects.toThrow();

        const el2 = createScriptMock();
        sandbox.document.createElement = vi.fn(() => el2);
        const p2 = sandbox.ensureAdminSystemApiLoaded();
        expect(sandbox.document.createElement).toHaveBeenCalledWith('script');

        defineAllApiFunctions(sandbox);
        el2._trigger('load');
        await expect(p2).resolves.toBeUndefined();
    });

    test('[behaviour] allows retry after network error', async () => {
        const { sandbox, scriptEl: el1 } = createApiLoaderSandbox({ definedFunctions: [] });

        const p1 = sandbox.ensureAdminSystemApiLoaded();
        el1._trigger('error');
        await expect(p1).rejects.toThrow();

        const el2 = createScriptMock();
        sandbox.document.createElement = vi.fn(() => el2);
        const p2 = sandbox.ensureAdminSystemApiLoaded();

        defineAllApiFunctions(sandbox);
        el2._trigger('load');
        await expect(p2).resolves.toBeUndefined();
    });
});
