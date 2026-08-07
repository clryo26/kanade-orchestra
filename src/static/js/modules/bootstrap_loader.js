// Frontend split: extracted from main.js.
// Loaded after main.js; functions intentionally remain global for legacy handlers.

var appState = window.portalRuntimeContext.appState;
var $ = window.portalRuntimeContext.getById;

async function loadPartSettingsForLogin() {
    try {
        const [partSettings, orgSettings, snsSettings] = await Promise.all([
            request('/api/extra/part_settings'),
            request('/api/extra/org_settings'),
            request('/api/extra/sns_settings')
        ]);
        appState.partSettings = partSettings;
        appState.orgSettings = orgSettings;
        appState.snsSettings = snsSettings;
        refreshPartSelectOptions();
        applyOrgSettings();
    } catch {
        refreshPartSelectOptions();
        applyOrgSettings();
    }
}

// ダウンロード系リンクをクリックしたときに確認ダイアログを挟む。

function bindDownloadConfirmations() {
    document.addEventListener('click', (event) => {
        const link = event.target.closest('a');
        if (!link) return;
        const label = String(link.textContent || '').trim();
        const href = link.getAttribute('href') || '';
        const isDownload = link.hasAttribute('download') || /DL|ダウンロード/.test(label) || href.includes('/download') || href.includes('download-zip');
        if (isDownload && !confirm('ダウンロードしますか？')) {
            event.preventDefault();
            event.stopPropagation();
        }
    }, true);
}

// 新規入力フォームの日付初期値を当日にそろえる。

function setDefaultDates() {
    ['uploadDate', 'schedDate', 'annDate', 'paymentLatestDate'].forEach((id) => {
        if ($(id)) $(id).value = window.portalRuntimeContext.today();
    });
    $('perfDate').value = window.portalRuntimeContext.today();
}

// 団員トップ画面と楽譜ビューワー枠を初期化する。
// 既に生成済みなら重複生成しない。

