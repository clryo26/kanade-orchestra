const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

describe('runtime bootstrap order', () => {
    test('index.html loads app_state before runtime_context and both before main', () => {
        const html = fs.readFileSync(path.resolve(__dirname, '../../src/index.html'), 'utf8');

        const appStatePos = html.indexOf('/static/js/store/app_state.js');
        const runtimePos = html.indexOf('/static/js/utils/runtime_context.js');
        const mainPos = html.indexOf('/static/js/main.js');

        expect(appStatePos).toBeGreaterThan(-1);
        expect(runtimePos).toBeGreaterThan(-1);
        expect(mainPos).toBeGreaterThan(-1);
        expect(appStatePos).toBeLessThan(runtimePos);
        expect(runtimePos).toBeLessThan(mainPos);
    });

    test('legacy app.js compatibility loader keeps app_state before runtime_context', () => {
        const appJs = fs.readFileSync(path.resolve(__dirname, '../../src/static/js/app.js'), 'utf8');

        const appStatePos = appJs.indexOf("'/static/js/store/app_state.js'");
        const runtimePos = appJs.indexOf("'/static/js/utils/runtime_context.js'");

        expect(appStatePos).toBeGreaterThan(-1);
        expect(runtimePos).toBeGreaterThan(-1);
        expect(appStatePos).toBeLessThan(runtimePos);
    });

    test('runtime_context avoids recursive legacy appState getter fallback', () => {
        const runtimeContextJs = fs.readFileSync(
            path.resolve(__dirname, '../../src/static/js/utils/runtime_context.js'),
            'utf8'
        );
        const sandbox = {
            window: null,
            globalThis: null,
            document: { getElementById: () => null },
        };
        sandbox.window = sandbox;
        sandbox.globalThis = sandbox;
        sandbox.portalCacheState = {
            dbCache: {},
            inFlightGetRequests: new Map(),
        };
        Object.defineProperty(sandbox, 'appState', {
            configurable: true,
            get() {
                return sandbox.portalRuntimeContext.appState;
            },
        });

        vm.runInNewContext(runtimeContextJs, sandbox);

        expect(() => sandbox.portalRuntimeContext.appState).not.toThrow();
        expect(sandbox.portalRuntimeContext.appState).toBeUndefined();
    });

    test('getAppState is stable and alias points to same object', () => {
        const appStateJs = fs.readFileSync(
            path.resolve(__dirname, '../../src/static/js/store/app_state.js'),
            'utf8'
        );
        const sandbox = {
            window: null,
            globalThis: null,
        };
        sandbox.window = sandbox;
        sandbox.globalThis = sandbox;

        vm.runInNewContext(appStateJs, sandbox);

        let first = null;
        for (let i = 0; i < 100; i += 1) {
            const state = sandbox.getAppState();
            expect(state).toBeTruthy();
            if (!first) first = state;
            expect(state).toBe(first);
        }
        expect(sandbox.appState).toBe(sandbox.portalAppState);
    });

    test('bootstrap_init binds resume listeners only once even if script is loaded twice', () => {
        const bootstrapInitJs = fs.readFileSync(
            path.resolve(__dirname, '../../src/static/js/modules/common_helpers/bootstrap_init.js'),
            'utf8'
        );

        const documentListeners = { DOMContentLoaded: [], visibilitychange: [] };
        const windowListeners = { online: [] };

        const sandbox = {
            window: null,
            globalThis: null,
            localStorage: {
                getItem: () => null,
            },
            document: {
                visibilityState: 'visible',
                addEventListener: (name, handler) => {
                    if (!documentListeners[name]) documentListeners[name] = [];
                    documentListeners[name].push(handler);
                },
            },
            setDefaultDates: () => {},
            setupPortalHome: () => {},
            setupMemberManagerTabs: () => {},
            bindNavigation: () => {},
            bindUpload: () => {},
            bindForms: () => {},
            bindDownloadConfirmations: () => {},
            updateSavePath: () => {},
            loadCloudRunRevision: () => {},
            isPortalAuthenticated: async () => false,
            enterPortal: async () => {},
            showPortalLogin: () => {},
            loadPartSettingsForLogin: () => {},
            loadEssentialData: async () => {},
            showAlert: () => {},
            console,
        };
        sandbox.window = sandbox;
        sandbox.globalThis = sandbox;
        sandbox.window.addEventListener = (name, handler) => {
            if (!windowListeners[name]) windowListeners[name] = [];
            windowListeners[name].push(handler);
        };
        sandbox.portalRuntimeContext = {
            appState: { portalAuthVerified: false, essentialDataLoaded: false },
            getById: () => null,
            dbCache: { init: async () => {} },
            PORTAL_AUTH_KEY: 'kanadePortalAuthenticated',
        };

        vm.runInNewContext(bootstrapInitJs, sandbox);
        vm.runInNewContext(bootstrapInitJs, sandbox);

        expect(documentListeners.DOMContentLoaded).toHaveLength(1);

        // Simulate DOMContentLoaded callback to register resume listeners.
        return Promise.resolve(documentListeners.DOMContentLoaded[0]()).then(() => {
            expect(documentListeners.visibilitychange).toHaveLength(1);
            expect(windowListeners.online).toHaveLength(1);
        });
    });
});
