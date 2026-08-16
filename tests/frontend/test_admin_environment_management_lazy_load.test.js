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

/**
 * initialRefreshDefined / initialRenderDefined control which functions are
 * pre-defined in the sandbox before the loader runs.
 */
function createEnvLoaderSandbox({
    initialRefreshDefined = false,
    initialRenderDefined = false,
} = {}) {
    const scriptEl = createScriptMock();

    const sandbox = {
        Promise,
        Error,
        console: { warn: () => {} },
        adminEnvironmentManagementLoadPromise: null,
        refreshSystemEnvironmentMenuVisibility: initialRefreshDefined ? function () {} : undefined,
        renderSystemEnvironmentManagement: initialRenderDefined ? function () {} : undefined,
        document: {
            createElement: vi.fn(() => scriptEl),
            head: { appendChild: vi.fn() },
        },
        window: { portalRuntimeContext: { appState: {}, getById: () => null } },
        getAppState: undefined,
    };
    sandbox.window.getAppState = undefined;
    sandbox.globalThis = sandbox;

    vm.createContext(sandbox);
    vm.runInContext(readSource('src/static/js/modules/admin_system.js'), sandbox);

    return { sandbox, scriptEl };
}

// ---------------------------------------------------------------------------
// Static / structural tests
// ---------------------------------------------------------------------------

