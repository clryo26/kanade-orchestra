const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '../..');
const BOOTSTRAP_SOURCE = fs.readFileSync(
    path.join(ROOT, 'src/static/js/modules/bootstrap_loader.js'),
    'utf8'
);

function createBootstrapSandbox() {
    const appState = {
        absences: [],
        eventResponses: [],
        dateAdjustments: [],
        dateAdjustmentResponses: [],
        sheetLibrary: [],
        payments: [],
        castings: [],
        pieceInfos: [],
        practiceInstructions: [],
        performanceDayInfos: [],
        desiredPieces: [],
        promotions: [],
        albums: [],
        partSettings: [],
        venueSettings: [],
        flyerDistributions: [],
        flyerDistributionAssignments: [],
        orgSettings: [],
        snsSettings: [],
        connectionSettings: [],
    };

    const request = vi.fn(async (url) => {
        if (url === '/api/sheets') return { files: [] };
        return [{ sourceUrl: url }];
    });

    const sandbox = {
        window: null,
        globalThis: null,
        document: {
            addEventListener: vi.fn(),
        },
        console: {
            warn: vi.fn(),
            error: vi.fn(),
            log: vi.fn(),
        },
        request,
        requestJson: vi.fn(),
        showAlert: vi.fn(),
        setLoadingBar: vi.fn(),
        clearLoadingBar: vi.fn(),

        refreshPartSelectOptions: vi.fn(),
        refreshVenueOptions: vi.fn(),
        applyOrgSettings: vi.fn(),
        renderEvents: vi.fn(),
        renderMemberExtraViews: vi.fn(),
        renderSheetAdmin: vi.fn(),
        renderPaymentAdmin: vi.fn(),
        renderPartManagement: vi.fn(),
        renderVenueManagement: vi.fn(),
        renderFlyerDistributionManagement: vi.fn(),
        renderCastingAdmin: vi.fn(),
        renderPracticeInstructionAdmin: vi.fn(),
        renderPerformanceDayInfoAdmin: vi.fn(),
        renderOrgManagement: vi.fn(),
        renderSnsManagement: vi.fn(),
        renderConnectionSettingsManagement: vi.fn(),
        renderAuthDevices: vi.fn(),
    };

    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.portalRuntimeContext = {
        appState,
        getById: vi.fn(() => null),
        dbCache: {
            getEntry: vi.fn(),
            delete: vi.fn(),
        },
    };

    vm.runInNewContext(BOOTSTRAP_SOURCE, sandbox);

    return { sandbox, appState, request };
}

