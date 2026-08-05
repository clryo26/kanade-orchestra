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
    'savePracticeInstructionAdmin',
    'deletePracticeInstructionAdmin',
    'saveCasting',
    'deleteCasting',
];

function createApiLoaderSandbox({ definedFunctions = [] } = {}) {
    const scriptEl = createScriptMock();
    const sandbox = {
        Promise,
        Error,
        console: { warn: () => {} },
        practiceCastingApiLoadPromise: null,
        document: {
            createElement: vi.fn(() => scriptEl),
            head: { appendChild: vi.fn() },
        },
        window: { portalRuntimeContext: { appState: {}, getById: () => null } },
        getAppState: undefined,
    };
    sandbox.window.getAppState = undefined;
    sandbox.globalThis = sandbox;

    for (const name of ALL_API_FUNCTIONS) {
        sandbox[name] = definedFunctions.includes(name) ? function () {} : undefined;
    }

    vm.createContext(sandbox);
    vm.runInContext(readSource('src/static/js/modules/navigation/routes.js'), sandbox);

    return { sandbox, scriptEl };
}

function defineAllApiFunctions(sandbox) {
    for (const name of ALL_API_FUNCTIONS) {
        sandbox[name] = function () {};
    }
}

// ---------------------------------------------------------------------------
// Static / structural tests
// ---------------------------------------------------------------------------

