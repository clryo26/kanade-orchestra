const {
    performancePieceFormalLabel,
    performancePieceLookupLabels,
    findPieceScopedItem
} = require('../../src/static/js/frontend_testable_logic.js');

describe('piece scoped lookup', () => {
    test('formal label ignores alias for management list display', () => {
        const piece = { composer: 'Beethoven', title: 'Symphony No.5', alias: 'Alias' };

        expect(performancePieceFormalLabel(piece)).toBe('Beethoven: Symphony No.5');
    });

    test('matches migrated rows saved with alias or formal piece labels', () => {
        const piece = { composer: 'Beethoven', title: 'Symphony No.5', alias: '運命' };
        const rows = [
            { id: 1, performance_id: 10, piece: 'Beethoven: Symphony No.5', description: 'formal' },
            { id: 2, performance_id: 10, piece: '運命', practice_notes: 'alias' }
        ];

        expect(performancePieceLookupLabels(piece)).toEqual(['運命', 'Beethoven: Symphony No.5', 'Symphony No.5']);
        expect(findPieceScopedItem(rows, 10, piece).id).toBe(1);
        expect(findPieceScopedItem(rows.slice(1), 10, piece).id).toBe(2);
    });
});
