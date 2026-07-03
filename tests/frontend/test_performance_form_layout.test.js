const fs = require('node:fs');
const path = require('node:path');

describe('performance form layout', () => {
    test('flyer image field is rendered below the piece list', () => {
        const html = fs.readFileSync(path.resolve(__dirname, '../../src/index.html'), 'utf8');
        const pieceListIndex = html.indexOf('id="perfPieceList"');
        const flyerFileIndex = html.indexOf('id="perfFlyerFile"');

        expect(pieceListIndex).toBeGreaterThan(-1);
        expect(flyerFileIndex).toBeGreaterThan(pieceListIndex);
    });

    test('member performance list renders formal piece names', () => {
        const appJs = fs.readFileSync(path.resolve(__dirname, '../../src/static/js/app.js'), 'utf8');
        const renderMemberPerformances = appJs.slice(
            appJs.indexOf('function renderMemberPerformances()'),
            appJs.indexOf('function renderMemberSchedules()')
        );

        expect(renderMemberPerformances).toContain('performancePieceFormalLabel(piece)');
        expect(renderMemberPerformances).not.toContain('performancePieceLabel(piece)');
    });

    test('member performance flyer is rendered below piece names', () => {
        const appJs = fs.readFileSync(path.resolve(__dirname, '../../src/static/js/app.js'), 'utf8');
        const renderMemberPerformances = appJs.slice(
            appJs.indexOf('function renderMemberPerformances()'),
            appJs.indexOf('function renderMemberSchedules()')
        );

        expect(renderMemberPerformances.indexOf('performancePieceFormalLabel(piece)')).toBeLessThan(
            renderMemberPerformances.indexOf('performance-flyer-preview')
        );
    });
});
