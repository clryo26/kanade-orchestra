const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// isPortalAuthenticated相当のロジックをvm環境でテストするためのヘルパー
function buildAuthSandbox({ deviceId, authKey, fetchImpl }) {
    const localStorage = {};
    if (deviceId) localStorage['kanadePortalDeviceId'] = deviceId;
    if (authKey) localStorage['kanadePortalAuthenticated'] = authKey;

    const appState = {
        portalAuthVerified: false,
        lastPortalSessionVerifiedAt: 0,
        lastEssentialDataLoadedAt: 0,
        currentUserMemberId: null,
        currentUserName: '',
        currentUserPermission: '',
        currentUserPart: '',
        currentUserHiddenUser: false,
        currentUserIsRecordingManager: false,
        currentUserIsSheetManager: false,
    };

    const sandbox = {
        window: null,
        globalThis: null,
        console,
        AbortController,
        DOMException,
        setTimeout,
        clearTimeout,
        fetch: fetchImpl || vi.fn(),
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;

    // portalRuntimeContextの最小モック
    sandbox.portalRuntimeContext = {
        appState,
        PORTAL_DEVICE_ID_KEY: 'kanadePortalDeviceId',
        PORTAL_AUTH_KEY: 'kanadePortalAuthenticated',
        inFlightGetRequests: new Map(),
        dbCache: {
            getEntry: vi.fn().mockResolvedValue(null),
            get: vi.fn().mockResolvedValue(null),
            set: vi.fn().mockResolvedValue(undefined),
            delete: vi.fn().mockResolvedValue(undefined),
            getETag: vi.fn().mockReturnValue(null),
        },
    };

    // localStorage最小モック
    sandbox.localStorage = {
        getItem: (key) => (localStorage[key] !== undefined ? localStorage[key] : null),
        setItem: (key, val) => { localStorage[key] = val; },
        removeItem: (key) => { delete localStorage[key]; },
    };

    sandbox.appState = appState;

    return { sandbox, appState, localStorage };
}

// api_runtime.jsとauth_feature.jsをコンテキストに読み込む
function loadAuthModules(sandbox) {
    // api_runtime依存: showAlertは不使用だがグローバルとして必要
    sandbox.showAlert = vi.fn();
    sandbox.showPortalLogin = vi.fn();

    const apiRuntimeCode = fs.readFileSync(
        path.resolve(__dirname, '../../src/static/js/modules/common_helpers/api_runtime.js'),
        'utf8'
    );
    vm.runInNewContext(apiRuntimeCode, sandbox);

    const authFeatureCode = fs.readFileSync(
        path.resolve(__dirname, '../../src/static/js/auth_feature.js'),
        'utf8'
    );
    sandbox.$ = vi.fn().mockReturnValue(null);
    // auth_feature.jsはescapeHtmlなど多数のグローバルに依存するため
    // isPortalAuthenticatedだけをvm評価するための最小スタブを用意する
    sandbox.escapeHtml = (s) => String(s);
    sandbox.portalTitleText = () => '奏オケポータル';
    sandbox.currentRevisionText = () => '';
    sandbox.closePortalDrawer = vi.fn();
    sandbox.refreshPartSelectOptions = vi.fn();
    sandbox.applyOrgSettings = vi.fn();
    sandbox.updateCloudRunRevision = vi.fn();
    sandbox.request = sandbox.request || vi.fn();
    vm.runInNewContext(authFeatureCode, sandbox);
}

describe('isPortalAuthenticated 3状態', () => {
    test('ローカル認証情報なし → unauthenticated', async () => {
        const { sandbox } = buildAuthSandbox({ deviceId: null, authKey: null });
        loadAuthModules(sandbox);
        const result = await sandbox.isPortalAuthenticated();
        expect(result.status).toBe('unauthenticated');
        expect(result.error).toBeNull();
    });

    test('deviceIdはあるがauthKeyなし → unauthenticated', async () => {
        const { sandbox } = buildAuthSandbox({ deviceId: 'dev-abc', authKey: null });
        loadAuthModules(sandbox);
        const result = await sandbox.isPortalAuthenticated();
        expect(result.status).toBe('unauthenticated');
    });

    test('API認証済み → authenticated', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                authenticated: true,
                device: { member_id: 1, member_name: 'テスト' },
            }),
        });
        const { sandbox, appState } = buildAuthSandbox({ deviceId: 'dev-abc', authKey: 'true', fetchImpl: mockFetch });
        loadAuthModules(sandbox);
        const result = await sandbox.isPortalAuthenticated();
        expect(result.status).toBe('authenticated');
        expect(appState.portalAuthVerified).toBe(true);
    });

    test('API正常応答でauthenticated=false → unauthenticated', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ authenticated: false }),
        });
        const { sandbox, appState } = buildAuthSandbox({ deviceId: 'dev-abc', authKey: 'true', fetchImpl: mockFetch });
        appState.portalAuthVerified = false;
        loadAuthModules(sandbox);
        const result = await sandbox.isPortalAuthenticated();
        expect(result.status).toBe('unauthenticated');
    });

    test('API 401 → unauthenticated', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 401,
        });
        const { sandbox } = buildAuthSandbox({ deviceId: 'dev-abc', authKey: 'true', fetchImpl: mockFetch });
        loadAuthModules(sandbox);
        const result = await sandbox.isPortalAuthenticated();
        expect(result.status).toBe('unauthenticated');
    });

    test('タイムアウト → unavailable', async () => {
        // sandboxのsetTimeoutを1/1000倍に高速化してテスト時間を短縮する
        const { sandbox } = buildAuthSandbox({ deviceId: 'dev-abc', authKey: 'true', fetchImpl: vi.fn().mockImplementation((_url, opts) => {
            return new Promise((_resolve, reject) => {
                opts.signal.addEventListener('abort', () => {
                    reject(new DOMException('aborted', 'AbortError'));
                });
            });
        }) });
        // setTimeoutを高速化してPORTAL_TIMEOUT_AUTH(10000ms)を10msで発火させる
        sandbox.setTimeout = (fn, ms) => setTimeout(fn, Math.max(1, Math.floor(ms / 1000)));
        sandbox.clearTimeout = clearTimeout;
        loadAuthModules(sandbox);
        const result = await sandbox.isPortalAuthenticated();
        expect(result.status).toBe('unavailable');
    }, 500);

    test('ネットワークエラー → unavailable', async () => {
        const mockFetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
        const { sandbox } = buildAuthSandbox({ deviceId: 'dev-abc', authKey: 'true', fetchImpl: mockFetch });
        loadAuthModules(sandbox);
        const result = await sandbox.isPortalAuthenticated();
        expect(result.status).toBe('unavailable');
        expect(result.error).toBeInstanceOf(Error);
    });

    test('unavailable時にローカル認証情報が削除されない', async () => {
        const mockFetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
        const { sandbox, localStorage } = buildAuthSandbox({ deviceId: 'dev-abc', authKey: 'true', fetchImpl: mockFetch });
        loadAuthModules(sandbox);
        await sandbox.isPortalAuthenticated();
        expect(localStorage['kanadePortalAuthenticated']).toBe('true');
        expect(localStorage['kanadePortalDeviceId']).toBe('dev-abc');
    });

    test('portalAuthVerified=trueの場合はAPI呼出しなしにauthenticatedを返す', async () => {
        const mockFetch = vi.fn();
        const { sandbox, appState } = buildAuthSandbox({ deviceId: 'dev-abc', authKey: 'true', fetchImpl: mockFetch });
        loadAuthModules(sandbox);
        sandbox.appState.portalAuthVerified = true;
        const result = await sandbox.isPortalAuthenticated();
        expect(result.status).toBe('authenticated');
        expect(mockFetch).not.toHaveBeenCalled();
    });
    test('forceVerify=trueの場合はportalAuthVerified=trueでもAPIを再確認する', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                authenticated: true,
                device: { member_id: 1, member_name: 'test' },
            }),
        });
        const { sandbox, appState } = buildAuthSandbox({
            deviceId: 'dev-abc',
            authKey: 'true',
            fetchImpl: mockFetch,
        });
        loadAuthModules(sandbox);
        appState.portalAuthVerified = true;

        const result = await sandbox.isPortalAuthenticated({ forceVerify: true });

        expect(result.status).toBe('authenticated');
        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(appState.lastPortalSessionVerifiedAt).toBeGreaterThan(0);
    });

    test('clearPortalAuthStateは認証確認時刻を0へ戻す', () => {
        const { sandbox, appState } = buildAuthSandbox({
            deviceId: 'dev-abc',
            authKey: 'true',
        });
        loadAuthModules(sandbox);
        appState.portalAuthVerified = true;
        appState.lastPortalSessionVerifiedAt = 123456;
        appState.lastEssentialDataLoadedAt = 123456;

        sandbox.clearPortalAuthState();

        expect(appState.portalAuthVerified).toBe(false);
        expect(appState.lastPortalSessionVerifiedAt).toBe(0);
        expect(appState.lastEssentialDataLoadedAt).toBe(0);
    });

    test('logoutPortalは認証確認時刻を0へ戻す', () => {
        const { sandbox, appState } = buildAuthSandbox({
            deviceId: 'dev-abc',
            authKey: 'true',
        });
        loadAuthModules(sandbox);
        appState.portalAuthVerified = true;
        appState.lastPortalSessionVerifiedAt = 123456;
        appState.lastEssentialDataLoadedAt = 123456;

        const fakeElement = { hidden: false, value: '', focus: vi.fn(), addEventListener: vi.fn() };
        sandbox.$ = vi.fn(() => fakeElement);

        sandbox.logoutPortal();

        expect(appState.portalAuthVerified).toBe(false);
        expect(appState.lastPortalSessionVerifiedAt).toBe(0);
        expect(appState.lastEssentialDataLoadedAt).toBe(0);
    });
});
