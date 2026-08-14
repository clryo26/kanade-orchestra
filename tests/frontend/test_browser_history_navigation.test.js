const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '../..');

function readSource(rel) {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function createPanel() {
    const buttons = new Map();
    return {
        hidden: false,
        querySelectorAll: vi.fn((selector) => {
            if (selector === '.tab-content') return [];
            if (selector === '[data-tab]') return Array.from(buttons.values());
            return [];
        }),
        querySelector: vi.fn((selector) => {
            if (selector === '.toolbar') return { hidden: false };
            const match = selector.match(/^\[data-tab="(.+)"\]$/);
            if (!match) return null;
            if (!buttons.has(match[1])) {
                buttons.set(match[1], {
                    dataset: { tab: match[1] },
                    classList: { add: vi.fn(), remove: vi.fn() },
                });
            }
            return buttons.get(match[1]);
        }),
    };
}

function makeSandbox() {
    const appState = {
        currentMemberTab: '',
        previousMemberTab: '',
        currentUserPermission: '管理者',
    };
    const memberPanel = createPanel();
    const adminPanel = createPanel();
    const systemPanel = createPanel();
    const elements = new Map([
        ['memberPanel', memberPanel],
        ['adminPanel', adminPanel],
        ['systemPanel', systemPanel],
        ['portalLoginPanel', { hidden: true }],
        ['portalDrawerToggle', { hidden: false }],
        ['improvementSuggestionPanel', { hidden: true }],
    ]);
    const popstateListeners = [];

    const history = {
        state: null,
        replaceState: vi.fn(function (state) {
            this.state = state;
        }),
        pushState: vi.fn(function (state) {
            this.state = state;
        }),
    };

    const sandbox = {
        document: {
            createElement: vi.fn(() => ({
                addEventListener: vi.fn(),
            })),
            head: { appendChild: vi.fn() },
            querySelector: vi.fn(() => null),
            querySelectorAll: vi.fn(() => []),
        },
        window: {
            portalRuntimeContext: {
                appState,
                getById: (id) => elements.get(id) || null,
            },
            history,
            addEventListener: vi.fn((type, listener) => {
                if (type === 'popstate') popstateListeners.push(listener);
            }),
            scrollTo: vi.fn(),
        },
        globalThis: null,
        console,
        appState,
        localStorage: {
            setItem: vi.fn(),
            removeItem: vi.fn(),
            getItem: vi.fn(() => ''),
        },
        recordAccessLog: vi.fn(),
        ensureDeferredTabDataLoaded: vi.fn(async () => {}),
        renderPortalHome: vi.fn(),
        renderFlyerDistributionView: vi.fn(),
        renderPerformanceDayInfoView: vi.fn(),
        renderConcertRecordView: vi.fn(),
        renderManualView: vi.fn(),
        renderAlbumView: vi.fn(),
        ensureRecordingsLoaded: vi.fn(),
        ensureSheetsLoaded: vi.fn(),
        renderDateAdjustmentView: vi.fn(),
        renderPieceInfoView: vi.fn(),
        renderAnnouncementDetail: vi.fn(),
        renderSchedulePerformanceOptions: vi.fn(),
        updateSchedulePieceOptions: vi.fn(),
        renderSchedules: vi.fn(),
        renderEvents: vi.fn(),
        renderMembers: vi.fn(),
        showMemberIntroView: vi.fn(async () => {}),
        renderSheetAdmin: vi.fn(),
        renderPaymentAdmin: vi.fn(),
        renderVenueManagement: vi.fn(),
        loadExtraData: vi.fn(async () => {}),
        renderFlyerDistributionManagement: vi.fn(),
        renderCastingAdmin: vi.fn(),
        renderPerformanceDayInfoAdmin: vi.fn(),
        renderConcertRecordAdminView: vi.fn(),
        renderOrgManagement: vi.fn(),
        ensureSystemPermissionManagementLoaded: vi.fn(async () => {}),
        renderSystemPermissionManagement: vi.fn(async () => {}),
        renderSnsManagement: vi.fn(),
        renderConnectionSettingsManagement: vi.fn(),
        ensureAdminEnvironmentManagementLoaded: vi.fn(async () => {}),
        renderSystemEnvironmentManagement: vi.fn(),
        renderReadinessDashboard: vi.fn(),
        ensureAdminDatabaseViewerLoaded: vi.fn(async () => {}),
        renderDatabaseView: vi.fn(),
        updateManagerNavigationVisibility: vi.fn(),
        showAlert: vi.fn(),
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(readSource('src/static/js/modules/navigation/helpers.js'), sandbox);
    vm.runInContext(readSource('src/static/js/modules/navigation/routes.js'), sandbox);

    return {
        sandbox,
        appState,
        elements,
        history,
        popstateListeners,
    };
}

describe('portal browser history navigation', () => {
    test('first portal screen replaces the current browser entry and later screens are pushed', async () => {
        const { sandbox, history } = makeSandbox();

        await sandbox.switchTab('memberPanel', 'member-home', false);

        expect(history.replaceState).toHaveBeenCalledTimes(1);
        expect(history.replaceState).toHaveBeenLastCalledWith(
            {
                portalNavigation: true,
                panelId: 'memberPanel',
                tabName: 'member-home',
            },
            ''
        );
        expect(history.pushState).not.toHaveBeenCalled();

        await sandbox.switchTab('memberPanel', 'member-sheet', false);

        expect(history.pushState).toHaveBeenCalledTimes(1);
        expect(history.pushState).toHaveBeenLastCalledWith(
            {
                portalNavigation: true,
                panelId: 'memberPanel',
                tabName: 'member-sheet',
            },
            ''
        );
    });

    test('same portal screen does not create duplicate browser history entries', async () => {
        const { sandbox, history } = makeSandbox();

        await sandbox.switchTab('memberPanel', 'member-home', false);
        await sandbox.switchTab('memberPanel', 'member-home', false);

        expect(history.replaceState).toHaveBeenCalledTimes(1);
        expect(history.pushState).not.toHaveBeenCalled();
    });

    test('popstate restores the previous portal panel and tab without pushing another entry', async () => {
        const { sandbox, appState, elements, history, popstateListeners } = makeSandbox();

        await sandbox.switchTab('memberPanel', 'member-home', false);
        await sandbox.switchTab('adminPanel', 'performance', false);
        expect(history.pushState).toHaveBeenCalledTimes(1);
        expect(popstateListeners).toHaveLength(1);

        const pushCountBeforeRestore = history.pushState.mock.calls.length;
        await popstateListeners[0]({
            state: {
                portalNavigation: true,
                panelId: 'memberPanel',
                tabName: 'member-home',
            },
        });

        expect(history.pushState).toHaveBeenCalledTimes(pushCountBeforeRestore);
        expect(elements.get('memberPanel').hidden).toBe(false);
        expect(elements.get('adminPanel').hidden).toBe(true);
        expect(elements.get('systemPanel').hidden).toBe(true);
        expect(appState.currentMemberTab).toBe('member-home');
        expect(sandbox.localStorage.setItem).toHaveBeenLastCalledWith('userRole', 'member');
        expect(sandbox.updateManagerNavigationVisibility).toHaveBeenCalled();
    });
});