// 読み込み失敗時はローディングバーを解除して例外を呼出元へ伝播する
async function loadEssentialData(options = {}) {
    const useCachedPreview = options.useCachedPreview === true;
    const cacheKey = '/api/bootstrap-lite';

    let cachedPreviewRendered = false;
    let cachedPreviewData = null;

    setLoadingBar('データを読み込んでいます...');

    if (
        useCachedPreview &&
        appState.portalAuthVerified === true &&
        window.portalRuntimeContext &&
        window.portalRuntimeContext.dbCache
    ) {
        const cachedEntry =
            await window.portalRuntimeContext.dbCache.getEntry(cacheKey);

        if (
            cachedEntry &&
            (
                cachedEntry.invalid === true ||
                !cachedEntry.data ||
                typeof cachedEntry.data !== 'object'
            )
        ) {
            try {
                await window.portalRuntimeContext.dbCache.delete(cacheKey);
            } catch (deleteError) {
                console.warn(
                    '[bootstrap] failed to delete invalid bootstrap-lite cache:',
                    deleteError
                );
            }
        }

        if (
            cachedEntry &&
            cachedEntry.data &&
            typeof cachedEntry.data === 'object'
        ) {
            try {
                cachedPreviewData = cachedEntry.data;
                applyBootstrapData(cachedPreviewData);

                if (window.portalStartup) {
                    window.portalStartup.mark('ESSENTIAL_RENDER_START');
                }

                let cachedRenderStatus = 'success';
                try {
                    renderEssentialViews();
                } catch (error) {
                    cachedRenderStatus = 'error';
                    throw error;
                } finally {
                    if (window.portalStartup) {
                        window.portalStartup.mark(
                            'ESSENTIAL_RENDER_END',
                            { status: cachedRenderStatus }
                        );
                    }
                }

                cachedPreviewRendered = true;
                setLoadingBar(
                    '保存済みデータを表示しています。最新データを確認中です。'
                );

                if (window.portalStartup) {
                    window.portalStartup.ready();
                }
            } catch (error) {
                console.warn(
                    '[bootstrap] cached bootstrap-lite preview failed; falling back to network:',
                    error
                );

                cachedPreviewData = null;
                cachedPreviewRendered = false;

                try {
                    await window.portalRuntimeContext.dbCache.delete(cacheKey);
                } catch (deleteError) {
                    console.warn(
                        '[bootstrap] failed to delete invalid bootstrap-lite cache:',
                        deleteError
                    );
                }

                setLoadingBar('データを読み込んでいます...');
            }
        }
    }

    try {
        const requestOptions = cachedPreviewRendered
            ? { _allowCacheFallback: false }
            : {};

        const data = await requestBootstrapData(cacheKey, requestOptions);

        if (cachedPreviewRendered) {
            try {
                applyBootstrapData(data);
                renderEssentialViews();
                appState.lastEssentialDataLoadedAt = Date.now();
                clearLoadingBar();
                return;
            } catch (error) {
                console.warn(
                    '[bootstrap] latest bootstrap-lite apply/render failed; restoring cached preview:',
                    error
                );

                try {
                    await window.portalRuntimeContext.dbCache.delete(cacheKey);
                } catch (deleteError) {
                    console.warn(
                        '[bootstrap] failed to delete invalid latest bootstrap-lite cache:',
                        deleteError
                    );
                }

                if (cachedPreviewData) {
                    applyBootstrapData(cachedPreviewData);
                    renderEssentialViews();
                    setLoadingBar(
                        '保存済みデータを表示しています。最新データの反映に失敗しました。'
                    );
                    return;
                }

                throw error;
            }
        }

        applyBootstrapData(data);
        clearLoadingBar();

        if (window.portalStartup) {
            window.portalStartup.mark('ESSENTIAL_RENDER_START');
        }

        let renderStatus = 'success';
        try {
            renderEssentialViews();
        } catch (error) {
            renderStatus = 'error';
            throw error;
        } finally {
            if (window.portalStartup) {
                window.portalStartup.mark(
                    'ESSENTIAL_RENDER_END',
                    { status: renderStatus }
                );
            }
        }

        appState.lastEssentialDataLoadedAt = Date.now();
    } catch (error) {
        if (cachedPreviewRendered) {
            console.warn(
                '[bootstrap] latest bootstrap-lite request failed; keeping cached preview:',
                error
            );
            setLoadingBar(
                '保存済みデータを表示しています。最新データの取得に失敗しました。'
            );
            return;
        }

        clearLoadingBar();
        throw error;
    }
}

function renderLoadingPlaceholders() {
    const loadingText = '<p class="text-muted mb-0">読み込み中です...</p>';
    ['memberPerfInfo', 'memberSchedInfo', 'memberAnnounceList', 'memberPaymentInfo'].forEach((id) => {
        const element = $(id);
        if (element && !element.innerHTML.trim()) element.innerHTML = loadingText;
    });
}

const deferredPortalDataFlags = {
    events: false,
    absences: false,
    eventResponses: false,
    dateAdjustments: false,
    dateAdjustmentResponses: false,
    payments: false,
    castings: false,
    pieceInfos: false,
    practiceInstructions: false,
    performanceDayInfos: false,
    albums: false,
    flyerDistributions: false,
    flyerDistributionAssignments: false,
    desiredPieces: false,
    promotions: false,
    venueSettings: false,
    connectionSettings: false,
    authDevices: false,
};

function markDeferredPortalDataLoaded(name) {
    if (Object.prototype.hasOwnProperty.call(deferredPortalDataFlags, name)) {
        deferredPortalDataFlags[name] = true;
    }
}

function isDeferredPortalDataLoaded(name) {
    return Object.prototype.hasOwnProperty.call(deferredPortalDataFlags, name)
        ? deferredPortalDataFlags[name] === true
        : false;
}

