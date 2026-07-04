const {
    detailEditorUiState,
    performancePieceFormalLabel,
    portalMenuStatePatch,
} = require('../../src/static/js/frontend_testable_logic.js');

describe('practice instruction navigation', () => {
    test('portal menu entry resets selected practice instruction detail', () => {
        expect(portalMenuStatePatch('member-practice-instruction')).toEqual({
            selectedPracticeInstructionContext: null,
            practiceInstructionEditing: false,
        });
    });

    test('practice instruction list uses formal piece names without extra list heading', () => {
        expect(performancePieceFormalLabel({ composer: 'Mozart', title: 'Requiem' })).toBe('Mozart: Requiem');
    });

    test('practice instruction detail starts read-only and toggles edit/save action', () => {
        expect(detailEditorUiState(false).actionButtonLabel).toBe('編集');
        expect(detailEditorUiState(true).actionButtonLabel).toBe('保存');
        expect(detailEditorUiState(false).readOnlyAttribute).toBe('readonly');
        expect(detailEditorUiState(true).readOnlyAttribute).toBe('');
    });
});
