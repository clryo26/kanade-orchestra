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

const ALL_EVENTS_FUNCTIONS = [
    'selectPerformanceDayInfo',
    'clearPerformanceDayInfoForm',
    'savePerformanceDayInfo',
    'exportPerformanceDayInfoExcel',
    'deletePerformanceDayInfo',
];

function createEventsLoaderSandbox({ definedFunctions = [] } = {}) {
    const scriptEl = createScriptMock();
    const sandbox = {
        Promise,
        Error,
        console: { warn: () => {} },
        performanceDayEventsLoadPromise: null,
        document: {
            createElement: vi.fn(() => scriptEl),
            head: { appendChild: vi.fn() },
        },
        window: { portalRuntimeContext: { appState: {}, getById: () => null } },
        getAppState: undefined,
    };
    sandbox.window.getAppState = undefined;
    sandbox.globalThis = sandbox;

    for (const name of ALL_EVENTS_FUNCTIONS) {
        sandbox[name] = definedFunctions.includes(name) ? function () {} : undefined;
    }

    vm.createContext(sandbox);
    vm.runInContext(readSource('src/static/js/modules/navigation/routes.js'), sandbox);

    return { sandbox, scriptEl };
}

function defineAllEventsFunctions(sandbox) {
    for (const name of ALL_EVENTS_FUNCTIONS) {
        sandbox[name] = function () {};
    }
}

// ---------------------------------------------------------------------------
// Static / structural tests
// ---------------------------------------------------------------------------