describe('performance-day module regression', () => {
    test('runtime loads split modules without the legacy implementation file', () => {
        const indexHtml = fs.readFileSync(
            path.join(ROOT, 'src/index.html'),
            'utf8'
        );
        const appJs = fs.readFileSync(
            path.join(ROOT, 'src/static/js/app.js'),
            'utf8'
        );

        expect(indexHtml).toContain(
            '/static/js/modules/performance_day/helpers.js'
        );
        expect(indexHtml).toContain(
            '/static/js/modules/performance_day/render.js'
        );
        expect(indexHtml).not.toContain(
            '/static/js/modules/performance_day/events.js'
        );
        expect(indexHtml).not.toMatch(
            /\/static\/js\/modules\/performance_day\.js(?:\?|["'])/
        );

        expect(appJs).toContain(
            '/static/js/modules/performance_day/helpers.js'
        );
        expect(appJs).toContain(
            '/static/js/modules/performance_day/render.js'
        );
        expect(appJs).not.toContain(
            '/static/js/modules/performance_day/events.js'
        );
        expect(appJs).not.toContain(
            "'/static/js/modules/performance_day.js'"
        );
    });

    test('split event module uses the currently rendered time and part rehearsal fields', () => {
        const eventsSource = fs.readFileSync(
            path.join(
                ROOT,
                'src/static/js/modules/performance_day/events.js'
            ),
            'utf8'
        );

        expect(eventsSource).toContain('performanceDayOpenTime');
        expect(eventsSource).toContain(
            'performanceDayRehearsalStartTime'
        );
        expect(eventsSource).toContain('performanceDayStartTime');
        expect(eventsSource).toContain(
            'collectPerformanceDayPartRehearsalRows'
        );
        expect(eventsSource).not.toContain('performanceDayTimeline');
    });
});


describe('mutation reload call sites', () => {
    test('runtime mutation modules use targeted extra-data reloads', () => {
        const runtimeFiles = [
            'src/static/js/modules/absences.js',
            'src/static/js/modules/admin_system/api.js',
            'src/static/js/modules/admin_system.js',
            'src/static/js/modules/albums.js',
            'src/static/js/modules/date_piece_promotion/api.js',
            'src/static/js/modules/date_piece_promotion/events.js',
            'src/static/js/modules/date_piece_promotion/render_piece_practice.js',
            'src/static/js/modules/events.js',
            'src/static/js/modules/members/events.js',
            'src/static/js/modules/members.js',
            'src/static/js/modules/payments.js',
            'src/static/js/modules/performance_day/events.js',
            'src/static/js/modules/portal_views.js',
            'src/static/js/modules/practice_casting/api.js',
            'src/static/js/modules/sns.js',
        ];

        const emptyCalls = [];

        for (const relativePath of runtimeFiles) {
            const source = fs.readFileSync(
                path.join(ROOT, relativePath),
                'utf8'
            );

            if (/\bloadExtraData\s*\(\s*\)/.test(source)) {
                emptyCalls.push(relativePath);
            }
        }

        expect(emptyCalls).toEqual([]);
    });
});

describe('targeted extra-data reload', () => {
    test('requested collection reload sends only its own GET request', async () => {
        const { sandbox, appState, request } =
            createBootstrapSandbox();

        await sandbox.loadExtraData(['desiredPieces']);

        expect(request).toHaveBeenCalledTimes(1);
        expect(request).toHaveBeenCalledWith(
            '/api/extra/desired_pieces'
        );
        expect(appState.desiredPieces).toEqual([
            { sourceUrl: '/api/extra/desired_pieces' },
        ]);
    });

    test('omitting collection names preserves the full reload behavior', async () => {
        const { sandbox, request } = createBootstrapSandbox();

        await sandbox.loadExtraData();

        expect(request).toHaveBeenCalledTimes(21);
        expect(request).toHaveBeenCalledWith(
            '/api/extra/absences'
        );
        expect(request).toHaveBeenCalledWith('/api/sheets');
        expect(request).toHaveBeenCalledWith(
            '/api/extra/connection_settings'
        );
    });

    test('deferred tab loading maps each tab to only the needed collections', async () => {
        const cases = [
            ['member-event', ['/api/events', '/api/extra/event_responses']],
            ['member-absence', ['/api/extra/absences']],
            ['member-date-adjustment', ['/api/extra/date_adjustments', '/api/extra/date_adjustment_responses']],
            ['member-practice-instruction', ['/api/extra/piece_infos', '/api/extra/practice_instructions']],
            ['member-performance-day', ['/api/extra/performance_day_infos']],
            ['member-casting', ['/api/extra/castings']],
            ['member-album', ['/api/extra/albums']],
            ['member-flyer-distribution', ['/api/extra/flyer_distributions', '/api/extra/flyer_distribution_assignments']],
            ['flyer-distribution-admin', ['/api/extra/flyer_distributions']],
            ['payment-admin', ['/api/extra/payments']],
            ['payment-setting', ['/api/extra/payments']],
            ['member-desired-piece', ['/api/extra/desired_pieces']],
            ['member-promotion', ['/api/extra/promotions']],
            ['member-concert-record', ['/api/extra/concert_record_videos']],
            ['concert-record-admin', ['/api/extra/concert_record_videos']],
            ['venue-admin', ['/api/extra/venue_settings']],
            ['system-connection', ['/api/extra/connection_settings']],
            ['system-auth', ['/api/auth/devices']],
        ];

        for (const [tabName, expectedUrls] of cases) {
            const { sandbox, request } = createBootstrapSandbox();

            await sandbox.ensureDeferredTabDataLoaded(tabName);

            const actualUrls = request.mock.calls.map(([url]) => url);
            expect(actualUrls).toEqual(expectedUrls);
        }
    });

    test('successful deferred load is not repeated for the same tab, but failures can be retried', async () => {
        const retryRequest = vi.fn(async (url) => {
            if (url === '/api/extra/promotions' && retryRequest.mock.calls.length === 1) {
                throw new Error('temporary failure');
            }
            return [{ sourceUrl: url }];
        });

        const { sandbox } = createBootstrapSandbox();
        sandbox.request.mockImplementation(retryRequest);

        await sandbox.ensureDeferredTabDataLoaded('member-promotion');
        expect(retryRequest).toHaveBeenCalledTimes(1);

        await sandbox.ensureDeferredTabDataLoaded('member-promotion');
        expect(retryRequest).toHaveBeenCalledTimes(2);

        await sandbox.ensureDeferredTabDataLoaded('member-promotion');
        expect(retryRequest).toHaveBeenCalledTimes(2);
    });

    test('payment admin loads only on demand and retries after a failure', async () => {
        const retryRequest = vi.fn(async (url) => {
            if (url === '/api/extra/payments' && retryRequest.mock.calls.length === 1) {
                throw new Error('temporary failure');
            }
            return [{ sourceUrl: url }];
        });

        const { sandbox } = createBootstrapSandbox();
        sandbox.request.mockImplementation(retryRequest);

        await sandbox.ensureDeferredTabDataLoaded('payment-admin');
        expect(retryRequest).toHaveBeenCalledTimes(1);

        await sandbox.ensureDeferredTabDataLoaded('payment-admin');
        expect(retryRequest).toHaveBeenCalledTimes(2);

        await sandbox.ensureDeferredTabDataLoaded('payment-setting');
        expect(retryRequest).toHaveBeenCalledTimes(2);
    });

    test('payment admin concurrent opens reuse the same in-flight request', async () => {
        const deferred = {};
        deferred.promise = new Promise((resolve) => {
            deferred.resolve = resolve;
        });
        const networkCalls = [];
        const inflight = new Map();
        const request = vi.fn(async (url) => {
            if (inflight.has(url)) return inflight.get(url);
            networkCalls.push(url);
            const promise = deferred.promise.finally(() => {
                inflight.delete(url);
            });
            inflight.set(url, promise);
            return promise;
        });

        const { sandbox } = createBootstrapSandbox();
        sandbox.request.mockImplementation(request);

        const first = sandbox.ensureDeferredTabDataLoaded('payment-admin');
        const second = sandbox.ensureDeferredTabDataLoaded('payment-setting');

        await Promise.resolve();

        expect(networkCalls).toEqual(['/api/extra/payments']);

        deferred.resolve([{ sourceUrl: '/api/extra/payments' }]);
        await Promise.all([first, second]);
    });

    test('flyer distribution tab loads both collections and retries a missing list only', async () => {
        const retryRequest = vi.fn(async (url) => {
            if (url === '/api/extra/flyer_distributions' && retryRequest.mock.calls.length === 1) {
                throw new Error('temporary failure');
            }
            return [{ sourceUrl: url }];
        });

        const { sandbox } = createBootstrapSandbox();
        sandbox.request.mockImplementation(retryRequest);

        await sandbox.ensureDeferredTabDataLoaded('member-flyer-distribution');
        expect(retryRequest.mock.calls.map(([url]) => url)).toEqual([
            '/api/extra/flyer_distributions',
            '/api/extra/flyer_distribution_assignments',
        ]);

        await sandbox.ensureDeferredTabDataLoaded('member-flyer-distribution');
        expect(retryRequest.mock.calls.map(([url]) => url)).toEqual([
            '/api/extra/flyer_distributions',
            '/api/extra/flyer_distribution_assignments',
            '/api/extra/flyer_distributions',
        ]);

        await sandbox.ensureDeferredTabDataLoaded('flyer-distribution-admin');
        expect(retryRequest.mock.calls.map(([url]) => url)).toEqual([
            '/api/extra/flyer_distributions',
            '/api/extra/flyer_distribution_assignments',
            '/api/extra/flyer_distributions',
        ]);
    });
});
