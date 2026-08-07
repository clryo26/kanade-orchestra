const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '../..');

function createElement() {
    return {
        innerHTML: '',
        value: '',
        checked: false,
        files: [],
        disabled: false,
        required: false,
        hidden: false,
        dataset: {},
        children: [],
        addEventListener: vi.fn(),
        appendChild(node) {
            this.children.push(node);
            return node;
        },
        querySelector: vi.fn(() => null),
        querySelectorAll: vi.fn(() => []),
        closest: vi.fn(() => null),
    };
}

function buildMemberSandbox(requestImpl) {
    const elements = new Map();
    const ids = [
        'memberListItems',
        'memberIntroInfo',
        'memberId',
        'memberLastName',
        'memberFirstName',
        'memberMaidenName',
        'memberLastNameKana',
        'memberFirstNameKana',
        'memberMaidenNameKana',
        'memberPart',
        'memberPhotoFile',
        'memberIsFounder',
        'memberIsRecordingManager',
        'memberIsSheetManager',
        'memberPermission',
        'memberJoinedAt',
        'memberSystemAccessUntil',
        'memberIntroducer',
        'memberRole',
        'memberInstrumentHistory',
        'memberPastOrchestras',
        'memberComment',
        'profilePhotoFile',
        'profileJoinedAt',
        'profileIntroducer',
        'profileRole',
        'profileInstrumentHistory',
        'profilePastOrchestras',
        'profileComment',
        'profileSaveBtn',
        'profileEditCancelBtn',
        'profileEditCancelBtnBottom',
    ];
    ids.forEach((id) => elements.set(id, createElement()));
    elements.get('memberListItems').appendChild = vi.fn(function appendChild(node) {
        this.children.push(node);
        return node;
    });

    const appState = {
        members: [],
        memberDetailRecords: {},
        memberDetailLoadStates: {},
        memberDetailLoadPromises: {},
        suppressDerivedRender: false,
        currentUserMemberId: 1,
        currentUserName: 'Admin',
    };

    const sandbox = {
        window: null,
        globalThis: null,
        console,
        localStorage: {
            getItem: vi.fn(() => null),
            setItem: vi.fn(),
            removeItem: vi.fn(),
            clear: vi.fn(),
        },
        document: {
            createElement: () => createElement(),
        },
        request: requestImpl,
        showAlert: vi.fn(),
        withButtonStatus: (_button, _label, action) => action(),
        confirmDelete: vi.fn(() => true),
        escapeHtml: (value) => String(value ?? ''),
        emptyText: (items, text) => (items && items.length ? '' : `<p>${text}</p>`),
        cssSafeId: (value) => String(value || '').replace(/[^a-zA-Z0-9_-]/g, '-'),
        partSortIndex: vi.fn(() => 0),
        groupBy: (items, key) => (items || []).reduce((acc, item) => {
            const groupKey = String(item[key] || '');
            acc[groupKey] ||= [];
            acc[groupKey].push(item);
            return acc;
        }, {}),
        renderMemberExtraViews: vi.fn(),
        renderMemberPerformances: vi.fn(),
        renderMemberSchedules: vi.fn(),
        renderAnnouncements: vi.fn(),
        renderPortalHome: vi.fn(),
        renderMemberViews: vi.fn(),
        renderPaymentAdmin: vi.fn(),
        renderLoadingPlaceholders: vi.fn(),
        renderMemberIntros: null,
        renderAbsenceView: vi.fn(),
        renderSheetLibraryView: vi.fn(),
        renderPracticeInstructionView: vi.fn(),
        renderFlyerDistributionView: vi.fn(),
        renderPaymentView: vi.fn(),
        renderCastingView: vi.fn(),
        renderMemberEventView: vi.fn(),
        renderPerformanceDayInfoView: vi.fn(),
        renderDateAdjustmentView: vi.fn(),
        renderPieceInfoView: vi.fn(),
        renderDesiredPieceView: vi.fn(),
        renderManualView: vi.fn(),
        renderPromotionView: vi.fn(),
        renderAlbumView: vi.fn(),
        renderConcertRecordView: vi.fn(),
        renderSnsView: vi.fn(),
        nextPerformance: vi.fn(() => null),
        daysUntil: vi.fn(() => 0),
        formatDateWithWeekday: vi.fn((value) => String(value || '')),
        escapeText: vi.fn((value) => String(value ?? '')),
        currentSnsSetting: vi.fn(() => ({ youtube_url: '' })),
    };

    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.portalRuntimeContext = {
        appState,
        getById: (id) => elements.get(id) || null,
        dbCache: {
            getEntry: vi.fn().mockResolvedValue(null),
            delete: vi.fn().mockResolvedValue(undefined),
            set: vi.fn().mockResolvedValue(undefined),
        },
        inFlightGetRequests: new Map(),
    };

    const files = [
        'src/static/js/modules/common_helpers/api_runtime.js',
        'src/static/js/modules/members/helpers.js',
        'src/static/js/modules/members/form.js',
        'src/static/js/modules/members/render.js',
        'src/static/js/modules/portal_views.js',
    ];
    files.forEach((relativePath) => {
        const code = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
        vm.runInNewContext(code, sandbox);
    });
    sandbox.request = requestImpl;
    sandbox.window.request = requestImpl;

    return { sandbox, appState, elements };
}

