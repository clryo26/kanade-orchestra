// 本番共有状態を main.js から切り離した互換ストア。新規状態追加はこのファイルへ寄せる。
window.WHOLE_PRACTICE_RECORDING_PIECE = '練習全体の通し';
const initialPortalAppState = {
    selectedFiles: [],
    performancePieces: [],
    performancePieceEditIndex: null,
    performances: [],
    schedules: [],
    announcements: [],
    events: [],
    members: [],
    recordings: [],
    absences: [],
    eventResponses: [],
    dateAdjustments: [],
    dateAdjustmentResponses: [],
    sheetLibrary: [],
    payments: [],
    castings: [],
    pieceInfos: [],
    practiceInstructions: [],
    desiredPieces: [],
    promotions: [],
    performanceDayInfos: [],
    albums: [],
    partSettings: [],
    venueSettings: [],
    flyerDistributions: [],
    flyerDistributionAssignments: [],
    orgSettings: [],
    snsSettings: [],
    connectionSettings: [],
    currentAudio: null,
    currentPlayButton: null,
    currentRecordingItem: null,
    continuousPlayback: false,
    dataLoaded: false,
    recordingsLoaded: false,
    sheetsLoaded: false,
    essentialDataLoaded: false,
    fullDataLoading: false,
    authDevices: [],
    accessLogs: [],
    suppressDerivedRender: false,
    portalAuthVerified: false,
    currentUserMemberId: null,
    currentUserName: '',
    currentUserPermission: '',
    currentUserPart: '',
    currentUserHiddenUser: false,
    currentUserIsRecordingManager: false,
    currentUserIsSheetManager: false,
    systemEnvironmentStatus: null,
    sheetPdfScale: 1,
    sheetPdfUrl: '',
    sheetPdfRendering: false,
    manifestObjectUrl: '',
    portalSelectedAnnouncementId: null,
    selectedPieceInfoContext: null,
    pieceInfoEditing: false,
    selectedPracticeInstructionContext: null,
    practiceInstructionEditing: false,
    selectedSheetIds: [],
    castingEditingId: null,
    castingEditingPerformanceId: null,
    castingEditingPiece: '',
    // 乗り番フォームで編集中の団員配列。
    castingEditingMembers: [],
    // 乗り番フォームで編集中のエキストラ配列。
    castingEditingExtras: [],
    // システム管理のDB閲覧: 取得済みテーブル一覧。
    databaseTables: [],
    // システム管理のDB閲覧: 選択中テーブル。
    databaseSelectedTable: '',
    // システム管理のDB閲覧: 取得開始オフセット。
    databaseOffset: 0,
    // システム管理のDB閲覧: 1ページあたり件数。
    databaseLimit: 50,
    // システム管理のDB閲覧: 現在テーブルの総件数。
    databaseTotal: 0,
    // 団員向け楽譜一覧の絞り込み条件。
    sheetFilters: {
        // 絞り込み対象の演奏会 ID。
        performanceId: '',
        // 絞り込み対象の曲名。
        piece: '',
        // 絞り込み対象のパート。
        part: ''
    },
    // 団員向け録音一覧の絞り込み条件。
    recordingFilters: {
        // キーワード（曲名・ファイル名）
        query: '',
        // 練習日
        date: '',
        // 曲名
        piece: ''
    },
};

if (!window.portalAppState) {
    window.portalAppState = initialPortalAppState;
}

window.getAppState = function getAppState() {
    return window.portalAppState;
};

Object.defineProperty(window, 'appState', {
    configurable: true,
    get() {
        return window.portalAppState;
    },
    set(value) {
        window.portalAppState = value;
    }
});