describe('performance day events lazy loading', () => {
    test('index.html does not eagerly load performance_day/events.js', () => {
        const indexHtml = readSource('src/index.html');
        expect(indexHtml).not.toContain('/static/js/modules/performance_day/events.js');
    });

    test('initial script count in index.html is 66', () => {
        const indexHtml = readSource('src/index.html');
        const matches = indexHtml.match(/<script\b/g);
        expect(matches).not.toBeNull();
        expect(matches.length).toBe(66);
    });

    test('app.js legacy list does not include performance_day/events.js', () => {
        const source = readSource('src/static/js/app.js');
        expect(source).not.toContain('performance_day/events.js');
    });

    test('routes.js defines ensurePerformanceDayEventsLoaded', () => {
        const source = readSource('src/static/js/modules/navigation/routes.js');
        expect(source).toContain('function ensurePerformanceDayEventsLoaded()');
    });

    test('loader uses the correct versioned URL', () => {
        const source = readSource('src/static/js/modules/navigation/routes.js');
        expect(source).toContain('/static/js/modules/performance_day/events.js?v=20260701-1');
    });

    test('loader uses a dedicated Promise variable', () => {
        const source = readSource('src/static/js/modules/navigation/routes.js');
        expect(source).toContain('performanceDayEventsLoadPromise');
    });

    test('loader checks all 5 required functions for ready determination (static)', () => {
        const source = readSource('src/static/js/modules/navigation/routes.js');
        for (const fn of ALL_EVENTS_FUNCTIONS) {
            expect(source).toContain(`typeof ${fn} === 'function'`);
        }
    });

    test('load event re-checks all 5 required functions before resolving (static)', () => {
        const source = readSource('src/static/js/modules/navigation/routes.js');
        expect(source).toMatch(/addEventListener\('load'[\s\S]*?_performanceDayEventsReady\(\)/);
    });

    test('load event rejects and resets Promise when functions are missing (static)', () => {
        const source = readSource('src/static/js/modules/navigation/routes.js');
        expect(source).toMatch(/performanceDayEventsLoadPromise\s*=\s*null[\s\S]*?reject\(new Error/);
    });

    test('requestAdminPanel awaits ensurePerformanceDayEventsLoaded before showAdminPanel (static)', () => {
        const source = readSource('src/static/js/modules/navigation/routes.js');
        const fnBody = source.match(/function requestAdminPanel\(\)[\s\S]*?^\}/m)?.[0] || source;
        const loaderPos = fnBody.indexOf('await ensurePerformanceDayEventsLoaded()');
        const showPos = fnBody.indexOf('showAdminPanel(');
        expect(loaderPos).toBeGreaterThan(0);
        expect(showPos).toBeGreaterThan(loaderPos);
    });

    test('performance day loader await is after admin system API loader await and before showAdminPanel (static)', () => {
        const source = readSource('src/static/js/modules/navigation/routes.js');
        const fnBody = source.match(/function requestAdminPanel\(\)[\s\S]*?^\}/m)?.[0] || source;
        const apiPos = fnBody.indexOf('await ensureAdminSystemApiLoaded()');
        const pdPos = fnBody.indexOf('await ensurePerformanceDayEventsLoaded()');
        const showPos = fnBody.indexOf('showAdminPanel(');
        expect(apiPos).toBeGreaterThan(0);
        expect(pdPos).toBeGreaterThan(0);
        expect(pdPos).toBeGreaterThan(apiPos);
        expect(showPos).toBeGreaterThan(pdPos);
    });

    test('requestAdminPanel catch/return is before showAdminPanel for performance day loader (static)', () => {
        const source = readSource('src/static/js/modules/navigation/routes.js');
        const fnBody = source.match(/function requestAdminPanel\(\)[\s\S]*?^\}/m)?.[0] || source;
        expect(fnBody).toMatch(/ensurePerformanceDayEventsLoaded[\s\S]*?catch[\s\S]*?return[\s\S]*?showAdminPanel/);
    });

    test('showSystemPanel does not call ensurePerformanceDayEventsLoaded (static)', () => {
        const source = readSource('src/static/js/modules/navigation/routes.js');
        const fnBody = source.match(/function showSystemPanel\(\)[\s\S]*?^\}/m)?.[0] || '';
        expect(fnBody).not.toContain('ensurePerformanceDayEventsLoaded');
    });

    test('existing 3 loaders are unchanged', () => {
        const source = readSource('src/static/js/modules/admin_system.js');
        expect(source).toContain('function ensureAdminDatabaseViewerLoaded()');
        expect(source).toContain('function ensureAdminEnvironmentManagementLoaded()');
        expect(source).toContain('function ensureAdminSystemApiLoaded()');
    });

    // ---------------------------------------------------------------------------
    // Behavioural tests using vm sandbox
    // ---------------------------------------------------------------------------

    test('[behaviour] resolves without injecting script when all 5 functions are defined', async () => {
        const { sandbox } = createEventsLoaderSandbox({ definedFunctions: ALL_EVENTS_FUNCTIONS });
        const p = sandbox.ensurePerformanceDayEventsLoaded();
        await expect(p).resolves.toBeUndefined();
        expect(sandbox.document.createElement).not.toHaveBeenCalled();
    });

    test('[behaviour] injects script when exactly one function is missing', async () => {
        const missing = ALL_EVENTS_FUNCTIONS.slice(1);
        const { sandbox } = createEventsLoaderSandbox({ definedFunctions: missing });
        sandbox.ensurePerformanceDayEventsLoaded();
        expect(sandbox.document.createElement).toHaveBeenCalledWith('script');
    });

    test('[behaviour] injects script when all functions are undefined', async () => {
        const { sandbox } = createEventsLoaderSandbox({ definedFunctions: [] });
        sandbox.ensurePerformanceDayEventsLoaded();
        expect(sandbox.document.createElement).toHaveBeenCalledWith('script');
    });

    test('[behaviour] resolves after load when all 5 functions are defined post-load', async () => {
        const { sandbox, scriptEl } = createEventsLoaderSandbox({ definedFunctions: [] });
        const p = sandbox.ensurePerformanceDayEventsLoaded();
        expect(sandbox.document.head.appendChild).toHaveBeenCalledWith(scriptEl);

        defineAllEventsFunctions(sandbox);
        scriptEl._trigger('load');

        await expect(p).resolves.toBeUndefined();
    });

    test('[behaviour] rejects when load fires with 1 function missing', async () => {
        const { sandbox, scriptEl } = createEventsLoaderSandbox({ definedFunctions: [] });
        const p = sandbox.ensurePerformanceDayEventsLoaded();

        for (const name of ALL_EVENTS_FUNCTIONS.slice(0, -1)) {
            sandbox[name] = function () {};
        }
        scriptEl._trigger('load');

        await expect(p).rejects.toThrow();
        expect(sandbox.performanceDayEventsLoadPromise).toBeNull();
    });

    test('[behaviour] rejects when load fires with multiple functions missing', async () => {
        const { sandbox, scriptEl } = createEventsLoaderSandbox({ definedFunctions: [] });
        const p = sandbox.ensurePerformanceDayEventsLoaded();

        for (const name of ALL_EVENTS_FUNCTIONS.slice(0, 2)) {
            sandbox[name] = function () {};
        }
        scriptEl._trigger('load');

        await expect(p).rejects.toThrow();
        expect(sandbox.performanceDayEventsLoadPromise).toBeNull();
    });

    test('[behaviour] rejects and resets Promise on network error', async () => {
        const { sandbox, scriptEl } = createEventsLoaderSandbox({ definedFunctions: [] });
        const p = sandbox.ensurePerformanceDayEventsLoaded();
        scriptEl._trigger('error');

        await expect(p).rejects.toThrow();
        expect(sandbox.performanceDayEventsLoadPromise).toBeNull();
    });

    test('[behaviour] returns same Promise on concurrent calls', () => {
        const { sandbox } = createEventsLoaderSandbox({ definedFunctions: [] });
        const p1 = sandbox.ensurePerformanceDayEventsLoaded();
        const p2 = sandbox.ensurePerformanceDayEventsLoaded();
        expect(p1).toBe(p2);
        expect(sandbox.document.createElement).toHaveBeenCalledTimes(1);
    });

    test('[behaviour] allows retry after load-but-missing-functions failure', async () => {
        const { sandbox, scriptEl: el1 } = createEventsLoaderSandbox({ definedFunctions: [] });

        const p1 = sandbox.ensurePerformanceDayEventsLoaded();
        el1._trigger('load');
        await expect(p1).rejects.toThrow();

        const el2 = createScriptMock();
        sandbox.document.createElement = vi.fn(() => el2);
        const p2 = sandbox.ensurePerformanceDayEventsLoaded();
        expect(sandbox.document.createElement).toHaveBeenCalledWith('script');

        defineAllEventsFunctions(sandbox);
        el2._trigger('load');
        await expect(p2).resolves.toBeUndefined();
    });

    test('[behaviour] allows retry after network error', async () => {
        const { sandbox, scriptEl: el1 } = createEventsLoaderSandbox({ definedFunctions: [] });

        const p1 = sandbox.ensurePerformanceDayEventsLoaded();
        el1._trigger('error');
        await expect(p1).rejects.toThrow();

        const el2 = createScriptMock();
        sandbox.document.createElement = vi.fn(() => el2);
        const p2 = sandbox.ensurePerformanceDayEventsLoaded();

        defineAllEventsFunctions(sandbox);
        el2._trigger('load');
        await expect(p2).resolves.toBeUndefined();
    });
});
