// Navigation helpers split from modules/navigation.js.
// Keep global names for compatibility with legacy non-module loading.

var appState = window.portalRuntimeContext.appState;
var $ = window.portalRuntimeContext.getById;

const EXTRA_RESTRICTED_MEMBER_TABS = new Set([
    'member-payment',
    'member-event',
    'member-date-adjustment',
    'member-desired-piece'
]);

const ACCESS_LOG_MENU_LABELS = {
    upload: '録音管理',
    performance: '演奏会情報管理',
    'concert-record-admin': '記録管理',
    'performance-day-admin': '本番情報管理',
    schedule: '練習予定管理',
    announcement: 'お知らせ管理',
    event: 'イベント管理',
    member: '団員登録',
    'payment-admin': '支払管理',
    'payment-setting': '支払設定',
    'venue-admin': '会場管理',
    'flyer-distribution-admin': 'チラシ配布管理',
    'casting-admin': '乗り番管理',
    'sheet-admin': '楽譜管理',
    'member-home': 'ポータルメニュー',
    'member-announce': 'お知らせ',
    'member-performance': '演奏会情報',
    'member-flyer-distribution': 'チラシ配布',
    'member-performance-day': '本番情報',
    'member-schedule': '練習予定',
    'member-practice-instruction': '練習指示',
    'member-recording': '録音部屋',
    'member-intro': '団員紹介',
    'member-absence': '出欠確認',
    'member-sheet': '楽譜ライブラリ',
    'member-sheet-viewer': '楽譜表示',
    'member-payment': '支払状況',
    'member-casting': '乗り番表',
    'member-event': 'イベント調整',
    'member-date-adjustment': '日程調整',
    'member-piece-info': '楽曲情報',
    'member-desired-piece': '演奏希望曲',
    'member-promotion': '宣伝',
    'member-manual': 'マニュアル',
    'member-album': 'アルバム',
    'member-concert-record': '演奏会記録',
    'member-sns': 'SNS',
    'announcement-detail': 'お知らせ詳細',
    'system-auth': '認証端末管理',
    'system-permission-management': '権限管理',
    'system-org': '団体情報管理',
    'system-sns': 'SNS情報',
    'system-connection': '接続先情報',
    'system-part': 'パート管理',
    'system-environment': '環境管理',
    'system-readiness': '運用Readyチェック',
    'system-access-log': 'アクセスログ',
    'system-database': 'データベース',
    'system-improvement-suggestion': '改善案管理'
};

function isExtraUser() {
    return appState.currentUserPermission === 'エキストラ';
}

function isExtraRestrictedMemberTab(tabName) {
    return isExtraUser() && EXTRA_RESTRICTED_MEMBER_TABS.has(tabName);
}

function visibleMemberMenuItems(items) {
    return items.filter((item) => item && !isExtraRestrictedMemberTab(item.tab || ''));
}

function accessLogPanelLabel(panelId) {
    if (panelId === 'systemPanel') return 'システム管理';
    if (panelId === 'adminPanel') return '管理者メニュー';
    return '団員メニュー';
}

function toPascalTab(value) {
    const map = {
        upload: 'upload',
        performance: 'performance',
        'concert-record-admin': 'concertRecordAdmin',
        'performance-day-admin': 'performanceDayAdmin',
        schedule: 'schedule',
        announcement: 'announcement',
        event: 'event',
        member: 'member',
        'payment-admin': 'paymentAdmin',
        'payment-setting': 'paymentSetting',
        'venue-admin': 'venueAdmin',
        'flyer-distribution-admin': 'flyerDistributionAdmin',
        'casting-admin': 'castingAdmin',
        'sheet-admin': 'sheetAdmin',
        'member-home': 'memberHome',
        'member-announce': 'memberAnnounce',
        'member-performance': 'memberPerformance',
        'member-flyer-distribution': 'memberFlyerDistribution',
        'member-performance-day': 'memberPerformanceDay',
        'member-schedule': 'memberSchedule',
        'member-practice-instruction': 'memberPracticeInstruction',
        'member-recording': 'memberRecording',
        'member-intro': 'memberIntro',
        'member-absence': 'memberAbsence',
        'member-sheet': 'memberSheet',
        'member-sheet-viewer': 'memberSheetViewer',
        'member-payment': 'memberPayment',
        'member-casting': 'memberCasting',
        'member-event': 'memberEvent',
        'member-date-adjustment': 'memberDateAdjustment',
        'member-piece-info': 'memberPieceInfo',
        'member-desired-piece': 'memberDesiredPiece',
        'member-promotion': 'memberPromotion',
        'member-manual': 'memberManual',
        'member-album': 'memberAlbum',
        'member-concert-record': 'memberConcertRecord',
        'member-sns': 'memberSns',
        'announcement-detail': 'announcementDetail',
        'system-auth': 'systemAuth',
        'system-permission-management': 'systemPermissionManagement',
        'system-org': 'systemOrg',
        'system-sns': 'systemSns',
        'system-connection': 'systemConnection',
        'system-part': 'systemPart',
        'system-environment': 'systemEnvironment',
        'system-readiness': 'systemReadiness',
        'system-access-log': 'systemAccessLog',
        'system-database': 'systemDatabase',
        'system-improvement-suggestion': 'systemImprovementSuggestion',
    };
    return map[value] || value;
}

