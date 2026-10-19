const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function deferred() {
    let resolve;
    const promise = new Promise((res) => { resolve = res; });
    return { promise, resolve };
}

function panel() {
    return {
        hidden: true,
        querySelectorAll: () => [],
        querySelector: (selector) => (selector === '.toolbar' ? { hidden: false } : null),
    };
}

// Real routes.js in a VM; only the collaborators of the tuner restore are stubbed.
function makeSandbox() {
    const appState = { portalAuthVerified: true, currentUserPermission: 'システム管理者', currentMemberTab: '', previousMemberTab: '' };
    const auth = [];
    const elements = new Map([
        ['memberPanel', panel()],
        ['adminPanel', panel()],
        ['systemPanel', panel()],
        ['portalLoginPanel', { hidden: true }],
        ['portalDrawerToggle', { hidden: false }],
        ['improvementSuggestionPanel', { hidden: true }],
        ['system-tunerTab', { hidden: true }],
        ['systemTunerHost', { id: 'systemTunerHost' }],
    ]);
    const launcher = { enter: vi.fn(async () => {}), leave: vi.fn(), preload: vi.fn(async () => true) };
    const popstate = [];
    const sandbox = {
        document: { createElement: vi.fn(() => ({ addEventListener: vi.fn() })), head: { appendChild: vi.fn() }, querySelector: () => null, querySelectorAll: () => [] },
        window: {
            portalRuntimeContext: { appState, getById: (id) => elements.get(id) || null },
            history: { state: null, replaceState: vi.fn(function (s) { this.state = s; }), pushState: vi.fn(function (s) { this.state = s; }) },
            addEventListener: vi.fn((type, fn) => { if (type === 'popstate') popstate.push(fn); }),
            scrollTo: vi.fn(),
            PortalTunerLauncher: launcher,
            // routes.js's own ensureImprovementSuggestionsLoaded() resolves when these exist.
            showImprovementSuggestions: vi.fn(),
            loadImprovementSuggestions: vi.fn(),
        },
        console,
        localStorage: { setItem: vi.fn(), removeItem: vi.fn(), getItem: vi.fn(() => '') },
        recordAccessLog: vi.fn(),
        ensureDeferredTabDataLoaded: vi.fn(async () => {}),
        renderPortalHome: vi.fn(),
        updateManagerNavigationVisibility: vi.fn(),
        showAlert: vi.fn(),
        showPortalLogin: vi.fn(),
        canAccessSystemAdmin: () => appState.currentUserPermission === 'システム管理者',
        isPortalAuthenticated: vi.fn(() => { const d = deferred(); auth.push(d); return d.promise; }),
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(read('src/static/js/modules/navigation/helpers.js'), sandbox);
    vm.runInContext(read('src/static/js/modules/navigation/routes.js'), sandbox);
    const restore = (panelId, tabName) => popstate[0]({ state: { portalNavigation: true, panelId, tabName } });
    return { sandbox, appState, elements, launcher, auth, restore };
}

const flush = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };

test.each([false, true])('delayed system-panel initialization respects a newer navigation (%s)', async (newer) => {
    const { sandbox, appState } = makeSandbox();
    const loading = deferred();
    const started = deferred();
    sandbox.isPortalAuthenticated = async () => ({ status: 'authenticated' });
    for (const name of ['ensureAdminSystemModuleLoaded', 'ensureAdminSystemApiLoaded', 'ensureImprovementSuggestionsLoaded',
        'ensurePartSettingsMigrated', 'ensureAdminEnvironmentManagementLoaded', 'refreshSystemEnvironmentMenuVisibility']) {
        sandbox[name] = vi.fn(async () => {});
    }
    for (const name of ['renderOrgManagement', 'renderSnsManagement', 'renderConnectionSettingsManagement', 'renderPartManagement']) {
        sandbox[name] = vi.fn();
    }
    sandbox.loadAuthManagement = vi.fn(() => { started.resolve(); return loading.promise; });
    sandbox.switchTab = vi.fn();
    appState.connectionSettings = [{}];
    const opening = sandbox.showSystemPanel();
    await started.promise;
    expect(sandbox.loadAuthManagement).toHaveBeenCalledTimes(1);
    if (newer) sandbox.nextPortalNavigation();
    loading.resolve();
    await opening;
    if (newer) expect(sandbox.switchTab).not.toHaveBeenCalled();
    else expect(sandbox.switchTab).toHaveBeenCalledWith('systemPanel', 'system-auth');
});

describe('tuner history restore never overrides a newer navigation', () => {
    test('a newer history restore wins over a tuner restore still waiting for auth', async () => {
        const { elements, launcher, auth, restore } = makeSandbox();
        const tuner = restore('systemPanel', 'system-tuner');
        await flush();
        expect(auth).toHaveLength(1); // the tuner restore is waiting
        await restore('memberPanel', 'member-home');
        expect(elements.get('memberPanel').hidden).toBe(false);
        auth[0].resolve({ status: 'authenticated' });
        await tuner;
        await flush();
        expect(elements.get('memberPanel').hidden).toBe(false);
        expect(elements.get('systemPanel').hidden).toBe(true);
        expect(elements.get('system-tunerTab').hidden).toBe(true);
        expect(launcher.enter).not.toHaveBeenCalled();
    });

    test('a normal screen change (switchTab) also cancels the waiting restore', async () => {
        const { sandbox, elements, launcher, auth, restore } = makeSandbox();
        const tuner = restore('systemPanel', 'system-tuner');
        await flush();
        await sandbox.switchTab('memberPanel', 'member-home', false);
        auth[0].resolve({ status: 'authenticated' });
        await tuner;
        expect(elements.get('system-tunerTab').hidden).toBe(true);
        expect(launcher.enter).not.toHaveBeenCalled();
    });

    test('logout while waiting cancels the restore', async () => {
        const { sandbox, appState, elements, launcher, auth, restore } = makeSandbox();
        const tuner = restore('systemPanel', 'system-tuner');
        await flush();
        // Logout path: the tuner exit invalidates pending navigations and auth is cleared.
        sandbox.window.invalidatePortalNavigation();
        appState.portalAuthVerified = false;
        auth[0].resolve({ status: 'authenticated' }); // stale answer from before the logout
        await tuner;
        expect(elements.get('system-tunerTab').hidden).toBe(true);
        expect(launcher.enter).not.toHaveBeenCalled();
    });

    test('auth lost during the remaining waits is re-checked before switching', async () => {
        const { sandbox, appState, elements, launcher, auth, restore } = makeSandbox();
        let finishLoad;
        sandbox.window.PortalTunerLauncher.preload.mockImplementation(() => new Promise((resolve) => { finishLoad = resolve; }));
        const tuner = restore('systemPanel', 'system-tuner');
        await flush();
        auth[0].resolve({ status: 'authenticated' });
        await flush();
        appState.portalAuthVerified = false;
        finishLoad(true);
        await tuner;
        expect(elements.get('system-tunerTab').hidden).toBe(true);
        expect(launcher.enter).not.toHaveBeenCalled();
    });

    test('an uncontested tuner restore still switches and enters', async () => {
        const { elements, launcher, auth, restore } = makeSandbox();
        const tuner = restore('systemPanel', 'system-tuner');
        await flush();
        auth[0].resolve({ status: 'authenticated' });
        await tuner;
        await flush();
        expect(elements.get('systemPanel').hidden).toBe(false);
        expect(elements.get('system-tunerTab').hidden).toBe(false);
        expect(launcher.enter).toHaveBeenCalledTimes(1);
    });
});
