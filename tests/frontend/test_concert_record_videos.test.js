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
                hidden: false,
                files: [],
                innerHTML: '',
                onchange: null,
                onclick: null,
                addEventListener: vi.fn(),
                querySelectorAll: vi.fn(() => []),
                closest: vi.fn(() => null),
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
        performances: [
            { id: 1, title: 'Concert A', date: '2026-07-01' },
            { id: 2, title: 'Concert B', date: '2026-08-01' },
        ],
        concertRecordVideos: [],
        ...appStateOverrides,
    };

    const sandbox = {
        window: {
            portalRuntimeContext: {
                appState,
                getById,
            },
        },
        globalThis: null,
        console,
        escapeHtml: (value) => String(value ?? ''),
        formatDateWithWeekday: (value) => String(value ?? ''),
        showAlert: vi.fn(),
        confirmDelete: vi.fn(() => true),
        withButtonStatus: (_button, _label, callback) => callback(),
        request: vi.fn(async () => ({})),
        saveExtra: vi.fn(async () => ({})),
        loadExtraData: vi.fn(async () => {}),
        jsonOptions: vi.fn((method, body) => ({ method, ...body })),
        saveSnsSetting: vi.fn(),
    };

    sandbox.globalThis = sandbox;
    sandbox.appState = sandbox.window.portalRuntimeContext.appState;
    sandbox.$ = getById;

    vm.createContext(sandbox);
    vm.runInContext(readSource('src/static/js/modules/portal_views.js'), sandbox);
    vm.runInContext(readSource('src/static/js/modules/concert_record.js'), sandbox);

    return { sandbox, rendered, getById };
}

describe('concert record frontend regression', () => {
    test('member view renders videos with the shared YouTube link behavior', () => {
        const { sandbox, rendered } = createSandbox({
            performances: [
                { id: 1, title: 'Concert A', date: '2026-07-01' },
                { id: 2, title: 'Concert B', date: '2026-08-01' },
            ],
            concertRecordVideos: [
                {
                    id: 11,
                    performance_id: 2,
                    title: 'Video B2',
                    youtube_url: 'https://www.youtube.com/watch?v=bbbbbbbbbbb',
                    thumbnail_url: 'https://img.example/b2.jpg',
                    sort_order: 2,
                },
                {
                    id: 12,
                    performance_id: 1,
                    title: 'Video A1',
                    youtube_url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
                    thumbnail_url: '',
                    sort_order: 1,
                },
            ],
        });

        sandbox.renderConcertRecordView();

        const html = rendered.memberConcertRecordInfo || '';
        expect(html).toContain('Concert A');
        expect(html).toContain('Concert B');
        expect(html).toContain('Video A1');
        expect(html).toContain('Video B2');
        expect(html).toContain('target="_blank"');
        expect(html).toContain('rel="noopener noreferrer"');
    });

    test('admin view and edit flow keep the shared form state in sync', async () => {
        const { sandbox, rendered, getById } = createSandbox({
            performances: [
                { id: 1, title: 'Concert A', date: '2026-07-01' },
                { id: 2, title: 'Concert B', date: '2026-08-01' },
            ],
            concertRecordVideos: [
                {
                    id: 21,
                    performance_id: 1,
                    title: 'Video A1',
                    youtube_url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
                    thumbnail_url: 'https://img.example/a1.jpg',
                    sort_order: 1,
                    updated_at: '2026-08-08T00:00:00',
                },
                {
                    id: 22,
                    performance_id: 1,
                    title: 'Video A2',
                    youtube_url: 'https://www.youtube.com/watch?v=bbbbbbbbbbb',
                    thumbnail_url: 'https://img.example/a2.jpg',
                    sort_order: 2,
                    updated_at: '2026-08-08T00:00:00',
                },
            ],
        });

        getById('concertRecordPerformance').value = '1';
        sandbox.renderConcertRecordAdminView();

        const html = rendered.concertRecordAdminList || '';
        expect(html).toContain('Video A1');
        expect(html).toContain('Video A2');
        expect(html).toContain('concert-record-edit-btn');
        expect(html).toContain('concert-record-delete-btn');

        sandbox.startConcertRecordVideoEdit('21');
        expect(getById('concertRecordVideoId').value).toBe('21');
        expect(getById('concertRecordPerformance').value).toBe('1');
        expect(getById('concertRecordYoutubeUrl').value).toBe('https://www.youtube.com/watch?v=aaaaaaaaaaa');
        expect(getById('concertRecordSaveBtn').textContent).toBe('更新');
        expect(getById('concertRecordCancelBtn').hidden).toBe(false);

        getById('concertRecordYoutubeUrl').value = 'https://www.youtube.com/watch?v=ccccccccccc';
        sandbox.request.mockResolvedValueOnce({});
        await sandbox.saveConcertRecordVideo();

        expect(sandbox.request).toHaveBeenCalledWith(
            '/api/extra/concert_record_videos/21',
            {
                method: 'PUT',
                payload: {
                    performance_id: 1,
                    sort_order: 1,
                    youtube_url: 'https://www.youtube.com/watch?v=ccccccccccc',
                },
                expected_updated_at: '2026-08-08T00:00:00',
            }
        );
        expect(sandbox.loadExtraData).toHaveBeenCalledWith(['concertRecordVideos']);

        sandbox.saveExtra.mockClear();
        sandbox.loadExtraData.mockClear();
        getById('concertRecordVideoId').value = '';
        getById('concertRecordPerformance').value = '2';
        getById('concertRecordYoutubeUrl').value = 'https://www.youtube.com/watch?v=ddddddddddd';

        await sandbox.saveConcertRecordVideo();

        expect(sandbox.saveExtra).toHaveBeenCalledWith('concert_record_videos', {
            performance_id: 2,
            youtube_url: 'https://www.youtube.com/watch?v=ddddddddddd',
        });
        expect(sandbox.loadExtraData).toHaveBeenCalledWith(['concertRecordVideos']);

        sandbox.confirmDelete.mockReturnValueOnce(true);
        await sandbox.deleteConcertRecordVideo('21');
        expect(sandbox.request).toHaveBeenCalledWith('/api/extra/concert_record_videos/21', { method: 'DELETE' });

        await sandbox.moveConcertRecordVideo('22', -1);
        expect(sandbox.request).toHaveBeenCalledWith(
            '/api/extra/concert_record_videos/22',
            {
                method: 'PUT',
                payload: {
                    performance_id: 1,
                    sort_order: 1,
                    youtube_url: 'https://www.youtube.com/watch?v=bbbbbbbbbbb',
                },
                expected_updated_at: '2026-08-08T00:00:00',
            }
        );
    });
});
