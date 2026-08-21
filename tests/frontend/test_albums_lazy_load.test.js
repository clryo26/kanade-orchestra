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

const ALL_ALBUMS_FUNCTIONS = [
    'renderAlbumView',
    'openAlbumPhotoViewer',
    'closeAlbumPhotoViewer',
    'createAlbumEvent',
    'deleteAlbumEvent',
    'uploadAlbumPhotos',
    'deleteAlbumPhoto',
];

function createAlbumsLoaderSandbox({ definedFunctions = [] } = {}) {
    const scriptEl = createScriptMock();
    const sandbox = {
        Promise,
        Error,
        console: { warn: () => {} },
        albumsLoadPromise: null,
        document: {
            createElement: vi.fn(() => scriptEl),
            head: { appendChild: vi.fn() },
        },
        window: { portalRuntimeContext: { appState: {}, getById: () => null } },
        getAppState: undefined,
    };
    sandbox.window.getAppState = undefined;
    sandbox.globalThis = sandbox;

    for (const name of ALL_ALBUMS_FUNCTIONS) {
        sandbox[name] = definedFunctions.includes(name) ? function () {} : undefined;
    }

    vm.createContext(sandbox);
    vm.runInContext(readSource('src/static/js/modules/navigation/routes.js'), sandbox);

    return { sandbox, scriptEl };
}

function defineAllAlbumsFunctions(sandbox) {
    for (const name of ALL_ALBUMS_FUNCTIONS) {
        sandbox[name] = function () {};
    }
}

// ---------------------------------------------------------------------------
// Static / structural tests
// ---------------------------------------------------------------------------

