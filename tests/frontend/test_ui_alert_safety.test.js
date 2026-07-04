const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

describe('ui alert safety', () => {
    test('showAlert does not throw when toastArea is missing', () => {
        const uiJs = fs.readFileSync(
            path.resolve(__dirname, '../../src/static/js/modules/common_helpers/ui.js'),
            'utf8'
        );

        const sandbox = {
            window: null,
            globalThis: null,
            document: {
                createElement: () => ({
                    className: '',
                    textContent: '',
                    remove: () => {},
                }),
                getElementById: () => null,
            },
            setTimeout: () => 0,
            console,
        };
        sandbox.window = sandbox;
        sandbox.globalThis = sandbox;
        sandbox.portalRuntimeContext = {
            appState: {},
            getById: () => null,
        };

        vm.runInNewContext(uiJs, sandbox);

        expect(() => sandbox.showAlert('first', 'warning')).not.toThrow();
        expect(() => sandbox.showAlert('second', 'danger')).not.toThrow();
    });
});
