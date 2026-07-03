const fs = require('node:fs');
const path = require('node:path');

describe('piece info edit mode', () => {
    const appJs = fs.readFileSync(path.resolve(__dirname, '../../src/static/js/app.js'), 'utf8');
    const renderPieceInfoView = appJs.slice(
        appJs.indexOf('function renderPieceInfoView()'),
        appJs.indexOf('function renderPracticeInstructionView()')
    );

    test('piece info detail starts read-only and toggles edit/save action', () => {
        expect(renderPieceInfoView).toContain('const isEditing = Boolean(appState.pieceInfoEditing)');
        expect(renderPieceInfoView).toContain("const actionButtonLabel = isEditing ? '保存' : '編集'");
        expect(renderPieceInfoView).toContain("isEditing ? '' : 'readonly'");
        expect(renderPieceInfoView).toContain('appState.pieceInfoEditing = true');
        expect(renderPieceInfoView).toContain('appState.pieceInfoEditing = false');
    });

    test('piece info list uses formal piece labels', () => {
        expect(renderPieceInfoView).toContain('const pieceLabel = performancePieceFormalLabel(piece)');
    });

    test('piece info detail does not duplicate description below editor', () => {
        expect(renderPieceInfoView).not.toContain('convertUrlsToLinks(initialDescription)');
        expect(renderPieceInfoView).not.toContain('multiline-text mb-3');
    });
});
