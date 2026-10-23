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

    test('intro batches all members, revalidates and never fills private detail cache', async () => {
        const request = vi.fn(async (url) => {
            if (url === '/api/member-introductions') return [detailMember(1), detailMember(2)];
            if (url === '/api/members/1') return detailMember(1);
            throw new Error(`unexpected request: ${url}`);
        });
        const { sandbox, appState, elements } = buildMemberSandbox(request);
        appState.members = Array.from({ length: 59 }, (_, i) => ({ id: i + 1, name: `Member ${i + 1}` }));
        await sandbox.showMemberIntroView();
        expect(request.mock.calls.map(([url]) => url)).toEqual(['/api/member-introductions']);
        expect(appState.memberDetailRecords).toEqual({});
        expect(appState.members[0]).not.toHaveProperty('comment');
        expect(elements.get('memberIntroInfo').innerHTML).toContain('Comment 1');
        await sandbox.showMemberIntroView();
        expect(request.mock.calls.map(([url]) => url)).toEqual(['/api/member-introductions', '/api/member-introductions']);
        await sandbox.loadMemberDetail(1);
        expect(request.mock.calls.at(-1)[0]).toBe('/api/members/1');
        expect(appState.memberDetailRecords[1]).toHaveProperty('comment', 'Comment 1');
    });

    test('waiting intro retries retain this account DOM, but never preserve it for another account', async () => {
        const request = vi.fn(async () => [detailMember(1)]);
        const { sandbox, appState, elements } = buildMemberSandbox(request);
        await sandbox.showMemberIntroView();
        const html = elements.get('memberIntroInfo').innerHTML;
        sandbox.portalRetryWaitInfo = () => ({ blocked: true, message: 'あと1秒後に再試行できます。' });
        await sandbox.showMemberIntroView();
        expect(elements.get('memberIntroInfo').innerHTML).toBe(html);
        expect(request).toHaveBeenCalledTimes(1);
        expect(sandbox.showAlert).toHaveBeenCalledWith('あと1秒後に再試行できます。', 'warning');
        appState.currentUserMemberId = 999;
        appState.portalAuthGeneration = 'new-account';
        request.mockRejectedValueOnce(new Error('waiting'));
        await sandbox.showMemberIntroView();
        expect(elements.get('memberIntroInfo').innerHTML).not.toContain('Comment 1');
        expect(request).toHaveBeenCalledTimes(2);
    });

    test('intro uses the server-filtered records instead of the shared member list', async () => {
        const request = vi.fn(async () => [detailMember(1, { comment: 'General comment' })]);
        const { sandbox, appState, elements } = buildMemberSandbox(request);
        appState.members = [{ id: 1, permission: '一般' }, { id: 2, name: 'Extra Member', permission: 'エキストラ' }];
        await sandbox.showMemberIntroView();
        expect(elements.get('memberIntroInfo').innerHTML).toContain('General comment');
        expect(elements.get('memberIntroInfo').innerHTML).not.toContain('Extra Member');
    });

    test('concurrent intro openings join one request and logout discards its result', async () => {
        let resolveIntro;
        const request = vi.fn(() => new Promise((resolve) => { resolveIntro = resolve; }));
        const { sandbox, appState } = buildMemberSandbox(request);
        const first = sandbox.showMemberIntroView();
        const second = sandbox.showMemberIntroView();
        expect(request).toHaveBeenCalledTimes(1);
        sandbox.clearPortalAuthState();
        resolveIntro([detailMember(1)]);
        await Promise.all([first, second]);
        expect(appState.memberIntroRecords).toEqual([]);
        expect(appState.memberDetailRecords).toEqual({});
    });

    test('intro failure provides retry instead of a partial or stale member list', async () => {
        const { sandbox, elements } = buildMemberSandbox(vi.fn().mockRejectedValue(new Error('offline')));
        await sandbox.showMemberIntroView();
        expect(elements.get('memberIntroInfo').innerHTML).toContain('再試行');
    });

    test('an older intro failure cannot overwrite a newer successful view', async () => {
        let rejectOld;
        const request = vi.fn()
            .mockImplementationOnce(() => new Promise((_, reject) => { rejectOld = reject; }))
            .mockResolvedValueOnce([detailMember(1, { comment: 'Latest introduction' })]);
        const { sandbox, appState, elements } = buildMemberSandbox(request);
        const oldView = sandbox.showMemberIntroView();
        sandbox.clearMemberIntroCache();
        await sandbox.showMemberIntroView();
        const latestHtml = elements.get('memberIntroInfo').innerHTML;
        expect(latestHtml).toContain('Latest introduction');

        rejectOld(new Error('old request failed'));
        await oldView;

        expect(elements.get('memberIntroInfo').innerHTML).toBe(latestHtml);
        expect(appState.memberIntroRecords[0].comment).toBe('Latest introduction');
        expect(request).toHaveBeenCalledTimes(2);
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