async function ensureDeferredTabDataLoaded(tabName) {
    const extraLoads = [];
    const queueExtraLoad = (names) => {
        const requested = names.filter((name) => !isDeferredPortalDataLoaded(name));
        if (requested.length) {
            extraLoads.push(loadExtraData(requested));
        }
    };

    if (tabName === 'event' && !isDeferredPortalDataLoaded('events')) {
        extraLoads.push(loadEvents());
    }
    if (tabName === 'member-event') {
        if (!isDeferredPortalDataLoaded('events')) {
            extraLoads.push(loadEvents());
        }
        queueExtraLoad(['eventResponses']);
    }
    if (tabName === 'member-absence') queueExtraLoad(['absences']);
    if (tabName === 'member-date-adjustment') queueExtraLoad(['dateAdjustments', 'dateAdjustmentResponses']);
    if (tabName === 'member-piece-info') queueExtraLoad(['pieceInfos']);
    if (tabName === 'member-practice-instruction') queueExtraLoad(['practiceInstructions', 'pieceInfos']);
    if (tabName === 'member-performance-day' || tabName === 'performance-day-admin') queueExtraLoad(['performanceDayInfos']);
    if (tabName === 'member-casting' || tabName === 'casting-admin') queueExtraLoad(['castings']);
    if (tabName === 'member-album') queueExtraLoad(['albums']);
    if (tabName === 'member-flyer-distribution') queueExtraLoad(['flyerDistributions', 'flyerDistributionAssignments']);
    if (tabName === 'flyer-distribution-admin') queueExtraLoad(['flyerDistributions']);
    if (tabName === 'payment-admin' || tabName === 'payment-setting') queueExtraLoad(['payments']);
    if (tabName === 'member-desired-piece') queueExtraLoad(['desiredPieces']);
    if (tabName === 'member-promotion') queueExtraLoad(['promotions']);
    if (tabName === 'venue-admin') queueExtraLoad(['venueSettings']);
    if (tabName === 'system-connection') queueExtraLoad(['connectionSettings']);
    if (tabName === 'system-auth' && !isDeferredPortalDataLoaded('authDevices')) {
        extraLoads.push(loadAuthManagement());
    }

    if (extraLoads.length) {
        await Promise.all(extraLoads);
    }
}

async function reloadPortalForRevision(latestRevision) {
    const reloadUrl = new URL(window.location.href);
    reloadUrl.searchParams.set('_portal_revision', latestRevision);
    window.location.replace(reloadUrl.toString());
}

function loadedPortalRevision() {
    try {
        return String(
            sessionStorage.getItem('portalLoadedCloudRunRevision') || ''
        ).trim();
    } catch {
        return '';
    }
}

async function refreshPortalWithRevisionCheck() {
    if (appState.portalRevisionRefreshInProgress) {
        return appState.portalRevisionRefreshInProgress;
    }

    appState.portalRevisionRefreshInProgress = (async () => {
        try {
            const revisionUrl = `/api/revision?_=${Date.now()}`;
            const revisionData = await requestJson(revisionUrl, { cache: 'no-store' });
            const latestRevision = String(revisionData.cloudRunRevision || '').trim();
            const loadedRevision = loadedPortalRevision()
                || String(appState.cloudRunRevision || '').trim();

            if (loadedRevision && latestRevision && loadedRevision !== latestRevision) {
                await reloadPortalForRevision(latestRevision);
                return;
            }

            if (latestRevision) {
                appState.cloudRunRevision = latestRevision;
                try {
                    sessionStorage.setItem(
                        'portalLoadedCloudRunRevision',
                        latestRevision
                    );
                } catch {
                    // Continue with the normal refresh when storage is unavailable.
                }
            }
        } catch (error) {
            console.warn('Portal revision check failed', error);
        }

        return refreshPortalData();
    })();

    try {
        return await appState.portalRevisionRefreshInProgress;
    } finally {
        appState.portalRevisionRefreshInProgress = null;
    }
}

async function refreshPortalData(options = {}) {
    const includeBackground = options.includeBackground !== false;
    if (appState.portalRefreshInProgress) return appState.portalRefreshInProgress;
    appState.portalRefreshInProgress = (async () => {
        setLoadingBar('更新中...');
        try {
            await loadEssentialData();
            appState.essentialDataLoaded = true;
            if (includeBackground) {
                // Explicit refreshes should revalidate the broader bootstrap payload too.
                appState.dataLoaded = false;
                loadFullDataInBackground();
            }
        } catch (error) {
            console.warn('Portal refresh failed', error);
            if (typeof showAlert === 'function') {
                showAlert(error.message || '更新に失敗しました', 'danger');
            }
        }
    })();
    try {
        return await appState.portalRefreshInProgress;
    } finally {
        appState.portalRefreshInProgress = null;
        clearLoadingBar();
    }
}

