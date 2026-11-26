// Frontend split: extracted from main.js.
// Loaded after main.js; functions intentionally remain global for legacy handlers.

var appState = window.portalRuntimeContext.appState;
var $ = window.portalRuntimeContext.getById;

if (window.portalStartup && !window.__KANADE_STARTUP_PROGRESS_MARK_WRAPPED__) {
    window.__KANADE_STARTUP_PROGRESS_MARK_WRAPPED__ = true;
    const originalStartupMark = window.portalStartup.mark;
    window.portalStartup.mark = function (name, detail) {
        if (name === 'IDB_START') {
            window.portalStartup.setMessage('端末データを準備しています...');
        } else if (name === 'UI_BIND_START') {
            window.portalStartup.setMessage('画面を準備しています...');
        } else if (name === 'AUTH_START') {
            window.portalStartup.setMessage('認証を確認しています...');
        }
        return originalStartupMark(name, detail);
    };
}

async function loadPartSettingsForLogin(options = {}) {
    try {
        const [partSettings, orgSettings] = await Promise.all([
            request('/api/extra/part_settings', options),
            request('/api/extra/org_settings', options)
        ]);
        appState.partSettings = partSettings;
        appState.orgSettings = orgSettings;
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
        // Already confirmed elsewhere: the save dialog (smartphone, ZIP size)
        // or its own download link (scores/save_dialog.js).
        if (link.dataset.downloadConfirm === 'off') return;
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
function assertPortalAuthTransition(startedTransition) {
    if ((appState.portalAuthTransition || 0) !== startedTransition) {
        const error = new Error('Portal authentication context changed');
        error.portalContextChanged = true;
        throw error;
    }
}

async function loadEssentialData(options = {}) {
    const startedTransition = appState.portalAuthTransition || 0;
    const isRefetch = appState.essentialDataLoaded === true;
    const useCachedPreview = options.useCachedPreview === true;
    const forceRevalidate = options.forceRevalidate === true;
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
        // A previous account's preview must not be applied after authentication changes.
        try {
            assertPortalAuthTransition(startedTransition);
        } catch (error) {
            clearLoadingBar();
            throw error;
        }

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
                if (Object.prototype.hasOwnProperty.call(cachedPreviewData.extras || {}, 'payments')) {
                    allPaymentsHeldAuthContext = null;
                }

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
        const requestOptions = {
            _requestOrigin: options._requestOrigin,
            ...(cachedPreviewRendered ? { _allowCacheFallback: false } : {}),
            ...(forceRevalidate ? { _forceRevalidate: true } : {}),
        };

        const data = await requestBootstrapData(cacheKey, requestOptions);
        assertPortalAuthTransition(startedTransition);

        if (cachedPreviewRendered) {
            try {
                const protectedPayments = applyLatestEssentialBootstrap(data, isRefetch);
                renderEssentialViews();
                appState.lastEssentialDataLoadedAt = Date.now();
                refetchVisibleDeferredData(isRefetch, protectedPayments, options);
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
                    if ((appState.portalAuthTransition || 0) === startedTransition) {
                        console.warn(
                            '[bootstrap] failed to delete invalid latest bootstrap-lite cache:',
                            deleteError
                        );
                    }
                }

                // Deletion can await across logout/account changes; restoring here
                // would bring back the previous member's preview, including payments.
                assertPortalAuthTransition(startedTransition);
                if (cachedPreviewData) {
                    applyBootstrapData(cachedPreviewData);
                    if (Object.prototype.hasOwnProperty.call(cachedPreviewData.extras || {}, 'payments')) {
                        allPaymentsHeldAuthContext = null;
                    }
                    renderEssentialViews();
                    setLoadingBar(
                        '保存済みデータを表示しています。最新データの反映に失敗しました。'
                    );
                    return;
                }

                throw error;
            }
        }

        const protectedPayments = applyLatestEssentialBootstrap(data, isRefetch);
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
        refetchVisibleDeferredData(isRefetch, protectedPayments, options);
    } catch (error) {
        if ((appState.portalAuthTransition || 0) !== startedTransition || error?.portalContextChanged) {
            clearLoadingBar();
            // Requests may throw primitive values; callers still need the context-change marker.
            if (error === null || (typeof error !== 'object' && typeof error !== 'function')) {
                error = new Error(String(error));
            }
            error.portalContextChanged = true;
            throw error;
        }
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
    schedules: false,
    snsSettings: false,
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
    concertRecordVideos: false,
    desiredPieces: false,
    promotions: false,
    venueSettings: false,
    connectionSettings: false,
    authDevices: false,
};

// Advance independently of authentication so pre-refetch loads cannot mark data latest.
let deferredPortalDataGeneration = 0;

function currentDeferredPortalDataGeneration() {
    return deferredPortalDataGeneration;
}
// Keep full payments protected even when their flag is reset and a reload fails
// or is still in flight. Account/permission/session changes invalidate ownership.
let allPaymentsHeldAuthContext = null;
let loadEventsSequence = 0;
let loadSchedulesSequence = 0;
let loadAuthManagementSequence = 0;

function isAllPaymentsHeld() {
    return allPaymentsHeldAuthContext !== null
        && allPaymentsHeldAuthContext === portalExtraAuthContext();
}

// サーバーの personal_payment_list() と同じ判定（member_id を優先し、なければ name）。
// 元の配列は書き換えず、新しい配列を返す。
function personalPaymentsOnly(payments) {
    const list = Array.isArray(payments) ? payments : [];
    const memberId = String(appState.currentUserMemberId || '');
    if (memberId) return list.filter((p) => String(p?.member_id || '') === memberId);
    const name = typeof currentUserMemberName === 'function'
        ? currentUserMemberName()
        : (appState.currentUserName || '');
    if (name) return list.filter((p) => p?.name === name);
    return [];
}

function applyLatestEssentialBootstrap(data, isRefetch) {
    // Only protect the full list for the same auth identity, checked after await.
    // Never mutate a response/cache object containing member-only payments.
    const protect = isRefetch && isAllPaymentsHeld();
    if (protect) {
        const extras = { ...(data.extras || {}) };
        delete extras.payments;
        applyBootstrapData({ ...data, extras });
    } else {
        applyBootstrapData(data);
        if (Object.prototype.hasOwnProperty.call(data.extras || {}, 'payments')) {
            allPaymentsHeldAuthContext = null;
        }
    }
    return protect;
}

function refetchVisibleDeferredData(isRefetch, protectedPayments, options) {
    resetDeferredPortalDataFlags();
    // Startup/login resets flags only; deferred requests must not precede navigation.
    if (!isRefetch) return;
    // Bypass the events 10-second cache and sharing with older ordinary GETs.
    const picked = { _forceRevalidate: true };
    if (options._requestOrigin !== undefined) picked._requestOrigin = options._requestOrigin;
    const tabName = appState.currentPortalTab?.tabName;
    // Promise callbacks also contain synchronous failures without failing bootstrap.
    if (tabName) {
        Promise.resolve().then(() => ensureDeferredTabDataLoaded(tabName, picked))
            .catch(error => console.warn('[bootstrap] deferred tab refetch failed:', error));
    }
    if (protectedPayments) {
        Promise.resolve().then(() => loadExtraData(['payments'], picked))
            .catch(error => console.warn('[bootstrap] payments refetch failed:', error));
    }
}

function pickDeferredRequestOptions(options) {
    const picked = {};
    for (const key of ['_requestOrigin', '_forceRevalidate']) {
        if (options[key] !== undefined) picked[key] = options[key];
    }
    return picked;
}

function markDeferredPortalDataLoaded(name) {
    if (Object.prototype.hasOwnProperty.call(deferredPortalDataFlags, name)) {
        deferredPortalDataFlags[name] = true;
    }
}

function unmarkDeferredPortalDataLoaded(name) {
    if (Object.prototype.hasOwnProperty.call(deferredPortalDataFlags, name)) {
        deferredPortalDataFlags[name] = false;
    }
}

function isDeferredPortalDataLoaded(name) {
    return Object.prototype.hasOwnProperty.call(deferredPortalDataFlags, name)
        ? deferredPortalDataFlags[name] === true
        : false;
}

function resetDeferredPortalDataFlags() {
    Object.keys(deferredPortalDataFlags).forEach(name => { deferredPortalDataFlags[name] = false; });
    deferredPortalDataGeneration += 1;
}

function resetPortalDataForAccountChange() {
    // Replace account-specific arrays without mutating cached/shared data.
    // Keep common collections and login-screen part/organization settings.
    allPaymentsHeldAuthContext = null;
    resetDeferredPortalDataFlags();
    appState.payments = [];
    appState.connectionSettings = [];
    appState.authDevices = [];
    appState.essentialDataLoaded = false;
    appState.dataLoaded = false;
    appState.lastEssentialDataLoadedAt = 0;
    ['memberPerfInfo', 'memberSchedInfo', 'memberAnnounceList', 'memberPaymentInfo'].forEach((id) => {
        const element = $(id);
        if (element) element.innerHTML = '';
    });
    if (typeof renderMenuGroups === 'function') renderMenuGroups($('portalHomeMenu'));
    if (typeof renderPortalDrawerMenu === 'function') renderPortalDrawerMenu();
}

async function ensureDeferredTabDataLoaded(tabName, options = {}) {
    const picked = pickDeferredRequestOptions(options);
    const hasOptions = Object.keys(picked).length > 0;
    const extraLoads = [];
    const queueExtraLoad = (names) => {
        const requested = names.filter((name) => !isDeferredPortalDataLoaded(name));
        if (requested.length) {
            extraLoads.push(hasOptions ? loadExtraData(requested, picked) : loadExtraData(requested));
        }
    };

    if (tabName === 'event' && !isDeferredPortalDataLoaded('events')) {
        extraLoads.push(hasOptions ? loadEvents(picked) : loadEvents());
    }
    if (tabName === 'member-event') {
        if (!isDeferredPortalDataLoaded('events')) {
            extraLoads.push(hasOptions ? loadEvents(picked) : loadEvents());
        }
        queueExtraLoad(['eventResponses']);
    }
    if (tabName === 'member-schedule' || tabName === 'member-absence') queueExtraLoad(['absences']);
    if (['member-schedule', 'member-absence', 'schedule'].includes(tabName)
        && !isDeferredPortalDataLoaded('schedules')) {
        extraLoads.push(loadSchedules(picked));
    }
    if (tabName === 'member-sns' || tabName === 'system-sns') queueExtraLoad(['snsSettings']);
    if (tabName === 'member-date-adjustment') queueExtraLoad(['dateAdjustments', 'dateAdjustmentResponses']);
    if (tabName === 'member-piece-info') queueExtraLoad(['pieceInfos']);
    if (tabName === 'member-practice-instruction') queueExtraLoad(['practiceInstructions', 'pieceInfos']);
    if (tabName === 'member-performance-day' || tabName === 'performance-day-admin') queueExtraLoad(['performanceDayInfos']);
    if (tabName === 'member-casting' || tabName === 'casting-admin') queueExtraLoad(['castings']);
    if (tabName === 'member-album') queueExtraLoad(['albums']);
    if (tabName === 'member-flyer-distribution') queueExtraLoad(['flyerDistributions', 'flyerDistributionAssignments']);
    if (tabName === 'member-concert-record' || tabName === 'concert-record-admin') queueExtraLoad(['concertRecordVideos']);
    if (tabName === 'flyer-distribution-admin') queueExtraLoad(['flyerDistributions']);
    // Payment status (dues months and concert fees) is judged from castings:
    // without them every performance looks non-chargeable and saved payments
    // seem not to be reflected until the casting tab happens to be opened.
    if (tabName === 'payment-admin' || tabName === 'payment-setting') queueExtraLoad(['payments', 'castings']);
    if (tabName === 'member-payment') queueExtraLoad(['castings']);
    if (tabName === 'member-desired-piece') queueExtraLoad(['desiredPieces']);
    if (tabName === 'member-promotion') queueExtraLoad(['promotions']);
    // The performance / schedule registration forms build their venue
    // dropdowns from venueSettings, which is not part of the lite bootstrap.
    // Load it here so registered venues appear without opening venue-admin first.
    if (tabName === 'venue-admin' || tabName === 'performance' || tabName === 'schedule') {
        queueExtraLoad(['venueSettings']);
    }
    if (tabName === 'system-connection') queueExtraLoad(['connectionSettings']);
    if (tabName === 'system-auth' && !isDeferredPortalDataLoaded('authDevices')) {
        extraLoads.push(hasOptions ? loadAuthManagement(picked) : loadAuthManagement());
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
            await loadEssentialData({ forceRevalidate: true });
            appState.essentialDataLoaded = true;
            if (includeBackground) {
                // Explicit refreshes should revalidate the broader bootstrap payload too.
                appState.dataLoaded = false;
                loadFullDataInBackground();
            }
        } catch (error) {
            if (error && error.portalContextChanged) return;
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
    if (appState.dataLoaded || appState.fullDataLoading || appState.backgroundLoadScheduled) return;
    appState.backgroundLoadScheduled = true;
    appState.fullDataLoading = true;
    const start = async () => {
        appState.backgroundLoadScheduled = false;
        setLoadingBar('全データを取得中...');
        try {
            await loadAll({ includeHeavyLists: false, _requestOrigin: 'automatic' });
            appState.dataLoaded = true;
            renderBackgroundViews({ includeHeavyLists: false });
        } catch (error) {
            console.warn('Background data load failed', error);
        } finally {
            appState.fullDataLoading = false;
            clearLoadingBar();
        }
    };
    const scheduleStart = () => {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
            const onVisible = () => {
                document.removeEventListener('visibilitychange', onVisible);
                if (document.visibilityState !== 'hidden') {
                    start();
                }
            };
            document.addEventListener('visibilitychange', onVisible);
            return;
        }
        start();
    };
    // 初回メニュー描画・操作を優先するため、重めの追加取得は少し後ろへ回す。
    if ('requestIdleCallback' in window) {
        window.requestIdleCallback(scheduleStart, { timeout: 1200 });
    } else {
        window.setTimeout(scheduleStart, 400);
    }
}

async function loadAll(options = {}) {
    const includeHeavyLists = options.includeHeavyLists !== false;
    const data = await requestBootstrapData(
        includeHeavyLists ? '/api/bootstrap' : '/api/bootstrap-core',
        { _requestOrigin: options._requestOrigin }
    );
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
        concertRecordVideos: extraOrCurrent('concert_record_videos', 'concertRecordVideos'),
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
    appState.bootstrapDataVersion = (Number(appState.bootstrapDataVersion || 0) + 1);
    if (data.recordings) appState.recordingsLoaded = true;
    if (data.sheets) appState.sheetsLoaded = true;
    updateManagerNavigationVisibility();
    // Older cached payloads omit the field; keep the latest known settings.
    if (typeof applyPortalMenuVisibility === 'function' && data.menu_visibility) {
        applyPortalMenuVisibility(data.menu_visibility);
    }
}

async function loadPerformances() {
    appState.performances = await request('/api/performances');
    renderUploadPerformanceOptions();
    renderPerformances();
    if (typeof renderSheetAdmin === 'function') renderSheetAdmin();
    renderPaymentAdmin();
}

async function loadSchedules(options = {}) {
    // Save-triggered reloads own a newer sequence; old requests must not undo them.
    const seq = ++loadSchedulesSequence;
    const generation = deferredPortalDataGeneration;
    const picked = pickDeferredRequestOptions(options);
    const handleFailure = arguments.length > 0;
    try {
        const schedules = await (Object.keys(picked).length
            ? request('/api/schedules', picked) : request('/api/schedules'));
        if (seq !== loadSchedulesSequence || generation !== deferredPortalDataGeneration) return false;
        appState.schedules = schedules;
        markDeferredPortalDataLoaded('schedules');
        if (typeof renderSchedules === 'function') renderSchedules();
        if (typeof renderMemberSchedules === 'function') renderMemberSchedules();
        if (typeof renderAbsenceView === 'function') renderAbsenceView();
        return true;
    } catch (error) {
        if (!handleFailure) throw error;
        if (!error?.portalRetryWait) {
            showAlert('一部データの読込に失敗しました: schedules', 'warning');
        }
        return false;
    }
}

async function loadAnnouncements() {
    appState.announcements = await request('/api/announcements');
    renderAnnouncements();
}

async function loadEvents(options = {}) {
    // Events normally use a 10-second cache. Refetch options bypass it; sequence
    // ownership prevents a slower save-triggered reload overwriting a newer call.
    const seq = ++loadEventsSequence;
    const generation = deferredPortalDataGeneration;
    const picked = pickDeferredRequestOptions(options);
    const events = await (Object.keys(picked).length
        ? request('/api/events', picked) : request('/api/events'));
    if (seq !== loadEventsSequence) return;
    appState.events = events;
    if (generation === deferredPortalDataGeneration) markDeferredPortalDataLoaded('events');
    renderEvents();
}

async function loadMembers() {
    appState.members = normalizeMemberSummaryCollection(await request('/api/members'));
    renderMembers();
    renderPaymentAdmin();
}

function renderInitialViews(options = {}) {
    const includeHeavyLists = options.includeHeavyLists !== false;
    const renderVersionKey = `${appState.bootstrapDataVersion}:${includeHeavyLists ? '1' : '0'}`;
    appState.suppressDerivedRender = true;
    renderPerformances();
    renderUploadPerformanceOptions();
    renderSchedules();
    renderAnnouncements();
    renderEvents();
    renderMembers();
    if (includeHeavyLists && typeof ensureRecordingsFeatureLoaded === 'function') void ensureRecordingsFeatureLoaded().then(renderRecordings);
    if (includeHeavyLists && typeof renderSheetAdmin === 'function') renderSheetAdmin();
    renderPaymentAdmin();
    renderVenueManagement();
    if (typeof renderCastingAdmin === 'function') renderCastingAdmin();
    if (typeof renderPracticeInstructionAdmin === 'function') renderPracticeInstructionAdmin();
    if (typeof renderPerformanceDayInfoAdmin === 'function') renderPerformanceDayInfoAdmin();
    renderOrgManagement();
    renderSnsManagement();
    if (typeof renderConnectionSettingsManagement === 'function') renderConnectionSettingsManagement();
    appState.suppressDerivedRender = false;
    renderMemberPerformances();
    renderMemberSchedules();
    renderMemberExtraViews({ includeHeavyLists });
    renderAuthDevices();
    renderPartManagement();
    renderSchedulePerformanceOptions();
    updateSchedulePieceOptions();
    renderPortalHome();
    appState.lastInitialRenderVersionKey = renderVersionKey;
}

function renderBackgroundViews(options = {}) {
    const includeHeavyLists = options.includeHeavyLists !== false;
    const renderVersionKey = `${appState.bootstrapDataVersion}:${includeHeavyLists ? '1' : '0'}`;
    if (appState.lastInitialRenderVersionKey === renderVersionKey || appState.lastBackgroundRenderVersionKey === renderVersionKey) {
        return;
    }
    renderSchedules();
    renderEvents();
    renderMembers();
    renderMemberExtraViews({ includeHeavyLists });
    if (typeof renderSheetAdmin === 'function') renderSheetAdmin();
    if (typeof renderCastingAdmin === 'function') renderCastingAdmin();
    if (typeof renderPracticeInstructionAdmin === 'function') renderPracticeInstructionAdmin();
    if (typeof renderPerformanceDayInfoAdmin === 'function') renderPerformanceDayInfoAdmin();
    renderAuthDevices();
    renderSchedulePerformanceOptions();
    updateSchedulePieceOptions();
    renderPortalHome();
    appState.lastBackgroundRenderVersionKey = renderVersionKey;
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

async function loadAuthManagement(options = {}) {
    // Refetch and save-triggered reloads can overlap, as with events above.
    const seq = ++loadAuthManagementSequence;
    const generation = deferredPortalDataGeneration;
    const picked = pickDeferredRequestOptions(options);
    const devices = await (Object.keys(picked).length
        ? request('/api/auth/devices', picked) : request('/api/auth/devices'));
    if (seq !== loadAuthManagementSequence) return;
    appState.authDevices = devices || [];
    if (generation === deferredPortalDataGeneration) markDeferredPortalDataLoaded('authDevices');
    renderAuthDevices();
}

// HTTP coalescing alone cannot prevent callers of different batches from
// applying the same response twice, or a slow batch from restoring older data.
const portalExtraLoads = new Map();
const portalExtraLatest = new Map();
let portalExtraSequence = 0;
function portalExtraAuthParts() {
    return [typeof portalCacheIdentity === 'function' ? portalCacheIdentity()
        : [appState.currentUserMemberId, appState.portalAuthGeneration],
        appState.portalAuthTransition || 0];
}
// The account part alone: a change here means another user/session, never a retry.
function portalExtraAuthContext() {
    return JSON.stringify(portalExtraAuthParts());
}
function portalExtraContext() {
    return JSON.stringify([...portalExtraAuthParts(), window.portalResponseEpoch || 0, deferredPortalDataGeneration]);
}
// request() links a budget that joined another caller's in-flight GET to the
// budget that GET really spent (sharedBudget). Follow it; the seen set guards
// against a link cycle between repeated joins.
function portalExtraUsedBudget(budget) {
    const seen = new Set();
    while (budget.sharedBudget && !seen.has(budget)) {
        seen.add(budget);
        budget = budget.sharedBudget;
    }
    return budget;
}
// retryContext: the used transient budget of the original load, passed on the
// one retry after a save so request() continues it instead of starting anew.
function beginPortalExtraLoad(name, url, options, retryContext = null) {
    const previous = portalExtraLatest.get(name);
    if (previous?.promise && previous.generation !== deferredPortalDataGeneration) {
        // request() shares GETs with the same URL/force option. Avoid joining an
        // ordinary GET started before bootstrap refetch; preserve caller options.
        options = { ...options, _forceRevalidate: true };
    }
    const context = portalExtraContext();
    const shareable = Object.keys(options).every(key => ['_requestOrigin', '_forceRevalidate'].includes(key));
    const key = JSON.stringify([context, name, options._requestOrigin || 'manual', !!options._forceRevalidate]);
    if (shareable && portalExtraLoads.has(key)) return portalExtraLoads.get(key);
    const entry = { context, authContext: portalExtraAuthContext(), generation: deferredPortalDataGeneration, sequence: ++portalExtraSequence, applied: false, reported: false,
        retryContext: retryContext || { transientRetries: 0, unknown503Retries: 0 } };
    portalExtraLatest.set(name, entry);
    entry.promise = Promise.resolve().then(() => request(url, { ...options, _retryContext: entry.retryContext }))
        .finally(() => {
            if (portalExtraLoads.get(key) === entry) portalExtraLoads.delete(key);
            entry.promise = null; // latest ownership must not retain a completed body
        });
    if (shareable) portalExtraLoads.set(key, entry);
    return entry;
}
function renderAppliedExtraCollections(collections) {
    const changed = new Set(collections);
    const has = (...names) => names.some(name => changed.has(name));
    const parts = has('partSettings');
    if (parts) {
        refreshPartSelectOptions();
        // Avoid a second full member-extra cascade; its affected leaves run below.
        if (typeof renderMembers === 'function') renderMembers({ includeDerived: false });
    }
    if (has('venueSettings')) refreshVenueOptions();
    if (has('orgSettings')) applyOrgSettings();
    renderMemberExtraViews({ collections });
    if ((has('absences') || parts) && typeof renderMemberSchedules === 'function') renderMemberSchedules();
    if (has('sheets') || parts) { if (typeof renderSheetAdmin === 'function') renderSheetAdmin(); }
    if (has('payments', 'castings', 'orgSettings') || parts) renderPaymentAdmin({ preserveForm: true });
    // The payment overdue alert on the shared menus is judged from payments and
    // castings; redraw only the menus (as applyPortalMenuVisibility does).
    if (has('payments', 'castings') && typeof renderMenuGroups === 'function') {
        renderMenuGroups($('portalHomeMenu'));
        if (typeof renderPortalDrawerMenu === 'function') renderPortalDrawerMenu();
    }
    if (parts) renderPartManagement();
    if (has('venueSettings')) renderVenueManagement();
    if (has('flyerDistributions', 'flyerDistributionAssignments') || parts) renderFlyerDistributionManagement();
    if (has('castings') || parts) { if (typeof renderCastingAdmin === 'function') renderCastingAdmin(); }
    if (has('practiceInstructions', 'pieceInfos') && typeof renderPracticeInstructionAdmin === 'function') renderPracticeInstructionAdmin();
    if ((has('performanceDayInfos') || parts) && typeof renderPerformanceDayInfoAdmin === 'function') renderPerformanceDayInfoAdmin();
    if (has('concertRecordVideos') && typeof renderConcertRecordAdminList === 'function') renderConcertRecordAdminList();
    if (has('orgSettings')) renderOrgManagement();
    if (has('snsSettings')) renderSnsManagement();
    if (has('connectionSettings') && typeof renderConnectionSettingsManagement === 'function') renderConnectionSettingsManagement();
}

async function loadExtraData(collectionNames = null, options = {}) {
    return loadExtraDataBatch(collectionNames, options, true);
}

// allowContextRetry: a collection whose first load was discarded only because a
// save advanced the response epoch is fetched again once in the new context, so
// a visible tab does not stay on its empty placeholder. The retry itself passes
// false: a second discard or failure uses the existing warning, never a loop.
async function loadExtraDataBatch(collectionNames, options, allowContextRetry, inheritedRetryContexts = null) {
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
        ['concertRecordVideos', '/api/extra/concert_record_videos'],
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

    const previousPromotionLoadState = appState.promotionLoadState;
    const promotionWaiting = window.portalRetryWaitInfo?.('/api/extra/promotions', options)?.blocked;
    const requestSpecs = selectedSpecs.map(
        ([name, url]) => [name, beginPortalExtraLoad(name, url, options, inheritedRetryContexts?.get(name))]
    );
    if (!promotionWaiting && selectedSpecs.some(([name]) => name === 'promotions')) {
        appState.promotionLoadState = 'loading';
    }

    const settled = await Promise.allSettled(
        requestSpecs.map(([, entry]) => entry.promise)
    );

    const resultMap = new Map();
    const failed = [];
    const contextRetryNames = [];
    const currentContext = portalExtraContext();
    const currentAuthContext = portalExtraAuthContext();

    let paymentsForbiddenPurged = false;
    settled.forEach((item, index) => {
        const [key, entry] = requestSpecs[index];
        if (portalExtraLatest.get(key) !== entry || entry.applied) return;
        // 権限を外された端末に他団員の支払いを残さない。403 以外の失敗
        // （通信エラー・タイムアウト・503 待機・5xx・portalContextChanged）は一時的なものとして全員分を残す。
        // 認証の組が同じなら、保存などで epoch だけ進んだ場合も対象にするため、context の判定より前に置く。
        if (key === 'payments'
            && item.status === 'rejected'
            && item.reason?.status === 403
            && !item.reason?.portalRetryWait
            && entry.authContext === currentAuthContext) {
            allPaymentsHeldAuthContext = null;
            appState.payments = personalPaymentsOnly(appState.payments || []);
            // Reload everyone's payments when payment administration is reopened as admin.
            unmarkDeferredPortalDataLoaded('payments');
            paymentsForbiddenPurged = true;
            // return せず、既存の失敗処理（failed への追加と警告）に進める。
        }
        if (entry.context !== currentContext) {
            // Another account/session, a 503 wait, or a pre-bootstrap-refetch
            // generation: discard; only same-auth unloaded data may retry once.
            if (entry.authContext !== currentAuthContext || item.reason?.portalRetryWait) return;
            const discardedBySave = item.status === 'fulfilled' || item.reason?.portalContextChanged;
            const unloaded = Object.prototype.hasOwnProperty.call(deferredPortalDataFlags, key)
                && !isDeferredPortalDataLoaded(key);
            if (discardedBySave && !unloaded) return; // displayed data stays as it is
            if (discardedBySave && allowContextRetry) { contextRetryNames.push([key, portalExtraUsedBudget(entry.retryContext)]); return; }
            if (!entry.reported) { failed.push(key); entry.reported = true; }
            if (key === 'promotions') appState.promotionLoadState = 'error';
            return;
        }

        if (item.status === 'fulfilled') {
            resultMap.set(key, item.value);
            if (key === 'promotions') appState.promotionLoadState = 'loaded';
        } else {
            // A suppressed retry is neither empty data nor a new failed load.
            // Keep already displayed data and do not mark the collection loaded.
            if (!item.reason?.portalRetryWait && !entry.reported) { failed.push(key); entry.reported = true; }
            if (key === 'promotions') {
                if (!item.reason?.portalRetryWait) appState.promotionLoadState = 'error';
                else if (appState.promotionLoadState === 'loading' && previousPromotionLoadState !== 'loading') {
                    appState.promotionLoadState = previousPromotionLoadState;
                }
            }
        }
    });

    if (settled.length && settled.every((item) => item.status === 'rejected' && item.reason?.portalRetryWait)) {
        return; // Nothing changed: keep the current DOM, input/File and scroll.
    }

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
        concertRecordVideos: 'concertRecordVideos',
        orgSettings: 'orgSettings',
        snsSettings: 'snsSettings',
        connectionSettings: 'connectionSettings'
    };

    resultMap.forEach((value, key) => {
        if (key === 'sheets') {
            appState.sheetLibrary = value?.files || [];
            portalExtraLatest.get(key).applied = true;
            return;
        }

        const stateKey = stateTargets[key];
        if (stateKey) {
            appState[stateKey] = value || [];
            if (key === 'payments') allPaymentsHeldAuthContext = portalExtraLatest.get(key).authContext;
            markDeferredPortalDataLoaded(stateKey);
            portalExtraLatest.get(key).applied = true;
        }
    });

    const renderNames = [...resultMap.keys()];
    if (paymentsForbiddenPurged && !renderNames.includes('payments')) renderNames.push('payments');
    if (renderNames.length) renderAppliedExtraCollections(renderNames);

    // Skip names a newer load has applied meanwhile; an in-flight newer load
    // with the same options is joined by beginPortalExtraLoad, not duplicated.
    // The retry continues each collection's used budget (agreed: two transient
    // re-sends in total per logical load, not two more per attempt).
    const retries = contextRetryNames.filter(([name]) => !isDeferredPortalDataLoaded(name));
    if (retries.length) {
        await loadExtraDataBatch(retries.map(([name]) => name), options, false, new Map(retries));
    }
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