describe('admin environment management lazy loading', () => {
    test('index.html does not eagerly load environment_management.js', () => {
        const indexHtml = readSource('src/index.html');
        expect(indexHtml).not.toContain('/static/js/modules/admin_system/environment_management.js');
    });

    test('initial script count in index.html is 66', () => {
        const indexHtml = readSource('src/index.html');
        const matches = indexHtml.match(/<script\b/g);
        expect(matches).not.toBeNull();
        expect(matches.length).toBe(66);
    });

    test('app.js legacy list does not include environment_management.js', () => {
        const source = readSource('src/static/js/app.js');
        expect(source).not.toContain('environment_management.js');
    });

    test('admin_system.js defines ensureAdminEnvironmentManagementLoaded', () => {
        const source = readSource('src/static/js/modules/admin_system.js');
        expect(source).toContain('function ensureAdminEnvironmentManagementLoaded()');
    });

    test('loader uses the correct versioned URL', () => {
        const source = readSource('src/static/js/modules/admin_system.js');
        expect(source).toContain(
            '/static/js/modules/admin_system/environment_management.js?v=20260707-1'
        );
    });

    test('loader uses separate Promise variable distinct from database viewer', () => {
        const source = readSource('src/static/js/modules/admin_system.js');
        expect(source).toContain('adminEnvironmentManagementLoadPromise');
        expect(source).not.toMatch(/adminEnvironmentManagementLoadPromise\s*=\s*adminDatabaseViewerLoadPromise/);
    });

    test('loader checks both functions for already-loaded determination (static)', () => {
        const source = readSource('src/static/js/modules/admin_system.js');
        expect(source).toMatch(/typeof refreshSystemEnvironmentMenuVisibility\s*===\s*'function'/);
        expect(source).toMatch(/typeof renderSystemEnvironmentManagement\s*===\s*'function'/);
        expect(source).toMatch(/return Promise\.resolve\(\)/);
    });

    test('load event checks both functions before resolving (static)', () => {
        const source = readSource('src/static/js/modules/admin_system.js');
        expect(source).toMatch(/addEventListener\('load'[\s\S]*?typeof refreshSystemEnvironmentMenuVisibility\s*===\s*'function'/);
        expect(source).toMatch(/addEventListener\('load'[\s\S]*?typeof renderSystemEnvironmentManagement\s*===\s*'function'/);
    });

    test('load event rejects and resets Promise when functions are not defined (static)', () => {
        const source = readSource('src/static/js/modules/admin_system.js');
        expect(source).toMatch(/adminEnvironmentManagementLoadPromise\s*=\s*null[\s\S]*?reject\(new Error/);
    });

    test('showSystemPanel uses ensureAdminEnvironmentManagementLoaded', () => {
        const source = readSource('src/static/js/modules/navigation/routes.js');
        expect(source).toContain('ensureAdminEnvironmentManagementLoaded()');
        expect(source).toContain('refreshSystemEnvironmentMenuVisibility()');
    });

    test('showSystemPanel awaits the loader and catches failures', () => {
        const source = readSource('src/static/js/modules/navigation/routes.js');
        const block = source.match(/ensureAdminEnvironmentManagementLoaded[\s\S]*?catch/);
        expect(block).not.toBeNull();
    });

    test('system-environment tab switch uses ensureAdminEnvironmentManagementLoaded', () => {
        const source = readSource('src/static/js/modules/navigation/routes.js');
        const block = source.match(/system-environment[\s\S]*?(?=if \(render|window\.scroll)/);
        expect(block).not.toBeNull();
        expect(block[0]).toContain('ensureAdminEnvironmentManagementLoaded()');
        expect(block[0]).toContain('renderSystemEnvironmentManagement()');
        expect(block[0]).toContain('.catch(');
    });

    test('system-environment tab does not use the old typeof guard directly', () => {
        const source = readSource('src/static/js/modules/navigation/routes.js');
        expect(source).not.toMatch(/tabName === 'system-environment' && typeof renderSystemEnvironmentManagement/);
    });

    test('database viewer lazy load is unchanged', () => {
        const source = readSource('src/static/js/modules/admin_system.js');
        expect(source).toContain('function ensureAdminDatabaseViewerLoaded()');
        expect(source).toContain('adminDatabaseViewerLoadPromise');
        expect(source).toContain('/static/js/modules/admin_system/database_viewer.js?v=20260701-2');
    });

    // ---------------------------------------------------------------------------
    // Behavioural tests using vm sandbox
    // ---------------------------------------------------------------------------

    test('[behaviour] resolves without injecting script when both functions already defined', async () => {
        const { sandbox } = createEnvLoaderSandbox({
            initialRefreshDefined: true,
            initialRenderDefined: true,
        });
        const p = sandbox.ensureAdminEnvironmentManagementLoaded();
        await expect(p).resolves.toBeUndefined();
        expect(sandbox.document.createElement).not.toHaveBeenCalled();
    });

    test('[behaviour] injects script when only refreshSystemEnvironmentMenuVisibility is defined', async () => {
        const { sandbox } = createEnvLoaderSandbox({
            initialRefreshDefined: true,
            initialRenderDefined: false,
        });
        sandbox.ensureAdminEnvironmentManagementLoaded();
        expect(sandbox.document.createElement).toHaveBeenCalledWith('script');
    });

    test('[behaviour] injects script when only renderSystemEnvironmentManagement is defined', async () => {
        const { sandbox } = createEnvLoaderSandbox({
            initialRefreshDefined: false,
            initialRenderDefined: true,
        });
        sandbox.ensureAdminEnvironmentManagementLoaded();
        expect(sandbox.document.createElement).toHaveBeenCalledWith('script');
    });

    test('[behaviour] resolves after load when both functions are defined post-load', async () => {
        const { sandbox, scriptEl } = createEnvLoaderSandbox({
            initialRefreshDefined: false,
            initialRenderDefined: false,
        });

        const p = sandbox.ensureAdminEnvironmentManagementLoaded();
        expect(sandbox.document.head.appendChild).toHaveBeenCalledWith(scriptEl);

        sandbox.refreshSystemEnvironmentMenuVisibility = function () {};
        sandbox.renderSystemEnvironmentManagement = function () {};
        scriptEl._trigger('load');

        await expect(p).resolves.toBeUndefined();
    });

    test('[behaviour] rejects when load fires with only refresh function defined', async () => {
        const { sandbox, scriptEl } = createEnvLoaderSandbox({
            initialRefreshDefined: false,
            initialRenderDefined: false,
        });

        const p = sandbox.ensureAdminEnvironmentManagementLoaded();
        sandbox.refreshSystemEnvironmentMenuVisibility = function () {};
        scriptEl._trigger('load'); // renderSystemEnvironmentManagement still undefined

        await expect(p).rejects.toThrow();
        expect(sandbox.adminEnvironmentManagementLoadPromise).toBeNull();
    });

    test('[behaviour] rejects when load fires with only render function defined', async () => {
        const { sandbox, scriptEl } = createEnvLoaderSandbox({
            initialRefreshDefined: false,
            initialRenderDefined: false,
        });

        const p = sandbox.ensureAdminEnvironmentManagementLoaded();
        sandbox.renderSystemEnvironmentManagement = function () {};
        scriptEl._trigger('load'); // refreshSystemEnvironmentMenuVisibility still undefined

        await expect(p).rejects.toThrow();
        expect(sandbox.adminEnvironmentManagementLoadPromise).toBeNull();
    });

    test('[behaviour] rejects when load fires with both functions still undefined', async () => {
        const { sandbox, scriptEl } = createEnvLoaderSandbox({
            initialRefreshDefined: false,
            initialRenderDefined: false,
        });

        const p = sandbox.ensureAdminEnvironmentManagementLoaded();
        scriptEl._trigger('load');

        await expect(p).rejects.toThrow();
        expect(sandbox.adminEnvironmentManagementLoadPromise).toBeNull();
    });

    test('[behaviour] rejects and resets Promise on network error', async () => {
        const { sandbox, scriptEl } = createEnvLoaderSandbox({
            initialRefreshDefined: false,
            initialRenderDefined: false,
        });

        const p = sandbox.ensureAdminEnvironmentManagementLoaded();
        scriptEl._trigger('error');

        await expect(p).rejects.toThrow();
        expect(sandbox.adminEnvironmentManagementLoadPromise).toBeNull();
    });

    test('[behaviour] returns same Promise on concurrent calls', () => {
        const { sandbox } = createEnvLoaderSandbox({
            initialRefreshDefined: false,
            initialRenderDefined: false,
        });
        const p1 = sandbox.ensureAdminEnvironmentManagementLoaded();
        const p2 = sandbox.ensureAdminEnvironmentManagementLoaded();
        expect(p1).toBe(p2);
        expect(sandbox.document.createElement).toHaveBeenCalledTimes(1);
    });

    test('[behaviour] allows retry after load-but-undefined failure with both functions on second attempt', async () => {
        const { sandbox, scriptEl: el1 } = createEnvLoaderSandbox({
            initialRefreshDefined: false,
            initialRenderDefined: false,
        });

        const p1 = sandbox.ensureAdminEnvironmentManagementLoaded();
        el1._trigger('load'); // both undefined → reject + reset
        await expect(p1).rejects.toThrow();

        const el2 = createScriptMock();
        sandbox.document.createElement = vi.fn(() => el2);
        const p2 = sandbox.ensureAdminEnvironmentManagementLoaded();
        expect(sandbox.document.createElement).toHaveBeenCalledWith('script');

        sandbox.refreshSystemEnvironmentMenuVisibility = function () {};
        sandbox.renderSystemEnvironmentManagement = function () {};
        el2._trigger('load');
        await expect(p2).resolves.toBeUndefined();
    });

    test('[behaviour] allows retry after network error', async () => {
        const { sandbox, scriptEl: el1 } = createEnvLoaderSandbox({
            initialRefreshDefined: false,
            initialRenderDefined: false,
        });

        const p1 = sandbox.ensureAdminEnvironmentManagementLoaded();
        el1._trigger('error');
        await expect(p1).rejects.toThrow();

        const el2 = createScriptMock();
        sandbox.document.createElement = vi.fn(() => el2);
        const p2 = sandbox.ensureAdminEnvironmentManagementLoaded();

        sandbox.refreshSystemEnvironmentMenuVisibility = function () {};
        sandbox.renderSystemEnvironmentManagement = function () {};
        el2._trigger('load');
        await expect(p2).resolves.toBeUndefined();
    });
});
