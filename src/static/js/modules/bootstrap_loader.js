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

async function loadEssentialData() {
    setLoadingBar('データを読み込んでいます...');
    let data;
    try {
        data = await requestJson('/api/bootstrap-lite');
    } catch {
        data = await requestJson('/api/bootstrap');
    }
    applyBootstrapData(data);
    clearLoadingBar();
    renderEssentialViews();
}

function renderLoadingPlaceholders() {
    const loadingText = '<p class="text-muted mb-0">読み込み中です...</p>';
    ['memberPerfInfo', 'memberSchedInfo', 'memberAnnounceList', 'memberPaymentInfo'].forEach((id) => {
        const element = $(id);
        if (element && !element.innerHTML.trim()) element.innerHTML = loadingText;
    });
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
    renderFlyerPlacesAdmin();
    renderVenueManagement();
    renderOrgManagement();
    renderSnsManagement();
    appState.suppressDerivedRender = false;
    renderMemberPerformances();
    renderMemberSchedules();
    renderMemberIntros();
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
        data = await requestJson(includeHeavyLists ? '/api/bootstrap' : '/api/bootstrap-core');
    } catch {
        data = await legacyBootstrapData(includeHeavyLists);
    }
    applyBootstrapData(data);
    renderInitialViews({ includeHeavyLists });
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
        flyerPlaces,
        flyerDistributions,
        castings,
        pieceInfos,
        practiceInstructions,
        performanceDayInfos,
        desiredPieces,
        promotions,
        albums,
        partSettings,
        venueSettings,
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
        request('/api/extra/flyer_places'),
        request('/api/extra/flyer_distributions'),
        request('/api/extra/castings'),
        request('/api/extra/piece_infos'),
        request('/api/extra/practice_instructions'),
        request('/api/extra/performance_day_infos'),
        request('/api/extra/desired_pieces'),
        request('/api/extra/promotions'),
        request('/api/extra/albums'),
        request('/api/extra/part_settings'),
        request('/api/extra/venue_settings'),
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
            flyer_places: flyerPlaces,
            flyer_distributions: flyerDistributions,
            castings,
            piece_infos: pieceInfos,
            practice_instructions: practiceInstructions,
            performance_day_infos: performanceDayInfos,
            promotions,
            albums,
            part_settings: partSettings,
            venue_settings: venueSettings,
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
    Object.assign(appState, {
        performances: collectionOrCurrent('performances'),
        schedules: collectionOrCurrent('schedules'),
        announcements: collectionOrCurrent('announcements'),
        events: collectionOrCurrent('events'),
        members: collectionOrCurrent('members'),
        recordings: data.recordings?.files || appState.recordings || [],
        absences: extras.absences || [],
        eventResponses: extras.event_responses || [],
        dateAdjustments: extras.date_adjustments || [],
        dateAdjustmentResponses: extras.date_adjustment_responses || [],
        sheetLibrary: data.sheets?.files || extras.sheet_library || appState.sheetLibrary || [],
        payments: extras.payments || [],
        flyerPlaces: extras.flyer_places || [],
        castings: extras.castings || [],
        pieceInfos: extras.piece_infos || [],
        practiceInstructions: extras.practice_instructions || [],
        performanceDayInfos: extras.performance_day_infos || [],
        desiredPieces: extras.desired_pieces || [],
        promotions: extras.promotions || [],
        albums: extras.albums || [],
        partSettings: extras.part_settings || [],
        venueSettings: extras.venue_settings || [],
        orgSettings: extras.org_settings || [],
        snsSettings: extras.sns_settings || [],
        connectionSettings: extras.connection_settings || [],
        authDevices: data.auth_devices || [],
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
    renderEvents();
}

async function loadMembers() {
    appState.members = await request('/api/members');
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
    if (includeHeavyLists) renderRecordings();
    if (includeHeavyLists) renderSheetAdmin();
    renderPaymentAdmin();
    renderFlyerPlacesAdmin();
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
    renderMemberIntros();
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
    renderPaymentAdmin();
    renderFlyerPlacesAdmin();
    renderCastingAdmin();
    renderPracticeInstructionAdmin();
    renderPerformanceDayInfoAdmin();
    renderAuthDevices();
    renderSchedulePerformanceOptions();
    updateSchedulePieceOptions();
    renderPortalHome();
}

// loadRecordings moved to feature module.

// ensureRecordingsLoaded moved to feature module.

async function loadAuthManagement() {
    const devices = await request('/api/auth/devices');
    appState.authDevices = devices || [];
    renderAuthDevices();
}

async function loadExtraData() {
    const requestSpecs = [
        ['absences', request('/api/extra/absences')],
        ['eventResponses', request('/api/extra/event_responses')],
        ['dateAdjustments', request('/api/extra/date_adjustments')],
        ['dateAdjustmentResponses', request('/api/extra/date_adjustment_responses')],
        ['sheets', request('/api/sheets')],
        ['payments', request('/api/extra/payments')],
        ['flyerPlaces', request('/api/extra/flyer_places')],
        ['flyerDistributions', request('/api/extra/flyer_distributions')],
        ['castings', request('/api/extra/castings')],
        ['pieceInfos', request('/api/extra/piece_infos')],
        ['practiceInstructions', request('/api/extra/practice_instructions')],
        ['performanceDayInfos', request('/api/extra/performance_day_infos')],
        ['desiredPieces', request('/api/extra/desired_pieces')],
        ['promotions', request('/api/extra/promotions')],
        ['albums', request('/api/extra/albums')],
        ['partSettings', request('/api/extra/part_settings')],
        ['venueSettings', request('/api/extra/venue_settings')],
        ['orgSettings', request('/api/extra/org_settings')],
        ['snsSettings', request('/api/extra/sns_settings')],
        ['connectionSettings', request('/api/extra/connection_settings')]
    ];
    const settled = await Promise.allSettled(requestSpecs.map(([, promise]) => promise));
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
        showAlert(`一部データの読込に失敗しました: ${failed.join(', ')}`, 'warning');
    }

    const absences = resultMap.get('absences') || appState.absences || [];
    const eventResponses = resultMap.get('eventResponses') || appState.eventResponses || [];
    const dateAdjustments = resultMap.get('dateAdjustments') || appState.dateAdjustments || [];
    const dateAdjustmentResponses = resultMap.get('dateAdjustmentResponses') || appState.dateAdjustmentResponses || [];
    const sheets = resultMap.get('sheets') || { files: appState.sheetLibrary || [] };
    const payments = resultMap.get('payments') || appState.payments || [];
    const flyerPlaces = resultMap.get('flyerPlaces') || appState.flyerPlaces || [];
    const flyerDistributions = resultMap.get('flyerDistributions') || appState.flyerDistributions || [];
    const castings = resultMap.get('castings') || appState.castings || [];
    const pieceInfos = resultMap.get('pieceInfos') || appState.pieceInfos || [];
    const practiceInstructions = resultMap.get('practiceInstructions') || appState.practiceInstructions || [];
    const performanceDayInfos = resultMap.get('performanceDayInfos') || appState.performanceDayInfos || [];
    const desiredPieces = resultMap.get('desiredPieces') || appState.desiredPieces || [];
    const promotions = resultMap.get('promotions') || appState.promotions || [];
    const albums = resultMap.get('albums') || appState.albums || [];
    const partSettings = resultMap.get('partSettings') || appState.partSettings || [];
    const venueSettings = resultMap.get('venueSettings') || appState.venueSettings || [];
    const orgSettings = resultMap.get('orgSettings') || appState.orgSettings || [];
    const snsSettings = resultMap.get('snsSettings') || appState.snsSettings || [];
    const connectionSettings = resultMap.get('connectionSettings') || appState.connectionSettings || [];
    Object.assign(appState, { absences, eventResponses, dateAdjustments, dateAdjustmentResponses, sheetLibrary: sheets.files || [], payments, flyerPlaces, flyerDistributions, castings, pieceInfos, practiceInstructions, performanceDayInfos, desiredPieces, promotions, albums, partSettings, venueSettings, orgSettings, snsSettings, connectionSettings });
    refreshPartSelectOptions();
    refreshVenueOptions();
    applyOrgSettings();
    renderMemberExtraViews();
    renderSheetAdmin();
    renderPaymentAdmin();
    renderFlyerPlacesAdmin();
    renderPartManagement();
    renderVenueManagement();
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
