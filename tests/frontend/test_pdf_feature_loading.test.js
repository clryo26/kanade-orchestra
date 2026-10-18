const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadFeature() {
    const root = path.resolve(__dirname, '../..');
    const scripts = [];
    const state = {};
    const sandbox = {
        window: { portalRuntimeContext: { appState: state, getById: () => null } },
        document: {
            currentScript: { src: 'http://localhost/static/js/modules/navigation/routes.js?v=1&rev=release-42' },
            querySelector: () => null,
            createElement: () => {
                const listeners = {};
                return { addEventListener: (type, fn) => { listeners[type] = fn; }, listeners };
            },
            head: { appendChild: (script) => {
                scripts.push(script.src);
                const file = script.src.split('?')[0].replace('/static/', 'src/static/');
                vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox);
                script.listeners.load();
            } }
        }
    };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(root, 'src/static/js/modules/navigation/routes.js'), 'utf8'), sandbox);
    return { sandbox, scripts };
}

test.each(['sheet', 'datePiecePromotion'])('%s can display PDFs on a fresh session without visiting casting', async (feature) => {
    const { sandbox, scripts } = loadFeature();
    await sandbox.ensureMemberFeatureLoaded(feature);
    expect(typeof sandbox.renderPdfViewer).toBe('function');
    expect(typeof sandbox.sheetViewerFitScale).toBe('function');
    expect(typeof sandbox.zoomSheetViewer).toBe('function');
    expect(typeof sandbox.clearSheetViewer).toBe('function');
    expect(scripts.every((src) => src.endsWith('&rev=release-42'))).toBe(true);
});