function recordAccessLog(panelId, tabName) {
    if (!appState.portalAuthVerified) return;
    const deviceId = localStorage.getItem(window.portalRuntimeContext.PORTAL_DEVICE_ID_KEY) || '';
    if (!deviceId) return;
    const payload = {
        panel: accessLogPanelLabel(panelId),
        menu_key: tabName,
        menu_label: ACCESS_LOG_MENU_LABELS[tabName] || tabName,
    };
    try {
        if (typeof fetch !== 'function') {
            return;
        }
        fetchWithTimeout('/api/system/access-logs', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Device-Id': deviceId,
            },
            body: JSON.stringify(payload),
        }, PORTAL_TIMEOUT_MUTATION).catch((error) => console.warn('Access log save failed:', error));
    } catch (error) {
        console.warn('Access log save failed:', error);
    }
}

function setupPortalHome() {
    const memberPanel = $('memberPanel');
    if (!memberPanel || $('memberHomeTab')) return;

    const toolbar = memberPanel.querySelector('.toolbar');
    if (toolbar && !$('memberHomeBtn')) {
        toolbar.insertAdjacentHTML('afterbegin', '<button class="btn btn-sm btn-outline-secondary" id="memberHomeBtn" data-tab="member-home" type="button">ポータルトップ</button>');
    }

    memberPanel.insertAdjacentHTML('afterbegin', `
        <div id="memberHomeTab" class="tab-content">
            <section class="portal-home">
                <div class="portal-home-section">
                    <div class="portal-home-heading">
                        <h2>お知らせ</h2>
                    </div>
                    <div id="portalHomeAnnouncements"></div>
                </div>
                <div id="portalHomeCountdown"></div>
                <div class="portal-home-section">
                    <div class="portal-home-heading">
                        <h2>メニュー</h2>
                    </div>
                    <div class="portal-menu-groups" id="portalHomeMenu"></div>
                </div>
            </section>
        </div>
    `);
    if (!$('memberSheetViewerTab')) {
        memberPanel.insertAdjacentHTML('beforeend', `
            <div id="memberSheetViewerTab" class="tab-content" hidden>
                <div class="card sheet-viewer-card">
                    <div class="card-header d-flex flex-wrap justify-content-between align-items-center gap-2">
                        <span id="sheetViewerTitle">楽譜表示</span>
                        <div class="d-flex flex-wrap gap-2">
                            <button class="btn btn-sm btn-outline-primary" id="sheetViewerZoomOut" type="button">縮小</button>
                            <button class="btn btn-sm btn-outline-primary" id="sheetViewerFitWidth" type="button">幅に合わせる</button>
                            <button class="btn btn-sm btn-outline-primary" id="sheetViewerZoomIn" type="button">拡大</button>
                            <a class="btn btn-sm btn-primary" id="sheetViewerDownload" href="#" download>DL</a>
                            <button class="btn btn-sm btn-outline-secondary" id="sheetViewerBackBtn" type="button">楽譜ライブラリに戻る</button>
                            <button class="btn btn-sm btn-outline-primary" id="sheetViewerMenuBtn" type="button">戻る</button>
                        </div>
                    </div>
                    <div class="card-body sheet-viewer-body">
                        <div class="sheet-viewer-status" id="sheetViewerStatus">楽譜を読み込み中...</div>
                        <div class="sheet-viewer-pages" id="sheetViewerPages"></div>
                    </div>
                </div>
            </div>
        `);
    }
}

function updateSavePath() {
    if (!$('savePath')) return;
    const date = $('uploadDate').value || window.portalRuntimeContext.today();
    const piece = $('uploadPiece').value.trim() || '未分類';
    $('savePath').textContent = `/converted/${date}/${piece}/`;
}
