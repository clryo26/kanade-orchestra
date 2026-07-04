const { castingEditorState } = require('../../src/static/js/frontend_testable_logic.js');

describe('casting admin edit button', () => {
    test('registered casting edit buttons select records by casting id', () => {
        const state = castingEditorState({ id: 12, performance_id: 3, piece: 'Symphony', members: [], extras: [] });
        expect(state.castingEditingId).toBe(12);
        expect(state.castingEditingPerformanceId).toBe(3);
        expect(state.castingEditingPiece).toBe('Symphony');
    });

    test('loading a casting record does not clear copied members and extras', () => {
        const members = [{ member_id: 1, part: 'Vl' }];
        const extras = [{ name: 'Guest', part: 'Tp' }];
        const state = castingEditorState({ id: 1, performance_id: 2, piece: 'Piece', members, extras });
        expect(state.castingEditingMembers).toEqual(members);
        expect(state.castingEditingExtras).toEqual(extras);
        expect(state.castingEditingMembers).not.toBe(members);
        expect(state.castingEditingExtras).not.toBe(extras);
    });
});
