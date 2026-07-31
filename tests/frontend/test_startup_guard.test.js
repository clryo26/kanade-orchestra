const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// startup_guard.jsをvm環境で実行するためのヘルパー
function makeStartupSandbox(overrides = {}) {
    const eventListeners = {};
    const domElements = {};

    function makeMockButton(id) {
        return {
            id,
            hidden: true,
            disabled: false,
            textContent: '',
            cloneNode(deep) {
                const clone = { ...this, _listeners: [] };
                clone.addEventListener = function (type, fn, opts) {
                    clone._listeners = clone._listeners || [];
                    clone._listeners.push({ type, fn, opts });
                };
                clone.cloneNode = this.cloneNode.bind(clone);
                return clone;
            },
            addEventListener(type, fn, opts) {
                this._listeners = this._listeners || [];
                this._listeners.push({ type, fn, opts });
            },
            parentNode: null,
            replaceChild(newNode, oldNode) {
                // 置き換え後の参照をdomElementsへ反映する
                domElements[newNode.id] = newNode;
                newNode.parentNode = this;
            },
        };
    }

    function makeMockMessage(id) {
        return { id, textContent: '' };
    }

    // モックDOM要素を準備する
    const startupPanel = { id: 'portalStartupPanel', hidden: false };
    const startupMessage = makeMockMessage('portalStartupMessage');
    const retryButton = makeMockButton('portalStartupRetryButton');
    const reloadButton = makeMockButton('portalStartupReloadButton');

    // ボタンのparentNodeを設定する
    const buttonParent = {
        replaceChild(newNode, oldNode) {
            domElements[newNode.id] = newNode;
            newNode.parentNode = buttonParent;
        },
    };
    retryButton.parentNode = buttonParent;
    reloadButton.parentNode = buttonParent;

    domElements['portalStartupPanel'] = startupPanel;
    domElements['portalStartupMessage'] = startupMessage;
    domElements['portalStartupRetryButton'] = retryButton;
    domElements['portalStartupReloadButton'] = reloadButton;

    const mockWindow = {
        portalStartup: undefined,
        location: { reload: vi.fn() },
        addEventListener(type, fn) {
            eventListeners[type] = eventListeners[type] || [];
            eventListeners[type].push(fn);
        },
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (id) => clearTimeout(id),
    };
    mockWindow.window = mockWindow;

    const mockDocument = {
        getElementById(id) {
            return domElements[id] || null;
        },
    };

    const sandbox = {
        ...mockWindow,
        document: mockDocument,
        console,
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (id) => clearTimeout(id),
        ...overrides,
    };
    sandbox.window = sandbox;

    return { sandbox, domElements, eventListeners, mockWindow };
}

function loadStartupGuard(sandbox) {
    const code = fs.readFileSync(
        path.resolve(__dirname, '../../src/static/js/startup_guard.js'),
        'utf8'
    );
    vm.runInNewContext(code, sandbox);
}

describe('startup_guard', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    test('起動時に監視タイマーが設定される', () => {
        const { sandbox } = makeStartupSandbox();
        loadStartupGuard(sandbox);
        expect(sandbox.portalStartup).toBeDefined();
        const snap = sandbox.portalStartup.snapshot();
        expect(snap.isReady).toBe(false);
    });

    test('ready()でタイマーが解除され起動画面が非表示になる', () => {
        const { sandbox, domElements } = makeStartupSandbox();
        loadStartupGuard(sandbox);
        expect(domElements['portalStartupPanel'].hidden).toBe(false);
        sandbox.portalStartup.ready();
        expect(domElements['portalStartupPanel'].hidden).toBe(true);
        expect(sandbox.portalStartup.snapshot().isReady).toBe(true);
    });

    test('監視タイムアウト後に再試行導線が表示される', () => {
        const { sandbox, domElements } = makeStartupSandbox();
        loadStartupGuard(sandbox);
        vi.advanceTimersByTime(15001);
        // cloneNodeで置き換えられた新しいボタン参照を取得する
        const retryBtn = domElements['portalStartupRetryButton'];
        expect(retryBtn.hidden).toBe(false);
        const reloadBtn = domElements['portalStartupReloadButton'];
        expect(reloadBtn.hidden).toBe(true);
    });

    test('ready()後はタイムアウトが発動しない', () => {
        const { sandbox, domElements } = makeStartupSandbox();
        loadStartupGuard(sandbox);
        sandbox.portalStartup.ready();
        vi.advanceTimersByTime(20000);
        // ready()後はパネルが非表示のまま (watchdogが呼ばれても_isReadyのガードで何もしない)
        expect(domElements['portalStartupPanel'].hidden).toBe(true);
    });

    test('window.onerrorで再読み込み導線が表示される', () => {
        const { sandbox, domElements, eventListeners } = makeStartupSandbox();
        loadStartupGuard(sandbox);
        const errorHandlers = eventListeners['error'] || [];
        expect(errorHandlers.length).toBeGreaterThan(0);
        errorHandlers.forEach((h) => h({ message: 'test error' }));
        const reloadBtn = domElements['portalStartupReloadButton'];
        expect(reloadBtn.hidden).toBe(false);
    });

    test('unhandledrejectionで再読み込み導線が表示される', () => {
        const { sandbox, domElements, eventListeners } = makeStartupSandbox();
        loadStartupGuard(sandbox);
        const rejHandlers = eventListeners['unhandledrejection'] || [];
        expect(rejHandlers.length).toBeGreaterThan(0);
        rejHandlers.forEach((h) => h({ reason: new Error('rejection') }));
        const reloadBtn = domElements['portalStartupReloadButton'];
        expect(reloadBtn.hidden).toBe(false);
    });

    test('showRetry()で指定した再試行関数が呼ばれる', () => {
        const { sandbox, domElements } = makeStartupSandbox();
        loadStartupGuard(sandbox);
        const retryFn = vi.fn().mockResolvedValue(undefined);
        sandbox.portalStartup.showRetry({ message: 'retry test', retry: retryFn });
        const retryBtn = domElements['portalStartupRetryButton'];
        // cloneNodeで置き換えられた新ボタンのリスナーを呼ぶ
        const listeners = retryBtn._listeners || [];
        expect(listeners.length).toBeGreaterThan(0);
        listeners[0].fn();
        expect(retryFn).toHaveBeenCalledTimes(1);
    });

    test('二重初期化してもイベントが重複登録されない', () => {
        const { sandbox, eventListeners } = makeStartupSandbox();
        loadStartupGuard(sandbox);
        const firstErrorCount = (eventListeners['error'] || []).length;
        // 二度目はwindow.portalStartupが既にあるので即return
        loadStartupGuard(sandbox);
        const secondErrorCount = (eventListeners['error'] || []).length;
        expect(secondErrorCount).toBe(firstErrorCount);
    });

    test('setMessage()で起動画面のメッセージが変わる', () => {
        const { sandbox, domElements } = makeStartupSandbox();
        loadStartupGuard(sandbox);
        sandbox.portalStartup.setMessage('カスタムメッセージ');
        expect(domElements['portalStartupMessage'].textContent).toBe('カスタムメッセージ');
    });

    test('showReload()で再読み込みボタンが表示される', () => {
        const { sandbox, domElements } = makeStartupSandbox();
        loadStartupGuard(sandbox);
        sandbox.portalStartup.showReload('再読み込みしてください');
        const reloadBtn = domElements['portalStartupReloadButton'];
        expect(reloadBtn.hidden).toBe(false);
        const retryBtn = domElements['portalStartupRetryButton'];
        expect(retryBtn.hidden).toBe(true);
    });
});
