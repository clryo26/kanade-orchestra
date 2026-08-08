const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '../..');

function readSource(rel) {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function createElement(id) {
    return {
        id,
        hidden: false,
        textContent: '',
        href: '',
        value: '',
        classList: {
            add: vi.fn(),
            remove: vi.fn(),
        },
        _listeners: {},
        addEventListener(type, fn) {
            this._listeners[type] = fn;
        },
        click() {
            if (this._listeners.click) {
                return this._listeners.click();
            }
            return undefined;
        },
        querySelectorAll: vi.fn(() => []),
        querySelector: vi.fn(() => null),
        closest: vi.fn(() => null),
        insertAdjacentHTML: vi.fn(),
    };
}

function createPanel() {
    const tabContents = [createElement('memberSheetTab'), createElement('memberSheetViewerTab'), createElement('memberDesiredPieceTab')];
    const tabButtons = [
        { dataset: { tab: 'member-sheet' }, classList: { add: vi.fn(), remove: vi.fn() } },
        { dataset: { tab: 'member-sheet-viewer' }, classList: { add: vi.fn(), remove: vi.fn() } },
        { dataset: { tab: 'member-desired-piece' }, classList: { add: vi.fn(), remove: vi.fn() } },
    ];
    const activeButtonMap = new Map(tabButtons.map((button) => [button.dataset.tab, button]));
    return {
        hidden: false,
        querySelectorAll: vi.fn((selector) => {
            if (selector === '.tab-content') return tabContents;
            if (selector === '[data-tab]') return tabButtons;
            return [];
        }),
        querySelector: vi.fn((selector) => {
            const match = selector.match(/^\[data-tab="(.+)"\]$/);
            if (match) return activeButtonMap.get(match[1]) || null;
            if (selector === '.toolbar') return createElement('toolbar');
            return null;
        }),
    };
}

function makeSwitchTabSandbox() {
    const appState = {
        currentMemberTab: '',
        previousMemberTab: '',
        portalAuthVerified: false,
        desiredPieces: [],
        sheetLibrary: [],
        sheetPdfUrl: '',
        sheetPdfScale: 1,
        sheetPdfRendering: false,
    };
    const memberPanel = createPanel();
    const elements = new Map([
        ['memberPanel', memberPanel],
        ['memberSheetTab', createElement('memberSheetTab')],
        ['memberSheetViewerTab', createElement('memberSheetViewerTab')],
        ['memberDesiredPieceTab', createElement('memberDesiredPieceTab')],
    ]);
    const sandbox = {
        document: {
            querySelector: vi.fn(() => null),
            querySelectorAll: vi.fn(() => []),
        },
        window: {
            portalRuntimeContext: {
                appState,
                getById: (id) => elements.get(id) || null,
            },
            scrollTo: vi.fn(),
        },
        globalThis: null,
        console,
        appState,
        showAlert: vi.fn(),
        renderMemberViews: vi.fn(),
        ensureDeferredTabDataLoaded: vi.fn(async () => {}),
        ensureSheetsLoaded: vi.fn(async () => {}),
        renderPortalHome: vi.fn(),
        renderFlyerDistributionView: vi.fn(),
        renderPerformanceDayInfoView: vi.fn(),
        renderConcertRecordView: vi.fn(),
        renderManualView: vi.fn(),
        renderAlbumView: vi.fn(),
        ensureRecordingsLoaded: vi.fn(),
        renderDateAdjustmentView: vi.fn(),
        renderPieceInfoView: vi.fn(),
        renderAnnouncementDetail: vi.fn(),
        renderSchedulePerformanceOptions: vi.fn(),
        updateSchedulePieceOptions: vi.fn(),
        renderSchedules: vi.fn(),
        renderEvents: vi.fn(),
        renderMembers: vi.fn(),
        showMemberIntroView: vi.fn(async () => {}),
        renderPaymentAdmin: vi.fn(),
        renderVenueManagement: vi.fn(),
        renderFlyerDistributionManagement: vi.fn(),
        renderCastingAdmin: vi.fn(),
        renderPerformanceDayInfoAdmin: vi.fn(),
        renderConcertRecordAdminView: vi.fn(),
        renderOrgManagement: vi.fn(),
        renderSnsManagement: vi.fn(),
        renderConnectionSettingsManagement: vi.fn(),
        ensureAdminEnvironmentManagementLoaded: vi.fn(async () => {}),
        renderSystemEnvironmentManagement: vi.fn(),
        renderReadinessDashboard: vi.fn(),
        renderAccessLogView: vi.fn(),
        ensureAdminDatabaseViewerLoaded: vi.fn(async () => {}),
        renderDatabaseView: vi.fn(),
        recordAccessLog: vi.fn(),
        isPortalAuthenticated: vi.fn(async () => ({ status: 'authenticated' })),
        showPortalLogin: vi.fn(),
        updateManagerNavigationVisibility: vi.fn(),
        localStorage: {
            setItem: vi.fn(),
            removeItem: vi.fn(),
            getItem: vi.fn(() => ''),
        },
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(readSource('src/static/js/modules/navigation/helpers.js'), sandbox);
    vm.runInContext(readSource('src/static/js/modules/navigation/routes.js'), sandbox);
    return { sandbox, appState, elements };
}

function makeViewerSandbox() {
    const appState = {
        currentMemberTab: 'member-desired-piece',
        previousMemberTab: 'member-desired-piece',
        desiredPieces: [
            {
                id: 9,
                title: 'Score Piece',
                piece: 'Score Piece',
                reference_score_url: '/api/extra/desired_pieces/9/reference_score',
                votes: [],
            },
        ],
        sheetLibrary: [
            {
                id: 1,
                name: 'Sheet A.pdf',
                url: '/api/sheets/1',
                download_url: '/api/sheets/1/download',
                view_url: '/api/sheets/1/view',
                performance_id: 11,
                piece: 'Piece A',
                part: 'Vn',
                performance_title: 'Concert A',
            },
        ],
        sheetPdfUrl: '',
        sheetPdfScale: 1,
        sheetPdfRendering: false,
    };
    const elements = new Map([
        ['sheetViewerTitle', createElement('sheetViewerTitle')],
        ['sheetViewerDownload', createElement('sheetViewerDownload')],
        ['sheetViewerBackBtn', createElement('sheetViewerBackBtn')],
        ['sheetViewerMenuBtn', createElement('sheetViewerMenuBtn')],
        ['sheetViewerZoomOut', createElement('sheetViewerZoomOut')],
        ['sheetViewerZoomIn', createElement('sheetViewerZoomIn')],
        ['sheetViewerFitWidth', createElement('sheetViewerFitWidth')],
        ['sheetViewerPages', createElement('sheetViewerPages')],
        ['sheetViewerStatus', createElement('sheetViewerStatus')],
    ]);
    const sandbox = {
        document: {
            querySelector: vi.fn(() => null),
            querySelectorAll: vi.fn(() => []),
        },
        window: {
            portalRuntimeContext: {
                appState,
                getById: (id) => elements.get(id) || null,
            },
            scrollTo: vi.fn(),
        },
        globalThis: null,
        console,
        appState,
        displayNameWithoutExtension: (value) => String(value || '').replace(/\.pdf$/i, ''),
        showAlert: vi.fn(),
        switchTab: vi.fn(),
        renderPdfViewer: vi.fn(async () => {}),
        clearSheetViewer: vi.fn(),
        showMemberTab: vi.fn(),
        request: vi.fn(),
        confirmDelete: vi.fn(() => true),
        withButtonStatus: (_button, _label, callback) => callback(),
        jsonOptions: vi.fn(),
        saveDesiredPiece: vi.fn(),
        toggleDesiredPieceVote: vi.fn(),
        deleteDesiredPiece: vi.fn(),
        savePromotion: vi.fn(),
        deletePromotion: vi.fn(),
        saveOrgMembershipFee: vi.fn(),
        savePerformanceFee: vi.fn(),
        previewPromotionImage: vi.fn(),
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(readSource('src/static/js/modules/scores.js'), sandbox);
    vm.runInContext(readSource('src/static/js/modules/date_piece_promotion/events.js'), sandbox);
    vm.runInContext(readSource('src/static/js/modules/navigation/events.js'), sandbox);
    sandbox.clearSheetViewer = vi.fn(sandbox.clearSheetViewer);
    return { sandbox, appState, elements };
}

describe('sheet viewer navigation regression', () => {
    test('switchTab remembers the previous member tab without using browser history', async () => {
        const { sandbox, appState } = makeSwitchTabSandbox();

        await sandbox.switchTab('memberPanel', 'member-sheet');
        expect(appState.currentMemberTab).toBe('member-sheet');
        expect(appState.previousMemberTab).toBe('');

        await sandbox.switchTab('memberPanel', 'member-sheet-viewer', false);
        expect(appState.currentMemberTab).toBe('member-sheet-viewer');
        expect(appState.previousMemberTab).toBe('member-sheet');

        await sandbox.switchTab('memberPanel', 'member-desired-piece');
        expect(appState.currentMemberTab).toBe('member-desired-piece');
        expect(appState.previousMemberTab).toBe('member-sheet-viewer');
    });

    test('shared PDF viewer hides the library back button for reference scores and restores it for sheets', async () => {
        const { sandbox, elements } = makeViewerSandbox();

        await sandbox.showDesiredPieceReferenceScore(9);
        expect(elements.get('sheetViewerBackBtn').hidden).toBe(true);
        expect(elements.get('sheetViewerDownload').href).toBe('/api/extra/desired_pieces/9/reference_score');
        expect(sandbox.switchTab).toHaveBeenCalledWith('memberPanel', 'member-sheet-viewer', false);
        expect(sandbox.renderPdfViewer).toHaveBeenCalledWith('/api/extra/desired_pieces/9/reference_score');

        sandbox.switchTab.mockClear();
        sandbox.renderPdfViewer.mockClear();

        sandbox.showSheetViewer(1);
        expect(elements.get('sheetViewerBackBtn').hidden).toBe(false);
        expect(elements.get('sheetViewerDownload').href).toBe('/api/sheets/1/download');
        expect(sandbox.switchTab).toHaveBeenCalledWith('memberPanel', 'member-sheet-viewer', false);
        expect(sandbox.renderPdfViewer).toHaveBeenCalledWith('/api/sheets/1/view');

        sandbox.appState.sheetPdfUrl = '/api/sheets/1/view';
        sandbox.appState.sheetPdfScale = 1;
        sandbox.renderPdfViewer.mockClear();
        await sandbox.zoomSheetViewer(-0.15);
        expect(sandbox.renderPdfViewer).toHaveBeenCalledWith('/api/sheets/1/view', 0.85);

        sandbox.renderPdfViewer.mockClear();
        await sandbox.fitSheetViewerWidth();
        expect(sandbox.renderPdfViewer).toHaveBeenCalledWith('/api/sheets/1/view', null);
    });

    test('sheet viewer buttons return to the correct member screen', () => {
        const { sandbox, elements } = makeViewerSandbox();
        sandbox.bindNavigation();

        elements.get('sheetViewerBackBtn').click();
        expect(sandbox.clearSheetViewer).toHaveBeenCalled();
        expect(sandbox.showMemberTab).toHaveBeenCalledWith('member-sheet');

        sandbox.clearSheetViewer.mockClear();
        sandbox.showMemberTab.mockClear();
        sandbox.appState.previousMemberTab = 'member-desired-piece';
        elements.get('sheetViewerMenuBtn').click();
        expect(sandbox.clearSheetViewer).toHaveBeenCalled();
        expect(sandbox.showMemberTab).toHaveBeenCalledWith('member-desired-piece');
    });

    test('viewer button labels keep the requested text', () => {
        const navigationSource = readSource('src/static/js/modules/navigation/helpers.js');
        expect(navigationSource).toContain('id="sheetViewerBackBtn"');
        expect(navigationSource).toContain('楽譜ライブラリに戻る');
        expect(navigationSource).toContain('id="sheetViewerMenuBtn"');
        expect(navigationSource).toContain('>戻る<');
    });
});