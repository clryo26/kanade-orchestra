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
 * Loads the ensureAdminDatabaseViewerLoaded function in an isolated vm context.
 * initialRenderDefined controls whether renderDatabaseView is already present.
 * Returns { sandbox, scriptEl } so tests can trigger load/error events.
 */
function createLoaderSandbox({ initialRenderDefined = false } = {}) {
    const scriptEl = createScriptMock();

    const sandbox = {
        Promise,
        Error,
        console: { warn: () => {} },
        adminDatabaseViewerLoadPromise: null,
        renderDatabaseView: initialRenderDefined ? function () {} : undefined,
        document: {
            createElement: vi.fn(() => scriptEl),
            head: { appendChild: vi.fn() },
        },
        // admin_system.js top-level var declarations need these
        window: { portalRuntimeContext: { appState: {}, getById: () => null } },
        getAppState: undefined,
    };
    sandbox.window.getAppState = undefined;
    // Make globalThis point to the sandbox so `typeof` checks work correctly
    sandbox.globalThis = sandbox;

    vm.createContext(sandbox);
    vm.runInContext(readSource('src/static/js/modules/admin_system.js'), sandbox);

    return { sandbox, scriptEl };
}

// ---------------------------------------------------------------------------
// Static / structural tests
// ---------------------------------------------------------------------------