describe('practice casting API lazy loading', () => {
    test('index.html does not eagerly load practice_casting/api.js', () => {
        const indexHtml = readSource('src/index.html');
        expect(indexHtml).not.toContain('/static/js/modules/practice_casting/api.js');
    });

    test('initial script count in index.html is 64', () => {
        const indexHtml = readSource('src/index.html');
        const matches = indexHtml.match(/<script\b/g);
        expect(matches).not.toBeNull();
        expect(matches.length).toBe(64);
    });

    test('app.js legacy list does not include practice_casting/api.js', () => {
        const source = readSource('src/static/js/app.js');
        expect(source).not.toContain('practice_casting/api.js');
    });

    test('routes.js defines ensurePracticeCastingApiLoaded', () => {
        const source = readSource('src/static/js/modules/navigation/routes.js');
        expect(source).toContain('function ensurePracticeCastingApiLoaded()');
    });

    test('loader uses the correct versioned URL', () => {
        const source = readSource('src/static/js/modules/navigation/routes.js');
        expect(source).toContain('/static/js/modules/practice_casting/api.js?v=20260701-1');
    });

    test('loader uses a dedicated Promise variable', () => {
        const source = readSource('src/static/js/modules/navigation/routes.js');
        expect(source).toContain('practiceCastingApiLoadPromise');
    });

    test('loader checks all 4 required functions for ready determination', () => {
        const source = readSource('src/static/js/modules/navigation/routes.js');
        for (const fn of ALL_API_FUNCTIONS) {
            expect(source).toContain(`typeof ${fn} === 'function'`);
        }
    });

    test('load event re-checks all 4 functions before resolving (static)', () => {
        const source = readSource('src/static/js/modules/navigation/routes.js');
        expect(source).toMatch(/addEventListener\('load'[\s\S]*?_practiceCastingApiReady\(\)/);
    });

    test('load event rejects and resets Promise when functions are missing (static)', () => {
        const source = readSource('src/static/js/modules/navigation/routes.js');
        expect(source).toMatch(/practiceCastingApiLoadPromise\s*=\s*null[\s\S]*?reject\(new Error/);
    });

    test('requestAdminPanel processing order: adminSystem → performanceDay → practiceCasting → showAdminPanel', () => {
        const source = readSource('src/static/js/modules/navigation/routes.js');
        const fnBody = source.match(/function requestAdminPanel\(\)[\s\S]*?^\}/m)?.[0] || source;
        const adminSystemApiPos = fnBody.indexOf('await ensureAdminSystemApiLoaded()');
        const performanceDayPos = fnBody.indexOf('await ensurePerformanceDayEventsLoaded()');
        const practiceCastingPos = fnBody.indexOf('await ensurePracticeCastingApiLoaded()');
        const showAdminPanelPos = fnBody.indexOf('showAdminPanel(');
        expect(adminSystemApiPos).toBeGreaterThan(0);
        expect(performanceDayPos).toBeGreaterThan(0);
        expect(practiceCastingPos).toBeGreaterThan(0);
        expect(showAdminPanelPos).toBeGreaterThan(0);
        expect(performanceDayPos).toBeGreaterThan(adminSystemApiPos);
        expect(practiceCastingPos).toBeGreaterThan(performanceDayPos);
        expect(showAdminPanelPos).toBeGreaterThan(practiceCastingPos);
    });

    test('requestAdminPanel catch/return prevents showAdminPanel when practice casting loader fails', () => {
        const source = readSource('src/static/js/modules/navigation/routes.js');
        const fnBody = source.match(/function requestAdminPanel\(\)[\s\S]*?^\}/m)?.[0] || source;
        expect(fnBody).toMatch(/ensurePracticeCastingApiLoaded[\s\S]*?catch[\s\S]*?return[\s\S]*?showAdminPanel/);
    });

    test('showSystemPanel does not call ensurePracticeCastingApiLoaded', () => {
        const source = readSource('src/static/js/modules/navigation/routes.js');
        const fnBody = source.match(/function showSystemPanel\(\)[\s\S]*?^\}/m)?.[0] || '';
        expect(fnBody).not.toContain('ensurePracticeCastingApiLoaded');
    });

    test('existing 4 loaders are unchanged', () => {
        const source = readSource('src/static/js/modules/admin_system.js');
        expect(source).toContain('function ensureAdminDatabaseViewerLoaded()');
        expect(source).toContain('function ensureAdminEnvironmentManagementLoaded()');
        expect(source).toContain('function ensureAdminSystemApiLoaded()');
        const routesSource = readSource('src/static/js/modules/navigation/routes.js');
        expect(routesSource).toContain('function ensurePerformanceDayEventsLoaded()');
    });

    test('renderCastingView does not reference api.js functions (static)', () => {
        const renderSource = readSource('src/static/js/modules/practice_casting/render.js');
        const startIdx = renderSource.indexOf('function renderCastingView()');
        expect(startIdx).toBeGreaterThan(-1);
        const fnBody = renderSource.slice(startIdx);
        for (const fn of ALL_API_FUNCTIONS) {
            expect(fnBody).not.toContain(fn);
        }
    });

    test('renderPracticeInstructionView does not reference api.js functions (static)', () => {
        // renderPracticeInstructionView is in date_piece_promotion/render_piece_practice.js
        const renderSource = readSource('src/static/js/modules/date_piece_promotion/render_piece_practice.js');
        for (const fn of ALL_API_FUNCTIONS) {
            expect(renderSource).not.toContain(fn);
        }
    });

    // ---------------------------------------------------------------------------
    // Behavioural tests using vm sandbox
    // ---------------------------------------------------------------------------

    test('[behaviour] resolves without injecting script when all 4 functions are defined', async () => {
        const { sandbox } = createApiLoaderSandbox({ definedFunctions: ALL_API_FUNCTIONS });
        const p = sandbox.ensurePracticeCastingApiLoaded();
        await expect(p).resolves.toBeUndefined();
        expect(sandbox.document.createElement).not.toHaveBeenCalled();
    });

    test('[behaviour] injects script when exactly one function is missing', async () => {
        const { sandbox } = createApiLoaderSandbox({ definedFunctions: ALL_API_FUNCTIONS.slice(1) });
        sandbox.ensurePracticeCastingApiLoaded();
        expect(sandbox.document.createElement).toHaveBeenCalledWith('script');
    });

    test('[behaviour] injects script when all functions are undefined', async () => {
        const { sandbox } = createApiLoaderSandbox({ definedFunctions: [] });
        sandbox.ensurePracticeCastingApiLoaded();
        expect(sandbox.document.createElement).toHaveBeenCalledWith('script');
    });

    test('[behaviour] resolves after load when all 4 functions are defined post-load', async () => {
        const { sandbox, scriptEl } = createApiLoaderSandbox({ definedFunctions: [] });
        const p = sandbox.ensurePracticeCastingApiLoaded();
        expect(sandbox.document.head.appendChild).toHaveBeenCalledWith(scriptEl);
        defineAllApiFunctions(sandbox);
        scriptEl._trigger('load');
        await expect(p).resolves.toBeUndefined();
    });

    test('[behaviour] rejects when load fires with 1 function missing', async () => {
        const { sandbox, scriptEl } = createApiLoaderSandbox({ definedFunctions: [] });
        const p = sandbox.ensurePracticeCastingApiLoaded();
        for (const name of ALL_API_FUNCTIONS.slice(0, -1)) {
            sandbox[name] = function () {};
        }
        scriptEl._trigger('load');
        await expect(p).rejects.toThrow();
        expect(sandbox.practiceCastingApiLoadPromise).toBeNull();
    });

    test('[behaviour] rejects when load fires with multiple functions missing', async () => {
        const { sandbox, scriptEl } = createApiLoaderSandbox({ definedFunctions: [] });
        const p = sandbox.ensurePracticeCastingApiLoaded();
        for (const name of ALL_API_FUNCTIONS.slice(0, 2)) {
            sandbox[name] = function () {};
        }
        scriptEl._trigger('load');
        await expect(p).rejects.toThrow();
        expect(sandbox.practiceCastingApiLoadPromise).toBeNull();
    });

    test('[behaviour] rejects and resets Promise on network error', async () => {
        const { sandbox, scriptEl } = createApiLoaderSandbox({ definedFunctions: [] });
        const p = sandbox.ensurePracticeCastingApiLoaded();
        scriptEl._trigger('error');
        await expect(p).rejects.toThrow();
        expect(sandbox.practiceCastingApiLoadPromise).toBeNull();
    });

    test('[behaviour] returns same Promise on concurrent calls', () => {
        const { sandbox } = createApiLoaderSandbox({ definedFunctions: [] });
        const p1 = sandbox.ensurePracticeCastingApiLoaded();
        const p2 = sandbox.ensurePracticeCastingApiLoaded();
        expect(p1).toBe(p2);
        expect(sandbox.document.createElement).toHaveBeenCalledTimes(1);
    });

    test('[behaviour] allows retry after load-but-missing-functions failure', async () => {
        const { sandbox, scriptEl: el1 } = createApiLoaderSandbox({ definedFunctions: [] });
        const p1 = sandbox.ensurePracticeCastingApiLoaded();
        el1._trigger('load');
        await expect(p1).rejects.toThrow();

        const el2 = createScriptMock();
        sandbox.document.createElement = vi.fn(() => el2);
        const p2 = sandbox.ensurePracticeCastingApiLoaded();
        expect(sandbox.document.createElement).toHaveBeenCalledWith('script');
        defineAllApiFunctions(sandbox);
        el2._trigger('load');
        await expect(p2).resolves.toBeUndefined();
    });

    test('[behaviour] allows retry after network error', async () => {
        const { sandbox, scriptEl: el1 } = createApiLoaderSandbox({ definedFunctions: [] });
        const p1 = sandbox.ensurePracticeCastingApiLoaded();
        el1._trigger('error');
        await expect(p1).rejects.toThrow();

        const el2 = createScriptMock();
        sandbox.document.createElement = vi.fn(() => el2);
        const p2 = sandbox.ensurePracticeCastingApiLoaded();
        defineAllApiFunctions(sandbox);
        el2._trigger('load');
        await expect(p2).resolves.toBeUndefined();
    });
});
