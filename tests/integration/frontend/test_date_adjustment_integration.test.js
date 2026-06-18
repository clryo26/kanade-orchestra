const {
    buildDateAdjustmentSummary,
    filterRespondentRows,
    dateAdjustmentCandidateLabel,
    moveDateAdjustmentCandidateRow
} = require('../../../src/static/js/frontend_testable_logic.js');

function createMockRowsContainer(ids) {
    const rows = ids.map((id) => ({ id, previousElementSibling: null, nextElementSibling: null }));
    const container = {
        rows,
        syncLinks() {
            this.rows.forEach((row, index) => {
                row.previousElementSibling = index > 0 ? this.rows[index - 1] : null;
                row.nextElementSibling = index < this.rows.length - 1 ? this.rows[index + 1] : null;
            });
        },
        insertBefore(node, referenceNode) {
            const nodeIndex = this.rows.indexOf(node);
            const refIndex = this.rows.indexOf(referenceNode);
            if (nodeIndex < 0 || refIndex < 0 || nodeIndex === refIndex) return;
            this.rows.splice(nodeIndex, 1);
            const adjustedRefIndex = this.rows.indexOf(referenceNode);
            this.rows.splice(adjustedRefIndex, 0, node);
            this.syncLinks();
        }
    };
    container.syncLinks();
    return container;
}

describe('IT-FE-DATE integration', () => {
    const adjustment = {
        id: 77,
        title: 'integration-date-adjustment',
        candidates: [
            { id: 'c1', date: '2026-07-10', start_time: '18:00', end_time: '21:00', note: 'main' },
            { id: 'c2', date: '2026-07-11', start_time: '18:00', end_time: '21:00', note: '' },
            { id: 'c3', date: '2026-07-12', start_time: '18:00', end_time: '21:00', note: '' }
        ]
    };

    const responses = [
        { adjustment_id: 77, candidate_id: 'c1', member_id: 1, name: 'A', status: 'ok', note: '参加できます' },
        { adjustment_id: 77, candidate_id: 'c1', member_id: 2, name: 'B', status: 'maybe', note: '' },
        { adjustment_id: 77, candidate_id: 'c2', member_id: 1, name: 'A', status: 'ng', note: '' },
        { adjustment_id: 77, candidate_id: 'c3', member_id: 2, name: 'B', status: 'ok', note: '遅れて参加' }
    ];

    const members = [
        { id: 1, name: 'A' },
        { id: 2, name: 'B' },
        { id: 3, name: 'C' }
    ];

    test('IT-FE-DATE-001 + 002 ranking and best candidate chain', () => {
        const summary = buildDateAdjustmentSummary(adjustment, responses, members, (m) => m.name);

        expect(summary.rankedCandidates[0].candidate.id).toBe('c1');
        expect(summary.bestCandidateId).toBe('c1');
        expect(summary.rankByCandidateId.get('c1')).toBe(1);
    });

    test('IT-FE-DATE-003 unanswered extraction chain', () => {
        const summary = buildDateAdjustmentSummary(adjustment, responses, members, (m) => m.name);
        expect(summary.unansweredMembers.map((m) => m.id)).toEqual([3]);
    });

    test('IT-FE-DATE-004 + 005 comment filter toggle chain', () => {
        const summary = buildDateAdjustmentSummary(adjustment, responses, members, (m) => m.name);

        const commentOnly = filterRespondentRows(summary.respondentRowsData, true);
        const allRows = filterRespondentRows(summary.respondentRowsData, false);

        expect(commentOnly).toHaveLength(2);
        expect(commentOnly.map((r) => r.name).sort()).toEqual(['A', 'B']);
        expect(allRows).toHaveLength(2);
    });

    test('IT-FE-DATE-007 reminder source label chain', () => {
        const summary = buildDateAdjustmentSummary(adjustment, responses, members, (m) => m.name);
        const top = summary.rankedCandidates[0].candidate;
        const label = dateAdjustmentCandidateLabel(top, (d) => d);

        expect(label).toContain('2026-07-10');
        expect(label).toContain('18:00-21:00');
    });

    test('IT-FE-DATE-006 candidate reorder with DOM mock', () => {
        const container = createMockRowsContainer(['c1', 'c2', 'c3']);

        const movedUp = moveDateAdjustmentCandidateRow(container, container.rows[2], -1);
        expect(movedUp).toBe(true);
        expect(container.rows.map((row) => row.id)).toEqual(['c1', 'c3', 'c2']);

        const movedDown = moveDateAdjustmentCandidateRow(container, container.rows[0], 1);
        expect(movedDown).toBe(true);
        expect(container.rows.map((row) => row.id)).toEqual(['c3', 'c1', 'c2']);
    });
});