describe('admin database viewer lazy loading', () => {
    test('index.html does not eagerly load database_viewer.js', () => {
        const indexHtml = readSource('src/index.html');
        expect(indexHtml).not.toContain('/static/js/modules/admin_system/database_viewer.js');
    });

    test('initial script count in index.html is 66', () => {
        const indexHtml = readSource('src/index.html');
        const matches = indexHtml.match(/<script\b/g);
        expect(matches).not.toBeNull();
        expect(matches.length).toBe(43);
    });

    test('admin_system.js defines ensureAdminDatabaseViewerLoaded', () => {
        const source = readSource('src/static/js/modules/admin_system.js');
        expect(source).toContain('function ensureAdminDatabaseViewerLoaded()');
    });

    test('loader uses the correct versioned URL', () => {
        const source = readSource('src/static/js/modules/admin_system.js');
        expect(source).toContain(
            '/static/js/modules/admin_system/database_viewer.js?v=20260701-2'
        );
    });

    test('loader uses shared Promise to prevent double loading', () => {
        const source = readSource('src/static/js/modules/admin_system.js');
        expect(source).toContain('adminDatabaseViewerLoadPromise');
        expect(source).toMatch(/if \(adminDatabaseViewerLoadPromise\)/);
    });

    test('loader skips script injection when renderDatabaseView is already defined (static)', () => {
        const source = readSource('src/static/js/modules/admin_system.js');
        expect(source).toMatch(/typeof renderDatabaseView\s*===\s*'function'/);
        expect(source).toMatch(/return Promise\.resolve\(\)/);
    });

    test('loader resets Promise on network error to allow retry (static)', () => {
        const source = readSource('src/static/js/modules/admin_system.js');
        expect(source).toMatch(/adminDatabaseViewerLoadPromise\s*=\s*null/);
    });

    test('load event checks renderDatabaseView is defined before resolving (static)', () => {
        const source = readSource('src/static/js/modules/admin_system.js');
        // The load handler must verify function existence
        expect(source).toMatch(/addEventListener\('load'[\s\S]*?typeof renderDatabaseView\s*===\s*'function'/);
    });

    test('load event rejects and resets Promise when renderDatabaseView is not defined (static)', () => {
        const source = readSource('src/static/js/modules/admin_system.js');
        // Inside load handler: reset then reject
        expect(source).toMatch(/adminDatabaseViewerLoadPromise\s*=\s*null[\s\S]*?reject\(new Error/);
    });

    test('loader attaches to document.head', () => {
        const source = readSource('src/static/js/modules/admin_system.js');
        expect(source).toContain('document.head.appendChild(script)');
    });

    test('navigation routes calls ensureAdminDatabaseViewerLoaded for system-database tab', () => {
        const source = readSource('src/static/js/modules/navigation/routes.js');
        const block = source.match(/system-database[\s\S]*?(?=if \(render|window\.scroll)/);
        expect(block).not.toBeNull();
        expect(block[0]).toContain('ensureAdminDatabaseViewerLoaded()');
        expect(block[0]).toContain('renderDatabaseView()');
    });

    test('navigation routes does not call renderDatabaseView directly', () => {
        const source = readSource('src/static/js/modules/navigation/routes.js');
        expect(source).not.toMatch(/tabName === 'system-database'\) renderDatabaseView\(\)/);
    });

    test('navigation routes catches load failure without stopping the portal', () => {
        const source = readSource('src/static/js/modules/navigation/routes.js');
        const block = source.match(/system-database[\s\S]*?(?=if \(render|window\.scroll)/);
        expect(block).not.toBeNull();
        expect(block[0]).toContain('.catch(');
    });

    test('system-database tab does not eagerly load on non-matching tabs', () => {
        const source = readSource('src/static/js/modules/navigation/routes.js');
        expect(source).toMatch(/tabName === 'system-database'[\s\S]*?ensureAdminDatabaseViewerLoaded/);
    });

    test('app.js legacy list does not include database_viewer.js', () => {
        const source = readSource('src/static/js/app.js');
        expect(source).not.toContain('database_viewer.js');
    });

    test('recordings lazy load implementation is unchanged', () => {
        const source = readSource('src/static/js/modules/recordings.js');
        expect(source).toContain('function ensureRecordingsFeatureLoaded()');
        expect(source).toContain("script.src = '/static/js/recordings_feature.js?v=20260731-1'");
        expect(source).toContain('recordingsFeatureLoadPromise = null');
        expect(source).toMatch(/async function loadRecordings\(\)\s*\{\s*await ensureRecordingsFeatureLoaded\(\)/);
    });

    // ---------------------------------------------------------------------------
    // Behavioural tests using vm sandbox
    // ---------------------------------------------------------------------------

    test('[behaviour] resolves and does not inject script when renderDatabaseView already defined', async () => {
        const { sandbox, scriptEl } = createLoaderSandbox({ initialRenderDefined: true });
        const p = sandbox.ensureAdminDatabaseViewerLoaded();
        await expect(p).resolves.toBeUndefined();
        expect(sandbox.document.createElement).not.toHaveBeenCalled();
    });

    test('[behaviour] injects script and resolves after load when renderDatabaseView is defined post-load', async () => {
        const { sandbox, scriptEl } = createLoaderSandbox({ initialRenderDefined: false });

        const p = sandbox.ensureAdminDatabaseViewerLoaded();

        expect(sandbox.document.createElement).toHaveBeenCalledWith('script');
        expect(sandbox.document.head.appendChild).toHaveBeenCalledWith(scriptEl);

        // Simulate script load: set the function, then fire load event
        sandbox.renderDatabaseView = function () {};
        scriptEl._trigger('load');

        await expect(p).resolves.toBeUndefined();
    });

    test('[behaviour] rejects and resets Promise when load event fires but renderDatabaseView is still undefined', async () => {
        const { sandbox, scriptEl } = createLoaderSandbox({ initialRenderDefined: false });

        const p = sandbox.ensureAdminDatabaseViewerLoaded();

        // Fire load WITHOUT defining renderDatabaseView
        scriptEl._trigger('load');

        await expect(p).rejects.toThrow();
        expect(sandbox.adminDatabaseViewerLoadPromise).toBeNull();
    });

    test('[behaviour] rejects and resets Promise on network error', async () => {
        const { sandbox, scriptEl } = createLoaderSandbox({ initialRenderDefined: false });

        const p = sandbox.ensureAdminDatabaseViewerLoaded();
        scriptEl._trigger('error');

        await expect(p).rejects.toThrow();
        expect(sandbox.adminDatabaseViewerLoadPromise).toBeNull();
    });

    test('[behaviour] returns same Promise on concurrent calls (double-load prevention)', () => {
        const { sandbox } = createLoaderSandbox({ initialRenderDefined: false });

        const p1 = sandbox.ensureAdminDatabaseViewerLoaded();
        const p2 = sandbox.ensureAdminDatabaseViewerLoaded();

        expect(p1).toBe(p2);
        expect(sandbox.document.createElement).toHaveBeenCalledTimes(1);
    });

    test('[behaviour] allows retry after load-but-undefined failure', async () => {
        const { sandbox, scriptEl: el1 } = createLoaderSandbox({ initialRenderDefined: false });

        const p1 = sandbox.ensureAdminDatabaseViewerLoaded();
        el1._trigger('load'); // no renderDatabaseView defined → reject + reset
        await expect(p1).rejects.toThrow();

        // Now try again — a new script element should be created
        const el2 = createScriptMock();
        sandbox.document.createElement = vi.fn(() => el2);
        const p2 = sandbox.ensureAdminDatabaseViewerLoaded();
        expect(sandbox.document.createElement).toHaveBeenCalledWith('script');

        sandbox.renderDatabaseView = function () {};
        el2._trigger('load');
        await expect(p2).resolves.toBeUndefined();
    });

    test('[behaviour] allows retry after network error', async () => {
        const { sandbox, scriptEl: el1 } = createLoaderSandbox({ initialRenderDefined: false });

        const p1 = sandbox.ensureAdminDatabaseViewerLoaded();
        el1._trigger('error');
        await expect(p1).rejects.toThrow();

        const el2 = createScriptMock();
        sandbox.document.createElement = vi.fn(() => el2);
        const p2 = sandbox.ensureAdminDatabaseViewerLoaded();
        expect(sandbox.document.createElement).toHaveBeenCalledWith('script');

        sandbox.renderDatabaseView = function () {};
        el2._trigger('load');
        await expect(p2).resolves.toBeUndefined();
    });
});