function detailMember(id, overrides = {}) {
    return {
        id,
        name: `Member ${id}`,
        last_name: `Last${id}`,
        first_name: `First${id}`,
        maiden_name: '',
        last_name_kana: `ラスト${id}`,
        first_name_kana: `ファースト${id}`,
        maiden_name_kana: '',
        part: 'Vn',
        photo_url: `/api/members/${id}/photo`,
        password_set: true,
        permission: '一般',
        joined_at: '2026-01',
        system_access_until: '',
        introducer: `Intro ${id}`,
        role: `Role ${id}`,
        instrument_history: `History ${id}`,
        past_orchestras: `Orchestra ${id}`,
        comment: `Comment ${id}`,
        ...overrides,
    };
}

describe('member detail on-demand', () => {
    test('member list renders summary-only data without fetching member detail', async () => {
        const request = vi.fn(async (url) => {
            if (url === '/api/members') {
                return [
                    {
                        id: 1,
                        name: 'Member 1',
                        last_name: 'Last1',
                        first_name: 'First1',
                        maiden_name: '',
                        last_name_kana: 'ラスト1',
                        first_name_kana: 'ファースト1',
                        part: 'Vn',
                        photo_url: '/api/members/1/photo',
                        password_set: true,
                        permission: '一般',
                        joined_at: '2026-01',
                        system_access_until: '',
                    },
                ];
            }
            throw new Error(`unexpected request: ${url}`);
        });
        const { sandbox, appState } = buildMemberSandbox(request);
        appState.members = await request('/api/members');

        sandbox.renderMembers();

        expect(request).toHaveBeenCalledTimes(1);
        expect(appState.members[0]).not.toHaveProperty('comment');
        expect(appState.members[0]).not.toHaveProperty('introducer');
        expect(sandbox.portalRuntimeContext.getById('memberListItems').appendChild).toHaveBeenCalled();
    });

    test('member intro loads details once and reuses the loaded cache', async () => {
        const request = vi.fn(async (url) => {
            const match = String(url).match(/^\/api\/members\/(\d+)$/);
            if (match) {
                return detailMember(Number(match[1]));
            }
            throw new Error(`unexpected request: ${url}`);
        });
        const { sandbox, appState, elements } = buildMemberSandbox(request);
        appState.members = [
            { id: 1, name: 'Member 1', last_name: 'Last1', first_name: 'First1', part: 'Vn', photo_url: '/api/members/1/photo', password_set: true, permission: '一般', joined_at: '2026-01', system_access_until: '' },
            { id: 2, name: 'Member 2', last_name: 'Last2', first_name: 'First2', part: 'Va', photo_url: '/api/members/2/photo', password_set: true, permission: '一般', joined_at: '2026-02', system_access_until: '' },
        ];

        await sandbox.showMemberIntroView();
        expect(request.mock.calls.map(([url]) => url)).toEqual(['/api/members/1', '/api/members/2']);
        expect(appState.members[0]).not.toHaveProperty('comment');
        expect(appState.members[1]).not.toHaveProperty('introducer');
        expect(appState.memberDetailRecords[1]).toHaveProperty('comment', 'Comment 1');
        expect(appState.memberDetailRecords[2]).toHaveProperty('introducer', 'Intro 2');
        expect(sandbox.memberDetailById(1)).toHaveProperty('comment', 'Comment 1');
        expect(elements.get('memberIntroInfo').innerHTML).toContain('Comment 1');

        await sandbox.showMemberIntroView();
        expect(request.mock.calls.map(([url]) => url)).toEqual(['/api/members/1', '/api/members/2']);
    });

    test('member intro concurrent openings do not duplicate in-flight member detail requests', async () => {
        let resolveDetail;
        const detailPromise = new Promise((resolve) => {
            resolveDetail = resolve;
        });
        const request = vi.fn(async (url) => {
            const match = String(url).match(/^\/api\/members\/(\d+)$/);
            if (match) {
                return detailPromise;
            }
            throw new Error(`unexpected request: ${url}`);
        });
        const { sandbox, appState } = buildMemberSandbox(request);
        appState.members = [
            { id: 1, name: 'Member 1', last_name: 'Last1', first_name: 'First1', part: 'Vn', photo_url: '/api/members/1/photo', password_set: true, permission: '一般', joined_at: '2026-01', system_access_until: '' },
        ];

        const first = sandbox.showMemberIntroView();
        await Promise.resolve();
        const second = sandbox.showMemberIntroView();
        await Promise.resolve();

        expect(request).toHaveBeenCalledTimes(1);

        resolveDetail(detailMember(1));
        await Promise.all([first, second]);
    });

    test('member edit flows fetch member detail before rendering forms', async () => {
        const request = vi.fn(async (url, options = {}) => {
            if (url === '/api/members/1') {
                return detailMember(1);
            }
            if (url === '/api/members/1/profile' && options.method === 'PUT') {
                return detailMember(1, { comment: 'Updated comment' });
            }
            throw new Error(`unexpected request: ${url}`);
        });
        const { sandbox, elements } = buildMemberSandbox(request);
        sandbox.portalRuntimeContext.appState.members = [
            { id: 1, name: 'Member 1', last_name: 'Last1', first_name: 'First1', part: 'Vn', photo_url: '/api/members/1/photo', password_set: true, permission: '一般', joined_at: '2026-01', system_access_until: '' },
        ];

        await sandbox.selectMember(1);
        expect(request).toHaveBeenCalledWith('/api/members/1');
        expect(elements.get('memberIntroducer').value).toBe('Intro 1');

        await sandbox.showOwnProfileEditForm(1);
        expect(request).toHaveBeenCalledWith('/api/members/1');
        expect(elements.get('memberIntroInfo').innerHTML).toContain('プロフィール編集');
    });
});

