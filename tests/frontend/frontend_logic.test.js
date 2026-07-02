const {
    dateAdjustmentStatusLabel,
    dateAdjustmentStatusText,
    dateAdjustmentKeywordTokens,
    dateAdjustmentFrequentKeywordsFromNotes,
    dedupeDateAdjustmentResponses,
    dateAdjustmentCandidateLabel,
    mutationRelatedCacheKeys,
    buildRequestHeadersForApi,
    formatClockTime,
    splitTimeRange,
    formatTimeRange,
    addHoursToTime,
    compactCalendarDate,
    nextAllDayDate,
    icsEscape,
    displayNameWithoutExtension,
    formatDurationLabel,
    paymentPaymentRangeLabel,
    integerAmountNumber,
    integerAmountInputValue,
    yenAmountLabel,
    convertUrlsToLinks,
    foldSettledExtraResults,
    buildDateAdjustmentSummary,
    filterRespondentRows,
    normalizePerformancePieces,
    performancePieceDurationText,
    pieceScopedRows,
    uploadPieceOptions
} = require('../../src/static/js/frontend_testable_logic.js');

describe('FE-FN', () => {
    test('FE-FN-001 status label mapping', () => {
        expect(dateAdjustmentStatusLabel('ok')).toBe('○');
        expect(dateAdjustmentStatusLabel('maybe')).toBe('△');
        expect(dateAdjustmentStatusLabel('ng')).toBe('×');
        expect(dateAdjustmentStatusLabel('')).toBe('-');
    });

    test('FE-FN-002 status text mapping', () => {
        expect(dateAdjustmentStatusText('ok')).toBe('参加可');
        expect(dateAdjustmentStatusText('maybe')).toBe('調整可');
        expect(dateAdjustmentStatusText('ng')).toBe('不可');
        expect(dateAdjustmentStatusText('')).toBe('未回答');
    });

    test('FE-FN-003 keyword token extraction excludes URL', () => {
        const tokens = dateAdjustmentKeywordTokens('https://example.com 集合は19時 rehearsal note');
        expect(tokens).toContain('集合');
        expect(tokens).toContain('19');
        expect(tokens.some((t) => t.includes('http'))).toBe(false);
    });

    test('FE-FN-004 frequent keyword aggregation', () => {
        const result = dateAdjustmentFrequentKeywordsFromNotes([
            '車で行きます',
            '車だと遅れます',
            '電車は間に合います'
        ], 3);
        expect(result[0][0]).toBe('車');
        expect(result[0][1]).toBe(2);
    });

    test('FE-FN-005 dedupe responses', () => {
        const responses = [
            { candidate_id: 'c1', member_id: 1, name: 'a', status: 'ok' },
            { candidate_id: 'c1', member_id: 1, name: 'a', status: 'ng' },
            { candidate_id: 'c2', member_id: 1, name: 'a', status: 'ok' }
        ];
        const deduped = dedupeDateAdjustmentResponses(responses);
        expect(deduped).toHaveLength(2);
    });

    test('FE-FN-006 candidate label format', () => {
        const label = dateAdjustmentCandidateLabel(
            { date: '2026-07-10', start_time: '18:00', end_time: '21:00', note: '合奏のみ' },
            (d) => d
        );
        expect(label).toContain('2026-07-10');
        expect(label).toContain('18:00-21:00');
        expect(label).toContain('合奏のみ');
    });

    test('FE-FN-007 mutation related cache keys', () => {
        const keys = mutationRelatedCacheKeys('/api/extra/date_adjustments/1');
        expect(keys).toContain('/api/bootstrap-lite');
        expect(keys).toContain('/api/extra/date_adjustments/1');
    });
});

