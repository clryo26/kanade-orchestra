const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const helpersJs = fs.readFileSync(
    path.resolve(__dirname, '../../src/static/js/modules/admin_system/helpers.js'),
    'utf8'
);
const renderJs = fs.readFileSync(
    path.resolve(__dirname, '../../src/static/js/modules/admin_system/render.js'),
    'utf8'
);
const diagnosticsJs = fs.readFileSync(
    path.resolve(__dirname, '../../src/static/js/modules/admin_system/diagnostics.js'),
    'utf8'
);

function buildSandbox({ appEnv, otherEnvironmentUrl, permission }) {
    const elements = {
        portalBrandTitle: { textContent: '' },
        portalLoginTitle: { textContent: '' },
        otherEnvironmentLink: {
            hidden: true,
            href: '',
            textContent: '',
            removeAttribute(name) {
                if (name === 'href') this.href = '';
            },
        },
    };
    const titleElement = { textContent: '' };
    const metas = [
        { content: '', setAttribute(name, value) { if (name === 'content') this.content = value; } },
        { content: '', setAttribute(name, value) { if (name === 'content') this.content = value; } },
    ];
    const manifestLink = { href: '' };
    let manifestPayload = null;
    const appState = {
        appEnv,
        otherEnvironmentUrl,
        currentUserPermission: permission,
        orgSettings: [{ organization_abbreviation: '奏オケ' }],
        manifestObjectUrl: '',
        partSettings: [],
        members: [],
    };
    const sandbox = {
        window: null,
        globalThis: null,
        document: {
            title: '',
            querySelector(selector) {
                if (selector === 'title') return titleElement;
                if (selector === 'link[rel="manifest"]') return manifestLink;
                return null;
            },
            querySelectorAll(selector) {
                if (selector.includes('meta[name="application-name"]')) return metas;
                return [];
            },
        },
        URL: class TestUrl extends URL {
            static createObjectURL(blob) {
                manifestPayload = blob.parts.join('');
                return 'blob:test-manifest';
            }
            static revokeObjectURL() {}
        },
        Blob: class TestBlob {
            constructor(parts) {
                this.parts = parts;
            }
        },
        console,
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.getAppState = () => appState;
    sandbox.portalRuntimeContext = {
        appState,
        getById: (id) => elements[id] || null,
        DEFAULT_MEMBER_PARTS: [],
    };
    sandbox.canAccessAdmin = () => ['管理者', 'システム管理者'].includes(appState.currentUserPermission);
    sandbox.escapeHtml = (value) => String(value ?? '');
    vm.runInNewContext(helpersJs, sandbox);
    vm.runInNewContext(renderJs, sandbox);
    vm.runInNewContext(diagnosticsJs, sandbox);
    return {
        sandbox,
        appState,
        elements,
        titleElement,
        metas,
        manifestLink,
        manifest: () => JSON.parse(manifestPayload),
    };
}

describe('environment identity rendering', () => {
    test('administrator link keeps the existing button style and safe new-tab attributes', () => {
        const indexHtml = fs.readFileSync(path.resolve(__dirname, '../../src/index.html'), 'utf8');

        expect(indexHtml).toContain('class="btn btn-sm btn-outline-primary" id="otherEnvironmentLink"');
        expect(indexHtml).toContain('target="_blank" rel="noopener noreferrer" hidden');
    });

    test.each([
        ['production', '奏オケポータル'],
        ['test', '奏オケポータル(テスト環境)'],
        ['dev', '奏オケポータル'],
    ])('%s applies the expected shared title and manifest', (appEnv, expectedTitle) => {
        const view = buildSandbox({ appEnv, otherEnvironmentUrl: '', permission: '管理者' });

        view.sandbox.applyOrgSettings();

        expect(view.sandbox.document.title).toBe(expectedTitle);
        expect(view.titleElement.textContent).toBe(expectedTitle);
        expect(view.elements.portalBrandTitle.textContent).toBe(expectedTitle);
        expect(view.elements.portalLoginTitle.textContent).toBe(expectedTitle);
        expect(view.metas.map((meta) => meta.content)).toEqual([expectedTitle, expectedTitle]);
        expect(view.manifest()).toMatchObject({ name: expectedTitle, short_name: expectedTitle });
    });

    test.each([
        [
            'production',
            'https://kanade-orchestra-test-apmcj4meeq-dt.a.run.app',
            'テスト環境を開く',
        ],
        [
            'test',
            'https://kanade-orchestra-apmcj4meeq-dt.a.run.app',
            '本番環境を開く',
        ],
    ])('%s administrator sees only the configured opposite environment', (appEnv, url, label) => {
        const view = buildSandbox({ appEnv, otherEnvironmentUrl: url, permission: '管理者' });

        view.sandbox.updateOtherEnvironmentLink();

        expect(view.elements.otherEnvironmentLink.hidden).toBe(false);
        expect(view.elements.otherEnvironmentLink.textContent).toBe(label);
        expect(view.elements.otherEnvironmentLink.href).toBe(url);
    });

    test.each([
        ['production', '', '管理者'],
        ['production', 'not-a-url', '管理者'],
        ['production', 'http://example.com', '管理者'],
        ['dev', 'https://example.com', '管理者'],
        ['test', 'https://example.com', '一般'],
    ])('hides the link for env=%s url=%s permission=%s', (appEnv, url, permission) => {
        const view = buildSandbox({ appEnv, otherEnvironmentUrl: url, permission });

        view.sandbox.updateOtherEnvironmentLink();

        expect(view.elements.otherEnvironmentLink.hidden).toBe(true);
        expect(view.elements.otherEnvironmentLink.href).toBe('');
        expect(view.elements.otherEnvironmentLink.textContent).toBe('');
    });

    test('public revision metadata reapplies the title and administrator link', async () => {
        const view = buildSandbox({ appEnv: '', otherEnvironmentUrl: '', permission: '管理者' });
        view.sandbox.requestJson = async () => ({
            cloudRunRevision: 'revision-1',
            appEnv: 'test',
            otherEnvironmentUrl: 'https://kanade-orchestra-apmcj4meeq-dt.a.run.app',
        });

        await view.sandbox.loadCloudRunRevision();

        expect(view.appState.appEnv).toBe('test');
        expect(view.sandbox.document.title).toBe('奏オケポータル(テスト環境)');
        expect(view.elements.otherEnvironmentLink.hidden).toBe(false);
        expect(view.elements.otherEnvironmentLink.textContent).toBe('本番環境を開く');
    });
});
