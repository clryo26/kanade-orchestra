// Navigation tab identifiers and access-log helpers split from modules/navigation.js.
// Keep global names for compatibility with legacy non-module loading.

var appState = window.portalRuntimeContext.appState;

function toPascalTab(value) {
    const map = {
        upload: 'upload',
        performance: 'performance',
        'performance-day-admin': 'performanceDayAdmin',
        schedule: 'schedule',
        announcement: 'announcement',
        event: 'event',
        member: 'member',
        'payment-admin': 'paymentAdmin',
        'payment-setting': 'paymentSetting',
        'venue-admin': 'venueAdmin',
        'casting-admin': 'castingAdmin',
        'sheet-admin': 'sheetAdmin',
        'member-home': 'memberHome',
        'member-announce': 'memberAnnounce',
        'member-performance': 'memberPerformance',
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
        'system-org': 'systemOrg',
        'system-sns': 'systemSns',
        'system-connection': 'systemConnection',
        'system-part': 'systemPart',
        'system-access-log': 'systemAccessLog',
        'system-database': 'systemDatabase',
    };
    return map[value] || value;
}

const ACCESS_LOG_MENU_LABELS = {
    upload: '録音管理',
    performance: '演奏会情報管理',
    'performance-day-admin': '本番情報管理',
    schedule: '練習予定管理',
    announcement: 'お知らせ管理',
    event: 'イベント管理',
    member: '団員登録',
    'payment-admin': '支払管理',
    'payment-setting': '支払設定',
    'venue-admin': '会場管理',
    'casting-admin': '乗り番管理',
    'sheet-admin': '楽譜管理',
    'member-home': 'ポータルメニュー',
    'member-announce': 'お知らせ',
    'member-performance': '演奏会情報',
    'member-performance-day': '本番情報',
    'member-schedule': '練習予定',
    'member-practice-instruction': '練習指示',
    'member-recording': '録音部屋',
    'member-intro': '団員紹介',
    'member-absence': '欠席連絡',
    'member-sheet': '楽譜ライブラリ',
    'member-sheet-viewer': '楽譜表示',
    'member-payment': '支払状況',
    'member-casting': '乗り番表',
    'member-event': 'イベント調整',
    'member-date-adjustment': '日程調整',
    'member-piece-info': '楽曲紹介',
    'member-desired-piece': '演奏希望曲',
    'member-promotion': '宣伝',
    'member-manual': 'マニュアル',
    'member-album': 'アルバム',
    'member-concert-record': '演奏会記録',
    'member-sns': 'SNS',
    'announcement-detail': 'お知らせ詳細',
    'system-auth': '認証端末管理',
    'system-org': '団体情報管理',
    'system-sns': 'SNS情報',
    'system-connection': '接続先情報',
    'system-part': 'パート管理',
    'system-access-log': 'アクセスログ',
    'system-database': 'データベース',
};

function accessLogPanelLabel(panelId) {
    if (panelId === 'systemPanel') return 'システム管理';
    if (panelId === 'adminPanel') return '管理者メニュー';
    return '団員メニュー';
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
    fetch('/api/system/access-logs', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Device-Id': deviceId,
        },
        body: JSON.stringify(payload),
    }).catch((error) => console.warn('Access log save failed:', error));
}