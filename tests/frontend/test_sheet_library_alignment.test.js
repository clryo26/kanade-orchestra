const fs = require('node:fs');
const path = require('node:path');

describe('sheet library alignment', () => {
    test('performance and piece headings use left-aligned heading class', () => {
        const appJs = fs.readFileSync(path.resolve(__dirname, '../../src/static/js/app.js'), 'utf8');
        const renderSheetLibraryView = appJs.slice(
            appJs.indexOf('function renderSheetLibraryView()'),
            appJs.indexOf('function openSheetViewer')
        );

        expect(renderSheetLibraryView).toContain('strong class="sheet-library-heading"');
        expect(renderSheetLibraryView).toContain('span class="sheet-library-heading"');
    });

    test('sheet library heading class is explicitly left aligned', () => {
        const css = fs.readFileSync(path.resolve(__dirname, '../../src/static/css/style.css'), 'utf8');

        expect(css).toContain('.sheet-library-heading');
        expect(css).toContain('text-align: left;');
    });
});
