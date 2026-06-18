const {
    buildRequestHeadersForApi,
    buildConditionalGetHeadersForApi,
    mutationRelatedCacheKeys,
    foldSettledExtraResults
} = require('../../../src/static/js/frontend_testable_logic.js');

describe('IT-FE-REQ integration', () => {
    test('IT-FE-REQ-001 + 003 header attachment and cache invalidation chain', () => {
        const headers = buildRequestHeadersForApi({ 'Content-Type': 'application/json' }, 'dev-integration');
        expect(headers['X-Device-Id']).toBe('dev-integration');

        const invalidated = mutationRelatedCacheKeys('/api/extra/date_adjustments/10');
        expect(invalidated).toContain('/api/bootstrap-lite');
        expect(invalidated).toContain('/api/bootstrap-core');
        expect(invalidated).toContain('/api/bootstrap');
        expect(invalidated).toContain('/api/extra/date_adjustments/10');
    });

    test('IT-FE-REQ-005 partial failure fallback chain', () => {
        const requestSpecs = [
            ['absences'],
            ['eventResponses'],
            ['dateAdjustments'],
            ['dateAdjustmentResponses'],
            ['sheets']
        ];

        const settled = [
            { status: 'fulfilled', value: [{ id: 1, member_id: 1 }] },
            { status: 'rejected', reason: new Error('event response failed') },
            { status: 'fulfilled', value: [{ id: 10, title: 'A' }] },
            { status: 'fulfilled', value: [{ id: 100, adjustment_id: 10, candidate_id: 'c1', member_id: 1, name: 'A', status: 'ok' }] },
            { status: 'fulfilled', value: { files: [{ id: 900, title: 'sheet' }] } }
        ];

        const currentState = {
            eventResponses: [{ id: 2, event_id: 20 }],
            sheetLibrary: [{ id: 800, title: 'old-sheet' }]
        };

        const folded = foldSettledExtraResults(settled, requestSpecs, currentState);

        expect(folded.failed).toEqual(['eventResponses']);
        expect(folded.values.absences).toEqual([{ id: 1, member_id: 1 }]);
        expect(folded.values.eventResponses).toEqual([{ id: 2, event_id: 20 }]);
        expect(folded.values.dateAdjustments).toHaveLength(1);
        expect(folded.values.dateAdjustmentResponses).toHaveLength(1);
        expect(folded.values.sheets.files).toEqual([{ id: 900, title: 'sheet' }]);
    });

    test('IT-FE-REQ-002 GET sends If-None-Match when ETag exists', () => {
        const baseHeaders = buildRequestHeadersForApi({ Accept: 'application/json' }, 'dev-integration');
        const headers = buildConditionalGetHeadersForApi(baseHeaders, 'W/"etag-123"');

        expect(headers.Accept).toBe('application/json');
        expect(headers['X-Device-Id']).toBe('dev-integration');
        expect(headers['If-None-Match']).toBe('W/"etag-123"');
    });

    test('IT-FE-REQ-004 mutationRelatedCacheKeys returns expected set by API family', () => {
        const sheetKeys = mutationRelatedCacheKeys('/api/sheets/12');
        expect(sheetKeys).toContain('/api/sheets');
        expect(sheetKeys).toContain('/api/extra/sheet_library');

        const recordingKeys = mutationRelatedCacheKeys('/api/recordings/delete');
        expect(recordingKeys).toContain('/api/recordings');
        expect(recordingKeys).toContain('/api/drive/files');
    });
});