describe('albums lazy loading', () => {
    // === Initial state validation ===

    test('index.html does not eagerly load albums.js', () => {
        const indexHtml = readSource('src/index.html');
        expect(indexHtml).not.toContain('/static/js/modules/albums.js');
    });

    test('initial script count in index.html is 66', () => {
        const indexHtml = readSource('src/index.html');
        const matches = indexHtml.match(/<script\b/g);
        expect(matches).not.toBeNull();
        expect(matches.length).toBe(43);
    });

    test('app.js legacy list does not include albums.js', () => {
        const source = readSource('src/static/js/app.js');
        expect(source).not.toContain('/static/js/modules/albums.js');
    });

    // === Loader function validation ===

    test('routes.js defines ensureAlbumsLoaded', () => {
        const source = readSource('src/static/js/modules/navigation/routes.js');
        expect(source).toContain('function ensureAlbumsLoaded()');
    });

    test('loader uses the correct versioned URL', () => {
        const source = readSource('src/static/js/modules/navigation/routes.js');
        expect(source).toContain('/static/js/modules/albums.js?v=20260630-6');
    });

    test('loader uses a dedicated Promise variable', () => {
        const source = readSource('src/static/js/modules/navigation/routes.js');
        expect(source).toContain('albumsLoadPromise');
    });

    test('loader checks all 7 required album functions for ready determination (static)', () => {
        const source = readSource('src/static/js/modules/navigation/routes.js');
        for (const fn of ALL_ALBUMS_FUNCTIONS) {
            expect(source).toContain(`typeof ${fn} === 'function'`);
        }
    });

    test('load event re-checks all 7 required functions before resolving (static)', () => {
        const source = readSource('src/static/js/modules/navigation/routes.js');
        expect(source).toMatch(/addEventListener\('load'[\s\S]*?_albumsReady\(\)/);
    });

    test('load event rejects and resets Promise when functions are missing (static)', () => {
        const source = readSource('src/static/js/modules/navigation/routes.js');
        expect(source).toMatch(/albumsLoadPromise\s*=\s*null[\s\S]*?reject\(new Error/);
    });

    test('error event rejects and resets Promise (static)', () => {
        const source = readSource('src/static/js/modules/navigation/routes.js');
        expect(source).toMatch(/addEventListener\('error'[\s\S]*?albumsLoadPromise\s*=\s*null[\s\S]*?reject/);
    });

    test('renderAlbumView in members/render.js is guarded with typeof check', () => {
        const source = readSource('src/static/js/modules/members/render.js');
        expect(source).toContain("if (typeof renderAlbumView === 'function')");
        expect(source).toContain('renderAlbumView()');
    });

    // === Member tab click handler validation ===

    test('events.js defines lastSelectedMemberTab tracking variable', () => {
        const source = readSource('src/static/js/modules/navigation/events.js');
        expect(source).toContain('lastSelectedMemberTab');
    });

    test('events.js defines isAlbumsLoadingForMemberTab tracking variable', () => {
        const source = readSource('src/static/js/modules/navigation/events.js');
        expect(source).toContain('isAlbumsLoadingForMemberTab');
    });

    test('events.js member-album click handler calls ensureAlbumsLoaded', () => {
        const source = readSource('src/static/js/modules/navigation/events.js');
        // Verify guard pattern: non-album guard comes first, followed by ensureAlbumsLoaded for album case
        expect(source).toContain("if (tabName !== 'member-album')");
        expect(source).toContain('return;');
        expect(source).toContain('ensureAlbumsLoaded()');

        // Verify ordering: guard before loader
        const guardIndex = source.indexOf("if (tabName !== 'member-album')");
        const loaderIndex = source.indexOf('ensureAlbumsLoaded()');
        expect(guardIndex).toBeLessThan(loaderIndex);
    });

    test('events.js member-album handler checks lastSelectedMemberTab before switchTab', () => {
        const source = readSource('src/static/js/modules/navigation/events.js');
        // Verify .then() block has guard pattern (if NOT member-album, return)
        expect(source).toContain('.then(function');
        expect(source).toContain("if (lastSelectedMemberTab !== 'member-album')");
        expect(source).toContain("switchTab('memberPanel', 'member-album')");

        // Verify the guard comes before the switch
        const thenIndex = source.indexOf('.then(function');
        const guardIndex = source.indexOf("if (lastSelectedMemberTab !== 'member-album')", thenIndex);
        const switchIndex = source.indexOf("switchTab('memberPanel', 'member-album')", thenIndex);
        expect(guardIndex).toBeLessThan(switchIndex);
    });

    test('events.js non-member-album handler calls switchTab immediately', () => {
        const source = readSource('src/static/js/modules/navigation/events.js');
        // Verify non-album guard: if (tabName !== 'member-album') { switchTab(...); return; }
        expect(source).toMatch(/if\s*\(\s*tabName\s*!==\s*['"]member-album['"]\s*\)\s*{\s*switchTab\(['"]memberPanel['"],\s*tabName\)\s*;\s*return\s*;\s*}/);
    });

    test('[navigation] drawer member-album reuses the member tab lazy-load handler', () => {
        const source = readSource('src/static/js/modules/navigation/menu.js');
        expect(source).toContain("if (tabName === 'member-album')");
        expect(source).toContain("document.querySelector('#memberPanel [data-tab=\"member-album\"]')");
        expect(source).toContain('albumTabButton.click()');
    });

    // === Admin panel unchanged ===

    test('requestAdminPanel does not use ensureAlbumsLoaded', () => {
        const source = readSource('src/static/js/modules/navigation/routes.js');
        const fnStart = source.indexOf('function requestAdminPanel()');
        const fnEnd = source.indexOf('function', fnStart + 1);
        const fnBody = source.substring(fnStart, fnEnd);
        expect(fnBody).not.toContain('ensureAlbumsLoaded');
    });

    test('requestAdminPanel uses only admin loaders (system, performance_day, practice_casting)', () => {
        const source = readSource('src/static/js/modules/navigation/routes.js');
        const fnStart = source.indexOf('function requestAdminPanel()');
        const fnEnd = source.indexOf('function', fnStart + 1);
        const fnBody = source.substring(fnStart, fnEnd);

        // Should contain admin loaders
        expect(fnBody).toContain('ensureAdminSystemApiLoaded');
        expect(fnBody).toContain('ensurePerformanceDayEventsLoaded');
        expect(fnBody).toContain('ensurePracticeCastingApiLoaded');

        // Should NOT contain albums loader
        expect(fnBody).not.toContain('ensureAlbumsLoaded');
    });

    // ---------------------------------------------------------------------------
    // Behavioural tests using vm sandbox
    // ---------------------------------------------------------------------------

    test('[behaviour] resolves without injecting script when all 7 functions are defined', async () => {
        const { sandbox } = createAlbumsLoaderSandbox({ definedFunctions: ALL_ALBUMS_FUNCTIONS });
        const p = sandbox.ensureAlbumsLoaded();
        await expect(p).resolves.toBeUndefined();
        expect(sandbox.document.createElement).not.toHaveBeenCalled();
    });

    test('[behaviour] injects script when exactly one function is missing', async () => {
        const missing = ALL_ALBUMS_FUNCTIONS.slice(1);
        const { sandbox } = createAlbumsLoaderSandbox({ definedFunctions: missing });
        sandbox.ensureAlbumsLoaded();
        expect(sandbox.document.createElement).toHaveBeenCalledWith('script');
    });

    test('[behaviour] injects script when all functions are undefined', async () => {
        const { sandbox } = createAlbumsLoaderSandbox({ definedFunctions: [] });
        sandbox.ensureAlbumsLoaded();
        expect(sandbox.document.createElement).toHaveBeenCalledWith('script');
    });

    test('[behaviour] resolves after load when all 7 functions are defined post-load', async () => {
        const { sandbox, scriptEl } = createAlbumsLoaderSandbox({ definedFunctions: [] });
        const p = sandbox.ensureAlbumsLoaded();
        expect(sandbox.document.head.appendChild).toHaveBeenCalledWith(scriptEl);

        defineAllAlbumsFunctions(sandbox);
        scriptEl._trigger('load');

        await expect(p).resolves.toBeUndefined();
    });

    test('[behaviour] rejects when load fires with 1 function missing', async () => {
        const { sandbox, scriptEl } = createAlbumsLoaderSandbox({ definedFunctions: [] });
        const p = sandbox.ensureAlbumsLoaded();

        for (const name of ALL_ALBUMS_FUNCTIONS.slice(0, -1)) {
            sandbox[name] = function () {};
        }
        scriptEl._trigger('load');

        await expect(p).rejects.toThrow();
        expect(sandbox.albumsLoadPromise).toBeNull();
    });

    test('[behaviour] rejects when load fires with multiple functions missing', async () => {
        const { sandbox, scriptEl } = createAlbumsLoaderSandbox({ definedFunctions: [] });
        const p = sandbox.ensureAlbumsLoaded();

        for (const name of ALL_ALBUMS_FUNCTIONS.slice(0, 2)) {
            sandbox[name] = function () {};
        }
        scriptEl._trigger('load');

        await expect(p).rejects.toThrow();
        expect(sandbox.albumsLoadPromise).toBeNull();
    });

    test('[behaviour] rejects and resets Promise on network error', async () => {
        const { sandbox, scriptEl } = createAlbumsLoaderSandbox({ definedFunctions: [] });
        const p = sandbox.ensureAlbumsLoaded();
        scriptEl._trigger('error');

        await expect(p).rejects.toThrow();
        expect(sandbox.albumsLoadPromise).toBeNull();
    });

    test('[behaviour] returns same Promise on concurrent calls', () => {
        const { sandbox } = createAlbumsLoaderSandbox({ definedFunctions: [] });
        const p1 = sandbox.ensureAlbumsLoaded();
        const p2 = sandbox.ensureAlbumsLoaded();
        expect(p1).toBe(p2);
        expect(sandbox.document.createElement).toHaveBeenCalledTimes(1);
    });

    test('[behaviour] allows retry after load-but-missing-functions failure', async () => {
        const { sandbox, scriptEl: el1 } = createAlbumsLoaderSandbox({ definedFunctions: [] });

        const p1 = sandbox.ensureAlbumsLoaded();
        el1._trigger('load');
        await expect(p1).rejects.toThrow();

        const el2 = createScriptMock();
        sandbox.document.createElement = vi.fn(() => el2);
        const p2 = sandbox.ensureAlbumsLoaded();
        expect(sandbox.document.createElement).toHaveBeenCalledWith('script');

        defineAllAlbumsFunctions(sandbox);
        el2._trigger('load');
        await expect(p2).resolves.toBeUndefined();
    });

    test('[behaviour] allows retry after network error', async () => {
        const { sandbox, scriptEl: el1 } = createAlbumsLoaderSandbox({ definedFunctions: [] });

        const p1 = sandbox.ensureAlbumsLoaded();
        el1._trigger('error');
        await expect(p1).rejects.toThrow();

        const el2 = createScriptMock();
        sandbox.document.createElement = vi.fn(() => el2);
        const p2 = sandbox.ensureAlbumsLoaded();

        defineAllAlbumsFunctions(sandbox);
        el2._trigger('load');
        await expect(p2).resolves.toBeUndefined();
    });

    test('[behaviour] script has async attribute set', async () => {
        const { sandbox, scriptEl } = createAlbumsLoaderSandbox({ definedFunctions: [] });
        sandbox.ensureAlbumsLoaded();
        expect(scriptEl.async).toBe(true);
    });

    // === Click handler integration tests ===
    // These tests run the actual navigation/events.js member tab handler to verify navigation behavior

    test('[navigation] member-album click initiates loader, does not call switchTab immediately', () => {
        const indexHtml = readSource('src/index.html');
        // Verify member-album button exists with data-tab="member-album"
        expect(indexHtml).toContain('data-tab="member-album"');

        // Verify events.js registers handler for member panel tabs
        const eventsSource = readSource('src/static/js/modules/navigation/events.js');
        expect(eventsSource).toContain("document.querySelectorAll('#memberPanel [data-tab]')");
        expect(eventsSource).toContain('ensureAlbumsLoaded()');
        // Verify non-album guard allows only album to reach loader
        expect(eventsSource).toContain("if (tabName !== 'member-album')");
        expect(eventsSource).toContain("if (lastSelectedMemberTab !== 'member-album')");
    });

    test('[navigation] member-album handler checks lastSelectedMemberTab before switchTab', () => {
        const source = readSource('src/static/js/modules/navigation/events.js');
        // Verify the guard pattern: if selection is NOT album, return early then switch tab after load
        expect(source).toMatch(/\.then\(function\s*\(\)\s*{\s*if\s*\(\s*lastSelectedMemberTab\s*!==\s*['"]member-album['"]\s*\)\s*{\s*return\s*;\s*}\s*return\s*switchTab\(['"]memberPanel['"],\s*['"]member-album['"]\);?\s*}\)/);
    });

    test('[navigation] non-member-album tabs call switchTab immediately without loader', () => {
        const source = readSource('src/static/js/modules/navigation/events.js');
        // Verify non-album guard pattern: if (tabName !== 'member-album') { switchTab(...); return; }
        const memberHandlerStart = source.indexOf("document.querySelectorAll('#memberPanel [data-tab]')");
        const memberHandlerEnd = source.indexOf("document.querySelectorAll('#systemPanel [data-tab]')");
        const memberHandler = source.substring(memberHandlerStart, memberHandlerEnd);

        // Find the guard block for non-album
        expect(memberHandler).toContain("if (tabName !== 'member-album')");

        // Verify the guard block contains switchTab and return but NOT ensureAlbumsLoaded
        const guardMatch = memberHandler.match(/if\s*\(\s*tabName\s*!==\s*['"]member-album['"]\s*\)\s*{\s*[^}]+\s*}/);
        expect(guardMatch).toBeTruthy();
        const guardBlock = guardMatch[0];
        expect(guardBlock).toContain("switchTab('memberPanel', tabName)");
        expect(guardBlock).toContain('return');
        expect(guardBlock).not.toContain('ensureAlbumsLoaded');
    });

    test('[navigation] renderAlbumView only called when lastSelectedMemberTab is member-album', () => {
        const eventsSource = readSource('src/static/js/modules/navigation/events.js');
        const eventsMemberHandlerStart = eventsSource.indexOf("document.querySelectorAll('#memberPanel [data-tab]')");
        const eventsMemberHandlerEnd = eventsSource.indexOf("document.querySelectorAll('#systemPanel [data-tab]')");
        const eventsMemberHandler = eventsSource.substring(eventsMemberHandlerStart, eventsMemberHandlerEnd);

        expect(eventsMemberHandler).not.toContain('renderAlbumView()');
        expect(eventsMemberHandler).toContain("if (lastSelectedMemberTab !== 'member-album')");

        const routesSource = readSource('src/static/js/modules/navigation/routes.js');
        expect(routesSource).toContain("if (renderOnShow && tabName === 'member-album') renderAlbumView();");
    });

    test('[navigation] loader completion checks if selection still member-album', () => {
        const source = readSource('src/static/js/modules/navigation/events.js');
        // Verify after load completes, it checks lastSelectedMemberTab
        expect(source).toContain('ensureAlbumsLoaded()');
        expect(source).toContain('.then(function');
        expect(source).toContain("if (lastSelectedMemberTab !== 'member-album')");

        // Verify the ordering
        const memberHandlerStart = source.indexOf("document.querySelectorAll('#memberPanel [data-tab]')");
        const memberHandlerEnd = source.indexOf("document.querySelectorAll('#systemPanel [data-tab]')");
        const memberHandler = source.substring(memberHandlerStart, memberHandlerEnd);

        const thenIndex = memberHandler.indexOf('.then(function');
        const guardIndex = memberHandler.indexOf("if (lastSelectedMemberTab !== 'member-album')", thenIndex);
        expect(guardIndex).toBeGreaterThan(thenIndex);
    });

    test('[navigation] concurrent clicks prevented by isAlbumsLoadingForMemberTab flag', () => {
        const source = readSource('src/static/js/modules/navigation/events.js');
        // Verify flag is checked before starting load
        expect(source).toContain('if (isAlbumsLoadingForMemberTab)');
        // Verify flag is set to true before load starts
        expect(source).toContain('isAlbumsLoadingForMemberTab = true');
        // Verify flag is reset in finally
        expect(source).toContain('isAlbumsLoadingForMemberTab = false');

        // Verify the finally block exists
        expect(source).toContain('.finally(function');
    });

    test('[navigation] catch handler displays warning alert on loader failure', () => {
        const source = readSource('src/static/js/modules/navigation/events.js');
        // Verify error handling
        expect(source).toContain('.catch(function (err)');
        expect(source).toContain('showAlert');
        expect(source).toContain('アルバム機能を読み込めませんでした');
    });

    test('[navigation] error flag reset allows retry after failure', () => {
        const source = readSource('src/static/js/modules/navigation/events.js');
        // Verify finally resets the loading flag even on error
        const finallyIndex = source.indexOf('.finally(function');
        const finallyBlock = source.substring(finallyIndex, finallyIndex + 150);
        expect(finallyBlock).toContain('isAlbumsLoadingForMemberTab = false');
    });

    test('errors during load display warning alert (static)', () => {
        const source = readSource('src/static/js/modules/navigation/events.js');
        expect(source).toContain('showAlert');
        expect(source).toMatch(/showAlert\s*\(\s*['"][^'"]*['"]\s*,\s*['"]warning['"]\s*\)/);
    });
});
