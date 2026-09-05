const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadOverride(options = {}) {
    let clickHandler = null;
    const retryButton = {
        disabled: false,
        closest(selector) {
            return selector === '#portalStartupRetryButton' ? this : null;
        },
    };
    const message = {
        textContent: options.message || '通信に時間がかかっています。再試行してください。',
    };
    const replace = vi.fn();

    const sandbox = {
        window: {
            __KANADE_STARTUP_RETRY_OVERRIDE_BOUND__: false,
            location: {
                href: 'https://example.test/portal',
                replace,
            },
        },
        document: {
            addEventListener(type, handler, capture) {
                if (type === 'click' && capture === true) clickHandler = handler;
            },
            getElementById(id) {
                return id === 'portalStartupMessage' ? message : null;
            },
        },
        URL,
        Date: { now: () => 1234567890 },
        console,
    };

    const code = fs.readFileSync(
        path.resolve(__dirname, '../../src/static/js/startup_retry_override.js'),
        'utf8'
    );
    vm.runInNewContext(code, sandbox);

    return { clickHandler, retryButton, message, replace };
}

describe('startup retry override', () => {
    test('watchdogの再試行はキャッシュバスター付きURLへreplaceする', () => {
        const { clickHandler, retryButton, message, replace } = loadOverride();
        const event = {
            target: retryButton,
            preventDefault: vi.fn(),
            stopImmediatePropagation: vi.fn(),
        };

        clickHandler(event);

        expect(event.preventDefault).toHaveBeenCalledTimes(1);
        expect(event.stopImmediatePropagation).toHaveBeenCalledTimes(1);
        expect(retryButton.disabled).toBe(true);
        expect(message.textContent).toBe('再試行しています...');
        expect(replace).toHaveBeenCalledTimes(1);
        expect(replace.mock.calls[0][0]).toContain('_portal_retry=1234567890');
    });

    test('watchdog以外の通常再試行には介入しない', () => {
        const { clickHandler, retryButton, replace } = loadOverride({
            message: '通信に時間がかかっています。もう一度試行してください。',
        });
        const event = {
            target: retryButton,
            preventDefault: vi.fn(),
            stopImmediatePropagation: vi.fn(),
        };

        clickHandler(event);

        expect(event.preventDefault).not.toHaveBeenCalled();
        expect(event.stopImmediatePropagation).not.toHaveBeenCalled();
        expect(replace).not.toHaveBeenCalled();
    });
});