function renderEssentialViews() {
    // 依存描画の連鎖を一時停止し、基本ビューをまとめて描画してから
    // 団員向け派生ビューを最後に再描画することで無駄な再計算を抑える。
    appState.suppressDerivedRender = true;
    renderPerformances();
    renderUploadPerformanceOptions();
    renderSchedules();
    renderAnnouncements();
    renderEvents();
    renderMembers();
    renderPaymentAdmin();
    renderVenueManagement();
    renderOrgManagement();
    renderSnsManagement();
    appState.suppressDerivedRender = false;
    renderMemberPerformances();
    renderMemberSchedules();
    renderMemberExtraViews();
    renderPartManagement();
    renderSchedulePerformanceOptions();
    updateSchedulePieceOptions();
    renderPortalHome();
}

function loadFullDataInBackground() {
    if (appState.dataLoaded || appState.fullDataLoading) return;
    appState.fullDataLoading = true;
    const start = async () => {
        setLoadingBar('全データを取得中...');
        try {
            await loadAll({ includeHeavyLists: false });
            appState.dataLoaded = true;
            renderBackgroundViews({ includeHeavyLists: false });
        } catch (error) {
            console.warn('Background data load failed', error);
        } finally {
            appState.fullDataLoading = false;
            clearLoadingBar();
        }
    };
    // 初回メニュー描画・操作を優先するため、重めの追加取得は少し後ろへ回す。
    if ('requestIdleCallback' in window) {
        window.requestIdleCallback(start, { timeout: 3000 });
    } else {
        window.setTimeout(start, 1500);
    }
}

async function loadAll(options = {}) {
    const includeHeavyLists = options.includeHeavyLists !== false;
    let data;
    try {
        data = await requestBootstrapData(includeHeavyLists ? '/api/bootstrap' : '/api/bootstrap-core');
    } catch {
        data = await legacyBootstrapData(includeHeavyLists);
    }
    applyBootstrapData(data);
    renderInitialViews({ includeHeavyLists });
}

async function requestBootstrapData(url, options = {}) {
    if (typeof request === 'function') return request(url, options);
    return requestJson(url, options);
}

async function requestJson(url, options = {}) {
    const response = await fetch(url, options);
    if (!response.ok) throw new Error(`Request failed: ${response.status}`);
    return response.json();
}

async function legacyBootstrapData(includeHeavyLists = true) {
    const [
        performances,
        schedules,
        announcements,
        events,
        members,
        recordings,
        absences,
        eventResponses,
        dateAdjustments,
        dateAdjustmentResponses,
        sheetLibrary,
        payments,
        castings,
        pieceInfos,
        practiceInstructions,
        performanceDayInfos,
        desiredPieces,
        promotions,
        albums,
        partSettings,
        venueSettings,
        flyerDistributions,
        flyerDistributionAssignments,
        orgSettings,
        snsSettings,
        connectionSettings,
        sheets,
        authDevices
    ] = await Promise.all([
        request('/api/performances'),
        request('/api/schedules'),
        request('/api/announcements'),
        request('/api/events'),
        request('/api/members'),
        includeHeavyLists ? request('/api/recordings') : Promise.resolve({ files: appState.recordings || [] }),
        request('/api/extra/absences'),
        request('/api/extra/event_responses'),
        request('/api/extra/date_adjustments'),
        request('/api/extra/date_adjustment_responses'),
        request('/api/extra/sheet_library'),
        request('/api/extra/payments'),
        request('/api/extra/castings'),
        request('/api/extra/piece_infos'),
        request('/api/extra/practice_instructions'),
        request('/api/extra/performance_day_infos'),
        request('/api/extra/desired_pieces'),
        request('/api/extra/promotions'),
        request('/api/extra/albums'),
        request('/api/extra/part_settings'),
        request('/api/extra/venue_settings'),
        request('/api/extra/flyer_distributions'),
        request('/api/extra/flyer_distribution_assignments'),
        request('/api/extra/org_settings'),
        request('/api/extra/sns_settings'),
        request('/api/extra/connection_settings'),
        includeHeavyLists ? request('/api/sheets') : Promise.resolve({ files: appState.sheetLibrary || [] }),
        request('/api/auth/devices')
    ]);
    return {
        performances,
        schedules,
        announcements,
        events,
        members,
        recordings,
        extras: {
            absences,
            event_responses: eventResponses,
            date_adjustments: dateAdjustments,
            date_adjustment_responses: dateAdjustmentResponses,
            sheet_library: sheetLibrary,
            payments,
            castings,
            piece_infos: pieceInfos,
            practice_instructions: practiceInstructions,
            performance_day_infos: performanceDayInfos,
            promotions,
            albums,
            part_settings: partSettings,
            venue_settings: venueSettings,
            flyer_distributions: flyerDistributions,
            flyer_distribution_assignments: flyerDistributionAssignments,
            org_settings: orgSettings,
            sns_settings: snsSettings,
            connection_settings: connectionSettings,
            desired_pieces: desiredPieces
        },
        auth_devices: authDevices,
        sheets
    };
}

