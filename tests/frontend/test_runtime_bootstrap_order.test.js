const fs = require('node:fs');
const path = require('node:path');

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
});
