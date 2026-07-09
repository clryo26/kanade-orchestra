const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

describe('system environment management', () => {
    const indexHtml = fs.readFileSync(path.resolve(__dirname, '../../src/index.html'), 'utf8');
    const routesJs = fs.readFileSync(path.resolve(__dirname, '../../src/static/js/modules/navigation/routes.js'), 'utf8');
    const envJs = fs.readFileSync(path.resolve(__dirname, '../../src/static/js/modules/admin_system/environment_management.js'), 'utf8');

    function buildSandbox(appState, fetchImpl) {
        const elements = {
            systemEnvironmentMenuBtn: { hidden: true },
            systemEnvironmentStatus: { className: '', textContent: '' },
            environmentOperationActions: { hidden: true },
            environmentOperationResult: { textContent: '' },
            environmentReleaseHistory: { textContent: '' },
            environmentSyncHistory: { textContent: '' },
            environmentCloudRunService: { value: '' },
            environmentImageUri: { value: '' },
            environmentImageDigest: { value: '' },
        };
        const sandbox = {
            window: null,
            globalThis: null,
            localStorage: {
                getItem: () => 'dev-system',
            },
            fetch: fetchImpl,
            document: {
                getElementById: (id) => elements[id] || null,
            },
            formatDateTimeLabel: (value) => String(value || ''),
            request: async () => ({
                can_manage_operations: true,
                execution_backend_configured: false,
                execution_backend_implemented: false,
                promotion_dispatch: { configured: false },
                deploy_info: {},
                current_environment: 'test',
                app_env: 'test',
                items: [],
            }),
            jsonOptions: () => ({}),
            console,
        };
        sandbox.window = sandbox;
        sandbox.globalThis = sandbox;
        sandbox.portalRuntimeContext = {
            appState,
            getById: (id) => elements[id] || null,
            PORTAL_DEVICE_ID_KEY: 'kanadePortalDeviceId',
        };
        vm.runInNewContext(envJs, sandbox);
        return { sandbox, elements };
    }

    function clickPromoteButton(sandbox, elements) {
        const button = {
            dataset: {},
            addEventListener: (_event, handler) => {
                button.handler = handler;
            },
        };
        elements.environmentReleasePromoteBtn = button;
        elements.environmentProdToTestSyncBtn = null;
        sandbox._bindEnvironmentButtons();
        return button.handler();
    }

    test('system panel includes test-only environment management tab and hidden menu button', () => {
        expect(indexHtml).toContain('data-tab="system-environment"');
        expect(indexHtml).toContain('id="systemEnvironmentMenuBtn" hidden');
        expect(indexHtml).toContain('id="systemEnvironmentTab"');
        expect(indexHtml).toContain('id="environmentReleasePromoteBtn"');
        expect(indexHtml).toContain('id="environmentProdToTestSyncBtn"');
    });

    test('system routes invoke visibility refresh and environment tab renderer', () => {
        expect(routesJs).toContain('refreshSystemEnvironmentMenuVisibility');
        expect(routesJs).toContain("tabName === 'system-environment'");
        expect(routesJs).toContain('renderSystemEnvironmentManagement');
    });

    test('environment management module uses backend contracts and does not fake success', () => {
        expect(envJs).toContain('/api/system/environment/status');
        expect(envJs).toContain('/api/system/release/promote');
        expect(envJs).toContain('/api/system/sync/prod-to-test');
        expect(envJs).toContain('target_image_digest');
        expect(envJs).toContain('GitHub Actions 起動設定');
    });

    test('hidden system admin does not see environment menu', async () => {
        const appState = {
            currentUserPermission: 'システム管理者',
            currentUserHiddenUser: true,
            systemEnvironmentStatus: null,
        };
        const { sandbox, elements } = buildSandbox(appState, async () => ({ ok: true, json: async () => ({}) }));
        const shown = await sandbox.refreshSystemEnvironmentMenuVisibility();
        expect(shown).toBe(false);
        expect(elements.systemEnvironmentMenuBtn.hidden).toBe(true);
    });

    test('admin and general member do not see environment menu', async () => {
        const adminState = { currentUserPermission: '管理者', currentUserHiddenUser: false };
        const memberState = { currentUserPermission: '一般', currentUserHiddenUser: false };

        const adminSandbox = buildSandbox(adminState, async () => ({ ok: true, json: async () => ({}) })).sandbox;
        const memberSandbox = buildSandbox(memberState, async () => ({ ok: true, json: async () => ({}) })).sandbox;

        await expect(adminSandbox.refreshSystemEnvironmentMenuVisibility()).resolves.toBe(false);
        await expect(memberSandbox.refreshSystemEnvironmentMenuVisibility()).resolves.toBe(false);
    });

    test('production-like status API response keeps environment menu hidden', async () => {
        const appState = {
            currentUserPermission: 'システム管理者',
            currentUserHiddenUser: false,
            systemEnvironmentStatus: null,
        };
        const { sandbox, elements } = buildSandbox(appState, async () => ({ ok: false, json: async () => ({}) }));
        const shown = await sandbox.refreshSystemEnvironmentMenuVisibility();
        expect(shown).toBe(false);
        expect(elements.systemEnvironmentMenuBtn.hidden).toBe(true);
    });

    test('not-implemented backend state is displayed as failure reason on screen', async () => {
        const appState = {
            currentUserPermission: 'システム管理者',
            currentUserHiddenUser: false,
            systemEnvironmentStatus: null,
        };
        const { sandbox, elements } = buildSandbox(appState, async () => ({ ok: true, json: async () => ({ app_env: 'test' }) }));
        sandbox.request = async (url) => {
            if (url === '/api/system/environment/status') {
                return {
                    can_manage_operations: true,
                    execution_backend_configured: false,
                    execution_backend_implemented: false,
                    promotion_dispatch: { configured: false },
                    deploy_info: {},
                    current_environment: 'test',
                    app_env: 'test',
                };
            }
            return { items: [] };
        };
        await sandbox.renderSystemEnvironmentManagement();
        expect(elements.environmentOperationResult.textContent).toContain('設定が不足');
    });

    test('release promote is not requested when git sha is unset', async () => {
        const appState = {
            currentUserPermission: 'システム管理者',
            currentUserHiddenUser: false,
            systemEnvironmentStatus: {
                deploy_info: {
                    git_sha: '未設定',
                    image_digest: 'sha256:real-digest',
                },
            },
        };
        const { sandbox, elements } = buildSandbox(appState, async () => ({ ok: true, json: async () => ({}) }));
        const calls = [];
        sandbox.request = async (url, options) => {
            calls.push({ url, options });
            return {};
        };

        await clickPromoteButton(sandbox, elements);

        expect(calls).toEqual([]);
        expect(elements.environmentOperationResult.textContent).toContain('Git SHA が未設定');
    });

    test('release promote is not requested when image digest is unset', async () => {
        const appState = {
            currentUserPermission: 'システム管理者',
            currentUserHiddenUser: false,
            systemEnvironmentStatus: {
                deploy_info: {
                    git_sha: 'abc123',
                    image_digest: '',
                },
            },
        };
        const { sandbox, elements } = buildSandbox(appState, async () => ({ ok: true, json: async () => ({}) }));
        const calls = [];
        sandbox.request = async (url, options) => {
            calls.push({ url, options });
            return {};
        };

        await clickPromoteButton(sandbox, elements);

        expect(calls).toEqual([]);
        expect(elements.environmentOperationResult.textContent).toContain('Image Digest が未設定');
    });

    test('release promote sends only real git sha and image digest', async () => {
        const appState = {
            currentUserPermission: 'システム管理者',
            currentUserHiddenUser: false,
            systemEnvironmentStatus: {
                deploy_info: {
                    git_sha: 'abc123',
                    image_digest: 'sha256:real-digest',
                },
            },
        };
        const { sandbox, elements } = buildSandbox(appState, async () => ({ ok: true, json: async () => ({}) }));
        const calls = [];
        sandbox.jsonOptions = (_method, payload) => payload;
        sandbox.request = async (url, options) => {
            calls.push({ url, options });
            return {};
        };
        sandbox.renderSystemEnvironmentManagement = async () => {};

        await clickPromoteButton(sandbox, elements);

        expect(calls).toEqual([
            {
                url: '/api/system/release/promote',
                options: {
                    target_git_sha: 'abc123',
                    target_image_digest: 'sha256:real-digest',
                },
            },
        ]);
    });
});
