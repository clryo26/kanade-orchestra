const fs = require('node:fs');
const path = require('node:path');

describe('practice instruction navigation', () => {
    test('portal menu entry resets selected practice instruction detail', () => {
        const appJs = fs.readFileSync(path.resolve(__dirname, '../../src/static/js/app.js'), 'utf8');
        const openPortalMenuTab = appJs.slice(
            appJs.indexOf('function openPortalMenuTab(tabName)'),
            appJs.indexOf('function renderPortalDrawerMenu()')
        );

        expect(openPortalMenuTab).toContain("tabName === 'member-practice-instruction'");
        expect(openPortalMenuTab).toContain('appState.selectedPracticeInstructionContext = null');
    });

    test('practice instruction list uses formal piece names without extra list heading', () => {
        const appJs = fs.readFileSync(path.resolve(__dirname, '../../src/static/js/app.js'), 'utf8');
        const renderPracticeInstructionView = appJs.slice(
            appJs.indexOf('function renderPracticeInstructionView()'),
            appJs.indexOf('function desiredPieceCurrentVoterKey()')
        );

        expect(renderPracticeInstructionView).toContain('performancePieceFormalLabel(piece)');
        expect(renderPracticeInstructionView).not.toContain('未開催演奏会の曲一覧');
    });

    test('practice instruction detail starts read-only and toggles edit/save action', () => {
        const appJs = fs.readFileSync(path.resolve(__dirname, '../../src/static/js/app.js'), 'utf8');
        const renderPracticeInstructionView = appJs.slice(
            appJs.indexOf('function renderPracticeInstructionView()'),
            appJs.indexOf('function desiredPieceCurrentVoterKey()')
        );

        expect(renderPracticeInstructionView).toContain('const isEditing = Boolean(appState.practiceInstructionEditing)');
        expect(renderPracticeInstructionView).toContain("const actionButtonLabel = isEditing ? '保存' : '編集'");
        expect(renderPracticeInstructionView).toContain("isEditing ? '' : 'readonly'");
        expect(renderPracticeInstructionView).toContain('appState.practiceInstructionEditing = true');
        expect(renderPracticeInstructionView).toContain('appState.practiceInstructionEditing = false');
    });
});