describe('FE-REQ', () => {
    test('FE-REQ-001 request header device id attached', () => {
        const headers = buildRequestHeadersForApi({ 'Content-Type': 'application/json' }, 'dev-1');
        expect(headers['X-Device-Id']).toBe('dev-1');
        expect(headers['Content-Type']).toBe('application/json');
    });

    test('FE-REQ-004 loadExtraData partial failure fallback', () => {
        const specs = [
            ['absences'],
            ['eventResponses'],
            ['sheets']
        ];
        const settled = [
            { status: 'fulfilled', value: [{ id: 1 }] },
            { status: 'rejected', reason: new Error('failed') },
            { status: 'fulfilled', value: { files: [{ id: 9 }] } }
        ];
        const folded = foldSettledExtraResults(settled, specs, {
            eventResponses: [{ id: 2 }],
            sheetLibrary: [{ id: 8 }]
        });

        expect(folded.failed).toEqual(['eventResponses']);
        expect(folded.values.absences).toEqual([{ id: 1 }]);
        expect(folded.values.eventResponses).toEqual([{ id: 2 }]);
        expect(folded.values.sheets.files).toEqual([{ id: 9 }]);
    });
});

describe('FE-TIME', () => {
    test('FE-TIME-001 clock normalize', () => {
        expect(formatClockTime('9:05')).toBe('09:05');
        expect(formatClockTime('18:30:00')).toBe('18:30');
    });

    test('FE-TIME-002 split range', () => {
        expect(splitTimeRange('9:00-11:30')).toEqual({ start: '09:00', end: '11:30' });
        expect(splitTimeRange('invalid')).toEqual({ start: '', end: '' });
    });

    test('FE-TIME-002b format range', () => {
        expect(formatTimeRange('9:00', '11:30')).toBe('09:00 - 11:30');
        expect(formatTimeRange('9:00', '')).toBe('09:00');
    });

    test('FE-TIME-003 add hours', () => {
        expect(addHoursToTime('23:30', 2)).toBe('01:30');
    });

    test('FE-TIME-004 compact calendar datetime', () => {
        expect(compactCalendarDate('2026-07-01')).toBe('20260701');
        expect(compactCalendarDate('2026-07-01', '18:30')).toBe('20260701T183000');
        expect(compactCalendarDate('2026-07-01', '18:30:00')).toBe('20260701T183000');
    });

    test('FE-TIME-005 next all day date', () => {
        expect(nextAllDayDate('2026-07-01')).toBe('2026-07-02');
    });
});

