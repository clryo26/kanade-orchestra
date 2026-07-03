const {
    buildRequestHeadersForApi,
    buildConditionalGetHeadersForApi,
    mutationRelatedCacheKeys,
    foldSettledExtraResults,
    buildApiFailureMessage,
    shouldAttemptAuthRecovery
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

    test('IT-FE-REQ-006 401 is converted to explicit relogin message', () => {
        const message = buildApiFailureMessage('/api/extra/performance_day_infos', 'PUT', 401, 'Unauthorized');

        expect(message).toBe('ログイン期限が切れました。再ログインしてください。');
    });

    test('IT-FE-REQ-007 DB write failure detail is surfaced with target/action', () => {
        const message = buildApiFailureMessage(
            '/api/extra/performance_day_infos',
            'PUT',
            500,
            'DB write is not implemented for performance_day_infos'
        );

        expect(message).toContain('本番情報の更新に失敗しました');
        expect(message).toContain('DB write is not implemented for performance_day_infos');
    });

    test('IT-FE-REQ-008 auth recovery is attempted only for eligible 401 responses', () => {
        expect(shouldAttemptAuthRecovery(401, {}, '/api/extra/part_settings')).toBe(true);
        expect(shouldAttemptAuthRecovery(401, { _skipAuthRecovery: true }, '/api/extra/part_settings')).toBe(false);
        expect(shouldAttemptAuthRecovery(401, {}, '/api/auth/portal-login')).toBe(false);
        expect(shouldAttemptAuthRecovery(500, {}, '/api/extra/part_settings')).toBe(false);
    });
});