// backend の bootstrap 系 API が返す複合レスポンスを
// フロントの単一状態ストアへ正規化して流し込む。

function applyBootstrapData(data) {
    const extras = data.extras || {};
    const collectionOrCurrent = (name) => (
        Object.prototype.hasOwnProperty.call(data, name)
            ? (data[name] || [])
            : (appState[name] || [])
    );
    const extraOrCurrent = (extraName, stateName) => (
        Object.prototype.hasOwnProperty.call(extras, extraName)
            ? (extras[extraName] || [])
            : (appState[stateName] || [])
    );
    Object.assign(appState, {
        performances: collectionOrCurrent('performances'),
        schedules: collectionOrCurrent('schedules'),
        announcements: collectionOrCurrent('announcements'),
        events: collectionOrCurrent('events'),
        members: normalizeMemberSummaryCollection(collectionOrCurrent('members')),
        recordings: data.recordings?.files || appState.recordings || [],
        absences: extraOrCurrent('absences', 'absences'),
        eventResponses: extraOrCurrent('event_responses', 'eventResponses'),
        dateAdjustments: extraOrCurrent('date_adjustments', 'dateAdjustments'),
        dateAdjustmentResponses: extraOrCurrent('date_adjustment_responses', 'dateAdjustmentResponses'),
        sheetLibrary: data.sheets?.files || extras.sheet_library || appState.sheetLibrary || [],
        payments: extraOrCurrent('payments', 'payments'),
        castings: extraOrCurrent('castings', 'castings'),
        pieceInfos: extraOrCurrent('piece_infos', 'pieceInfos'),
        practiceInstructions: extraOrCurrent('practice_instructions', 'practiceInstructions'),
        performanceDayInfos: extraOrCurrent('performance_day_infos', 'performanceDayInfos'),
        desiredPieces: extraOrCurrent('desired_pieces', 'desiredPieces'),
        promotions: extraOrCurrent('promotions', 'promotions'),
        albums: extraOrCurrent('albums', 'albums'),
        partSettings: extraOrCurrent('part_settings', 'partSettings'),
        venueSettings: extraOrCurrent('venue_settings', 'venueSettings'),
        flyerDistributions: extraOrCurrent('flyer_distributions', 'flyerDistributions'),
        flyerDistributionAssignments: extraOrCurrent('flyer_distribution_assignments', 'flyerDistributionAssignments'),
        orgSettings: extraOrCurrent('org_settings', 'orgSettings'),
        snsSettings: extraOrCurrent('sns_settings', 'snsSettings'),
        connectionSettings: extraOrCurrent('connection_settings', 'connectionSettings'),
        authDevices: Object.prototype.hasOwnProperty.call(data, 'auth_devices') ? (data.auth_devices || []) : (appState.authDevices || []),
        cloudRunRevision: appState.cloudRunRevision || data.cloudRunRevision || ''
    });
    refreshPartSelectOptions();
    refreshVenueOptions();
    applyOrgSettings();
    updateCloudRunRevision();
    if (data.recordings) appState.recordingsLoaded = true;
    if (data.sheets) appState.sheetsLoaded = true;
    updateManagerNavigationVisibility();
}