describe('FE-PURE', () => {
    test('FE-PURE-001 display name without extension', () => {
        expect(displayNameWithoutExtension('sample.wav')).toBe('sample');
        expect(displayNameWithoutExtension('nested/path/song.mp3')).toBe('nested/path/song');
    });

    test('FE-PURE-002 format duration from seconds', () => {
        expect(formatDurationLabel({ duration_seconds: 65 })).toBe('1:05');
        expect(formatDurationLabel({ duration: '2:34' })).toBe('2:34');
        expect(formatDurationLabel({})).toBe('長さ未取得');
    });

    test('FE-PURE-003 payment range label', () => {
        expect(paymentPaymentRangeLabel({ paid_until_month: '2026-12' })).toBe('2026-12まで支払い済み');
        expect(paymentPaymentRangeLabel({})).toBe('未登録');
    });

    test('FE-PURE-004 yen amount labels do not show decimals', () => {
        expect(integerAmountNumber('5000.00')).toBe(5000);
        expect(integerAmountInputValue('5000.00')).toBe('5000');
        expect(yenAmountLabel('5000.00')).toBe('5,000円');
        expect(yenAmountLabel('')).toBe('未設定');
    });

    test('FE-PURE-005 ics escape', () => {
        expect(icsEscape('a,b;c\\d\nline')).toBe('a\\,b\\;c\\\\d\\nline');
    });

    test('FE-PURE-006 convert URLs to safe links', () => {
        const html = convertUrlsToLinks('参考: https://example.com/path?q=1&x=2 <script>');
        expect(html).toContain('href="https://example.com/path?q=1&amp;x=2"');
        expect(html).toContain('target="_blank"');
        expect(html).toContain('rel="noopener noreferrer"');
        expect(html).toContain('&lt;script&gt;');
    });

    test('FE-PURE-007 normalize performance pieces', () => {
        const normalized = normalizePerformancePieces([
            'String Piece',
            { composer: 'Mozart', title: 'Requiem', alias: 'Req', duration: '10', is_encore: true },
            { name: 'Legacy Name Piece' },
            { title: '' }
        ]);

        expect(normalized).toEqual([
            { composer: '', title: 'String Piece' },
            { composer: 'Mozart', title: 'Requiem', alias: 'Req', duration: '10', is_encore: true },
            { composer: '', title: 'Legacy Name Piece', alias: '', duration: '', is_encore: false }
        ]);
    });

    test('FE-PURE-008 performance piece duration label', () => {
        expect(performancePieceDurationText({ duration: '7' })).toBe('演奏時間: 7分');
        expect(performancePieceDurationText({})).toBe('');
    });

    test('FE-PURE-009 piece scoped rows include migrated rows', () => {
        const rows = pieceScopedRows(
            [{ id: 1, title: 'Concert', date: '2026-08-01', pieces: [{ title: 'Sym', composer: 'B' }] }],
            [{ performance_id: 1, piece: '追加曲' }]
        );

        expect(rows).toHaveLength(1);
        expect(rows[0].pieces.map((piece) => piece.title)).toEqual(['Sym', '追加曲']);
    });

    test('FE-PURE-010 upload piece options include whole practice and dedupe', () => {
        const options = uploadPieceOptions(
            {
                pieces: [
                    { title: 'Sym', composer: 'B' },
                    { title: 'Sym', composer: 'B' }
                ]
            },
            '練習全体の通し'
        );

        expect(options.map((item) => item.value)).toEqual(['B: Sym', '練習全体の通し']);
    });
});

describe('FE-DATE', () => {
    const adjustment = {
        id: 10,
        title: 'test',
        candidates: [
            { id: 'c1', date: '2026-07-10', start_time: '18:00', end_time: '21:00', note: '' },
            { id: 'c2', date: '2026-07-11', start_time: '18:00', end_time: '21:00', note: '' }
        ]
    };

    const responses = [
        { adjustment_id: 10, candidate_id: 'c1', member_id: 1, name: 'A', status: 'ok', note: 'ok' },
        { adjustment_id: 10, candidate_id: 'c1', member_id: 2, name: 'B', status: 'maybe', note: '' },
        { adjustment_id: 10, candidate_id: 'c2', member_id: 1, name: 'A', status: 'ng', note: '' }
    ];

    const members = [
        { id: 1, name: 'A' },
        { id: 2, name: 'B' },
        { id: 3, name: 'C' }
    ];

    test('FE-DATE-001 ranking score', () => {
        const summary = buildDateAdjustmentSummary(adjustment, responses, members, (m) => m.name);
        const c1 = summary.candidateStats.find((item) => item.candidate.id === 'c1');
        expect(c1.score).toBe(3);
        expect(summary.bestCandidateId).toBe('c1');
    });

    test('FE-DATE-002 top candidate exists', () => {
        const summary = buildDateAdjustmentSummary(adjustment, responses, members, (m) => m.name);
        expect(summary.rankedCandidates[0].candidate.id).toBe('c1');
    });

    test('FE-DATE-003 unanswered extraction', () => {
        const summary = buildDateAdjustmentSummary(adjustment, responses, members, (m) => m.name);
        expect(summary.unansweredMembers.map((m) => m.id)).toEqual([3]);
    });

    test('FE-DATE-004 comment only filter', () => {
        const summary = buildDateAdjustmentSummary(adjustment, responses, members, (m) => m.name);
        const filtered = filterRespondentRows(summary.respondentRowsData, true);
        expect(filtered).toHaveLength(1);
        expect(filtered[0].name).toBe('A');
    });
});
