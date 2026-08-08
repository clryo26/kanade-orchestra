const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '../..');

function readSource(rel) {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function createSandbox(appStateOverrides = {}) {
    const rendered = {};
    const elements = new Map();

    const getById = (id) => {
        if (!elements.has(id)) {
            elements.set(id, {
                id,
                value: '',
                textContent: '',
                href: '',
                files: [],
                innerHTML: '',
                addEventListener: vi.fn(),
                querySelectorAll: vi.fn(() => []),
                set innerHTML(value) {
                    rendered[id] = value;
                },
                get innerHTML() {
                    return rendered[id] || '';
                },
            });
        }
        return elements.get(id);
    };

    const appState = {
        desiredPieces: [],
        promotions: [],
        performances: [],
        desiredPieceFilters: { genre: '' },
        currentUserMemberId: 'member-owner',
        currentUserName: 'owner-a',
        ...appStateOverrides,
    };

    const sandbox = {
        window: {
            portalRuntimeContext: {
                appState,
                getById,
                today: () => '2026-08-08',
            },
        },
        globalThis: null,
        console,
        escapeHtml: (value) => String(value ?? ''),
        formatDateWithWeekday: (value) => String(value ?? ''),
        formatDateTimeLabel: (value) => String(value ?? ''),
        integerAmountInputValue: (value) => String(value ?? ''),
        currentUserMember: () => ({ id: 'member-owner' }),
        currentUserMemberName: () => 'owner-a',
        currentOrgSetting: () => ({ membership_fee_amount: 0 }),
        withButtonStatus: (_button, _label, callback) => callback(),
        showAlert: vi.fn(),
        saveDesiredPiece: vi.fn(),
        toggleDesiredPieceVote: vi.fn(),
        deleteDesiredPiece: vi.fn(),
        savePerformanceFee: vi.fn(),
        saveOrgMembershipFee: vi.fn(),
        previewPromotionImage: vi.fn(),
        savePromotion: vi.fn(),
        deletePromotion: vi.fn(),
        renderPdfViewer: vi.fn(),
        switchTab: vi.fn(),
    };

    sandbox.globalThis = sandbox;
    sandbox.appState = sandbox.window.portalRuntimeContext.appState;
    sandbox.$ = getById;

    vm.createContext(sandbox);
    vm.runInContext(readSource('src/static/js/modules/date_piece_promotion/state.js'), sandbox);
    vm.runInContext(readSource('src/static/js/modules/date_piece_promotion/events.js'), sandbox);
    vm.runInContext(readSource('src/static/js/modules/date_piece_promotion/render_desired_promotion.js'), sandbox);

    return { sandbox, rendered, getById };
}

describe('desired piece reference asset frontend regression', () => {
    test('reference audio and score controls render in the expected order and list is sorted by votes', () => {
        const { sandbox, rendered } = createSandbox({
            desiredPieces: [
                {
                    id: 1,
                    title: 'Alpha',
                    composer: 'Composer A',
                    duration: '4:00',
                    genre: 'クラシック',
                    formation: 'Orchestra',
                    notes: 'Alpha note',
                    reference_audio_url: 'https://youtu.be/abcdefghijk',
                    reference_score_url: '/api/extra/desired_pieces/1/reference_score',
                    votes: [{ member_id: 'a' }, { member_id: 'b' }],
                    registered_by: 'owner-a',
                    member_id: 'member-owner',
                },
                {
                    id: 2,
                    title: 'Bravo',
                    composer: 'Composer B',
                    duration: '5:00',
                    genre: 'ポップス',
                    formation: 'Band',
                    notes: 'Bravo note',
                    reference_audio_url: '',
                    reference_score_url: '',
                    votes: [{ member_id: 'a' }, { member_id: 'b' }, { member_id: 'c' }],
                    registered_by: 'owner-a',
                    member_id: 'member-owner',
                },
            ],
        });

        sandbox.renderDesiredPieceView();
        const html = rendered.memberDesiredPieceInfo || '';

        expect(html.indexOf('Bravo')).toBeLessThan(html.indexOf('Alpha'));
        expect(html).toContain('desiredPieceGenreFilter');
        expect(html).toContain('value="classic"');
        expect(html).toContain('value="other"');
        expect(html).toContain('target="_blank"');
        expect(html).toContain('rel="noopener noreferrer"');
        expect(html.indexOf('参考音源')).toBeLessThan(html.indexOf('補足・理由'));
        expect(html.indexOf('参考スコア')).toBeLessThan(html.indexOf('補足・理由'));
    });

    test('genre filter narrows the list without changing vote order', () => {
        const classicFirst = createSandbox({
            desiredPieceFilters: { genre: 'classic' },
            desiredPieces: [
                {
                    id: 1,
                    title: 'Classic Low',
                    composer: 'Composer A',
                    duration: '4:00',
                    genre: 'クラシック',
                    notes: 'note',
                    votes: [{ member_id: 'a' }],
                },
                {
                    id: 2,
                    title: 'Classic High',
                    composer: 'Composer B',
                    duration: '5:00',
                    genre: 'クラシック',
                    notes: 'note',
                    votes: [{ member_id: 'a' }, { member_id: 'b' }],
                },
                {
                    id: 3,
                    title: 'Other Piece',
                    composer: 'Composer C',
                    duration: '6:00',
                    genre: 'ポップス',
                    notes: 'note',
                    votes: [{ member_id: 'a' }, { member_id: 'b' }, { member_id: 'c' }],
                },
            ],
        });
        classicFirst.sandbox.renderDesiredPieceView();
        const classicHtml = classicFirst.rendered.memberDesiredPieceInfo || '';
        expect(classicHtml).toContain('Classic High');
        expect(classicHtml).toContain('Classic Low');
        expect(classicHtml).not.toContain('Other Piece');
        expect(classicHtml.indexOf('Classic High')).toBeLessThan(classicHtml.indexOf('Classic Low'));

        const otherOnly = createSandbox({
            desiredPieceFilters: { genre: 'other' },
            desiredPieces: classicFirst.sandbox.appState.desiredPieces,
        });
        otherOnly.sandbox.renderDesiredPieceView();
        const otherHtml = otherOnly.rendered.memberDesiredPieceInfo || '';
        expect(otherHtml).toContain('Other Piece');
        expect(otherHtml).not.toContain('Classic High');
        expect(otherHtml).not.toContain('Classic Low');
    });

    test('reference score button opens the shared PDF viewer', () => {
        const { sandbox } = createSandbox({
            desiredPieces: [
                {
                    id: 9,
                    title: 'Score Piece',
                    reference_score_url: '/api/extra/desired_pieces/9/reference_score',
                    votes: [],
                },
            ],
        });

        sandbox.showDesiredPieceReferenceScore(9);

        expect(sandbox.switchTab).toHaveBeenCalledWith('memberPanel', 'member-sheet-viewer', false);
        expect(sandbox.renderPdfViewer).toHaveBeenCalledWith('/api/extra/desired_pieces/9/reference_score');
        expect(sandbox.$('sheetViewerTitle').textContent).toBe('Score Piece');
        expect(sandbox.$('sheetViewerDownload').href).toBe('/api/extra/desired_pieces/9/reference_score');
    });
});
