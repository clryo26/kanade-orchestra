const fs = require('node:fs');
const path = require('node:path');

describe('casting table layout', () => {
    test('member casting table keeps member names close to part labels', () => {
        const appJs = fs.readFileSync(path.resolve(__dirname, '../../src/static/js/app.js'), 'utf8');
        const css = fs.readFileSync(path.resolve(__dirname, '../../src/static/css/style.css'), 'utf8');
        const renderCastingView = appJs.slice(
            appJs.indexOf('function renderCastingView()'),
            appJs.indexOf('function sortedDateAdjustments')
        );

        expect(renderCastingView).toContain('casting-table');
        expect(renderCastingView).toContain('casting-part-cell');
        expect(renderCastingView).toContain('casting-members-cell');
        expect(css).toContain('.casting-table .casting-part-cell');
        expect(css).toContain('padding-right: 0.35rem;');
        expect(css).toContain('padding-left: 0.15rem;');
    });
});
