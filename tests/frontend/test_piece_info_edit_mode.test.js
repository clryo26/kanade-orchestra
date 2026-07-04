const { detailEditorUiState, performancePieceFormalLabel } = require('../../src/static/js/frontend_testable_logic.js');

describe('piece info edit mode', () => {
    test('piece info detail starts read-only and toggles edit/save action', () => {
        expect(detailEditorUiState(false)).toEqual(expect.objectContaining({
            isEditing: false,
            actionButtonLabel: '編集',
            readOnly: true,
            readOnlyAttribute: 'readonly'
        }));
        expect(detailEditorUiState(true)).toEqual(expect.objectContaining({
            isEditing: true,
            actionButtonLabel: '保存',
            readOnly: false,
            readOnlyAttribute: ''
        }));
    });

    test('piece info list uses formal piece labels', () => {
        expect(performancePieceFormalLabel({ composer: 'Beethoven', title: 'Symphony No.5' })).toBe('Beethoven: Symphony No.5');
    });

    test('piece info detail does not duplicate description below editor', () => {
        expect(detailEditorUiState(false).actionButtonClass).toBe('btn-outline-primary');
        expect(detailEditorUiState(true).actionButtonClass).toBe('btn-success');
    });
});