async function loadPerformances() {
    appState.performances = await request('/api/performances');
    renderUploadPerformanceOptions();
    renderPerformances();
    renderSheetAdmin();
    renderPaymentAdmin();
}

async function loadSchedules() {
    appState.schedules = await request('/api/schedules');
    renderSchedules();
}

async function loadAnnouncements() {
    appState.announcements = await request('/api/announcements');
    renderAnnouncements();
}

async function loadEvents() {
    appState.events = await request('/api/events');
    markDeferredPortalDataLoaded('events');
    renderEvents();
}

async function loadMembers() {
    appState.members = normalizeMemberSummaryCollection(await request('/api/members'));
    renderMembers();
    renderPaymentAdmin();
}

function renderInitialViews(options = {}) {
    const includeHeavyLists = options.includeHeavyLists !== false;
    appState.suppressDerivedRender = true;
    renderPerformances();
    renderUploadPerformanceOptions();
    renderSchedules();
    renderAnnouncements();
    renderEvents();
    renderMembers();
    if (includeHeavyLists) void ensureRecordingsFeatureLoaded().then(renderRecordings);
    if (includeHeavyLists) renderSheetAdmin();
    renderPaymentAdmin();
    renderVenueManagement();
    renderCastingAdmin();
    renderPracticeInstructionAdmin();
    renderPerformanceDayInfoAdmin();
    renderOrgManagement();
    renderSnsManagement();
    renderConnectionSettingsManagement();
    appState.suppressDerivedRender = false;
    renderMemberPerformances();
    renderMemberSchedules();
    renderMemberExtraViews({ includeHeavyLists });
    renderAuthDevices();
    renderPartManagement();
    renderSchedulePerformanceOptions();
    updateSchedulePieceOptions();
    renderPortalHome();
}

function renderBackgroundViews(options = {}) {
    const includeHeavyLists = options.includeHeavyLists !== false;
    renderSchedules();
    renderEvents();
    renderMembers();
    renderMemberExtraViews({ includeHeavyLists });
    renderSheetAdmin();
    renderCastingAdmin();
    renderPracticeInstructionAdmin();
    renderPerformanceDayInfoAdmin();
    renderAuthDevices();
    renderSchedulePerformanceOptions();
    updateSchedulePieceOptions();
    renderPortalHome();
}

function normalizeMemberSummaryCollection(members) {
    return (members || []).map((member) => ({
        id: member.id ?? '',
        name: member.name || '',
        last_name: member.last_name || '',
        first_name: member.first_name || '',
        maiden_name: member.maiden_name || '',
        last_name_kana: member.last_name_kana || '',
        first_name_kana: member.first_name_kana || '',
        part: member.part || '',
        photo_url: member.photo_url || '',
        password_set: Boolean(member.password_set),
        permission: member.permission || '一般',
        joined_at: member.joined_at || '',
        system_access_until: member.system_access_until || '',
    }));
}

// loadRecordings moved to feature module.

// ensureRecordingsLoaded moved to feature module.

async function loadAuthManagement() {
    const devices = await request('/api/auth/devices');
    appState.authDevices = devices || [];
    markDeferredPortalDataLoaded('authDevices');
    renderAuthDevices();
}

async function loadExtraData(collectionNames = null) {
    const allRequestSpecs = [
        ['absences', '/api/extra/absences'],
        ['eventResponses', '/api/extra/event_responses'],
        ['dateAdjustments', '/api/extra/date_adjustments'],
        ['dateAdjustmentResponses', '/api/extra/date_adjustment_responses'],
        ['sheets', '/api/sheets'],
        ['payments', '/api/extra/payments'],
        ['castings', '/api/extra/castings'],
        ['pieceInfos', '/api/extra/piece_infos'],
        ['practiceInstructions', '/api/extra/practice_instructions'],
        ['performanceDayInfos', '/api/extra/performance_day_infos'],
        ['desiredPieces', '/api/extra/desired_pieces'],
        ['promotions', '/api/extra/promotions'],
        ['albums', '/api/extra/albums'],
        ['partSettings', '/api/extra/part_settings'],
        ['venueSettings', '/api/extra/venue_settings'],
        ['flyerDistributions', '/api/extra/flyer_distributions'],
        ['flyerDistributionAssignments', '/api/extra/flyer_distribution_assignments'],
        ['orgSettings', '/api/extra/org_settings'],
        ['snsSettings', '/api/extra/sns_settings'],
        ['connectionSettings', '/api/extra/connection_settings']
    ];

    const knownNames = new Set(
        allRequestSpecs.map(([name]) => name)
    );

    const requestedNames = collectionNames == null
        ? null
        : [...new Set(collectionNames)];

    if (
        requestedNames !== null
        && !Array.isArray(collectionNames)
    ) {
        throw new TypeError(
            'loadExtraData collectionNames must be an array'
        );
    }

    const unknownNames = requestedNames === null
        ? []
        : requestedNames.filter(
            (name) => !knownNames.has(name)
        );

    if (unknownNames.length) {
        throw new Error(
            `Unknown extra data collections: ${unknownNames.join(', ')}`
        );
    }

    const selectedSpecs = requestedNames === null
        ? allRequestSpecs
        : allRequestSpecs.filter(
            ([name]) => requestedNames.includes(name)
        );

    const requestSpecs = selectedSpecs.map(
        ([name, url]) => [name, request(url)]
    );

    const settled = await Promise.allSettled(
        requestSpecs.map(([, promise]) => promise)
    );

    const resultMap = new Map();
    const failed = [];

    settled.forEach((item, index) => {
        const key = requestSpecs[index][0];

        if (item.status === 'fulfilled') {
            resultMap.set(key, item.value);
        } else {
            failed.push(key);
        }
    });

    if (failed.length) {
        showAlert(
            `一部データの読込に失敗しました: ${failed.join(', ')}`,
            'warning'
        );
    }

    const stateTargets = {
        absences: 'absences',
        eventResponses: 'eventResponses',
        dateAdjustments: 'dateAdjustments',
        dateAdjustmentResponses: 'dateAdjustmentResponses',
        payments: 'payments',
        castings: 'castings',
        pieceInfos: 'pieceInfos',
        practiceInstructions: 'practiceInstructions',
        performanceDayInfos: 'performanceDayInfos',
        desiredPieces: 'desiredPieces',
        promotions: 'promotions',
        albums: 'albums',
        partSettings: 'partSettings',
        venueSettings: 'venueSettings',
        flyerDistributions: 'flyerDistributions',
        flyerDistributionAssignments: 'flyerDistributionAssignments',
        orgSettings: 'orgSettings',
        snsSettings: 'snsSettings',
        connectionSettings: 'connectionSettings'
    };

    resultMap.forEach((value, key) => {
        if (key === 'sheets') {
            appState.sheetLibrary = value?.files || [];
            return;
        }

        const stateKey = stateTargets[key];
        if (stateKey) {
            appState[stateKey] = value || [];
            markDeferredPortalDataLoaded(stateKey);
        }
    });

    refreshPartSelectOptions();
    refreshVenueOptions();
    applyOrgSettings();
    renderMemberExtraViews();
    renderSheetAdmin();
    renderPaymentAdmin();
    renderPartManagement();
    renderVenueManagement();
    renderFlyerDistributionManagement();
    renderCastingAdmin();
    renderPracticeInstructionAdmin();
    renderPerformanceDayInfoAdmin();
    renderOrgManagement();
    renderSnsManagement();
    renderConnectionSettingsManagement();
}


async function saveExtra(name, payload) {
    return request(`/api/extra/${name}`, jsonOptions('POST', payload));
}

// async function savePerformance() moved to modules/performances.js.

// saveSchedule moved to feature module.

// selectSchedule moved to feature module.

// deleteSchedule moved to feature module.

// clearScheduleForm moved to feature module.

// selectedSchedulePerformance moved to feature module.

// renderSchedulePerformanceOptions moved to feature module.

// schedulePieceValuesFromText moved to feature module.

// selectedSchedulePiecesValue moved to feature module.

// updateSchedulePieceOptions moved to feature module.
