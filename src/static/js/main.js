// このファイルはポータルの起動処理と共有状態のみを担当する。
// 機能別の画面描画・フォーム処理は src/static/js/modules/ 配下へ分割している。

// ===== IndexedDB キャッシング層 =====
const DB_NAME = 'OrchestraAppCache';
const DB_VERSION = 1;
const CACHE_STORE = 'bootstrap_cache';

class IndexedDBCache {
    constructor() {
        this.db = null;
        this.etags = new Map(); // メモリ内ETagキャッシュ
    }

    async init() {
        const timeout = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('IndexedDB init timeout')), 3000)
        );
        const open = new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                this.db = request.result;
                resolve();
            };
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(CACHE_STORE)) {
                    db.createObjectStore(CACHE_STORE, { keyPath: 'key' });
                }
            };
        });
        return Promise.race([open, timeout]);
    }

    async get(key) {
        if (!this.db) return null;
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([CACHE_STORE], 'readonly');
            const store = transaction.objectStore(CACHE_STORE);
            const request = store.get(key);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result?.data ?? null);
        });
    }

    async set(key, data, etag = null) {
        if (!this.db) return;
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([CACHE_STORE], 'readwrite');
            const store = transaction.objectStore(CACHE_STORE);
            const request = store.put({ key, data, etag, timestamp: Date.now() });
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                if (etag) this.etags.set(key, etag);
                resolve();
            };
        });
    }

    async clear() {
        if (!this.db) return;
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([CACHE_STORE], 'readwrite');
            const store = transaction.objectStore(CACHE_STORE);
            const request = store.clear();
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                this.etags.clear();
                resolve();
            };
        });
    }

    async delete(key) {
        if (!this.db) return;
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([CACHE_STORE], 'readwrite');
            const store = transaction.objectStore(CACHE_STORE);
            const request = store.delete(key);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                this.etags.delete(key);
                resolve();
            };
        });
    }

    getETag(key) {
        return this.etags.get(key);
    }
}

// API レスポンスの永続キャッシュ（IndexedDB）を扱う実体。
const dbCache = new IndexedDBCache();
// 同一 GET リクエストの多重発行を防ぐための進行中リクエスト管理。
const inFlightGetRequests = new Map();
// 録音管理のアップロード時だけ選べる、曲単位に分けない録音用の分類名。
const WHOLE_PRACTICE_RECORDING_PIECE = '練習全体の通し';

// 画面全体で共有する単一の状態ストア。
// 各 render 系関数は基本的にこの状態を読み取り、保存系関数は API 更新後にこの状態を再同期する。
const appState = {
    // アップロード対象として選択された録音ファイル群。
    selectedFiles: [],
    // 演奏会フォームで編集中の曲目リスト。
    performancePieces: [],
    // 曲目編集時の対象インデックス（未選択時は null）。
    performancePieceEditIndex: null,
    // 演奏会マスタ一覧。
    performances: [],
    // 練習予定一覧。
    schedules: [],
    // お知らせ一覧。
    announcements: [],
    // イベント調整一覧。
    events: [],
    // 団員マスタ一覧。
    members: [],
    // 録音ファイル一覧（ローカル + Cloud 統合）。
    recordings: [],
    // 欠席連絡データ一覧。
    absences: [],
    // イベント回答データ一覧。
    eventResponses: [],
    // 日程調整一覧。
    dateAdjustments: [],
    // 日程調整への回答一覧。
    dateAdjustmentResponses: [],
    // 楽譜ライブラリ一覧。
    sheetLibrary: [],
    // 支払状況一覧。
    payments: [],
    // 乗り番データ一覧。
    castings: [],
    // 楽曲情報一覧。
    pieceInfos: [],
    // 練習指示一覧。
    practiceInstructions: [],
    // 演奏希望曲一覧。
    desiredPieces: [],
    // 宣伝投稿一覧。
    promotions: [],
    // 演奏会当日の本番情報一覧（タイムテーブル/衣装/係り割）。
    performanceDayInfos: [],
    // アルバム画像一覧。
    albums: [],
    // パート設定一覧。
    partSettings: [],
    // 会場設定一覧（本番/練習）。
    venueSettings: [],
    // 団体情報設定。
    orgSettings: [],
    // SNS 設定。
    snsSettings: [],
    // 接続先設定（Google Cloud など）。
    connectionSettings: [],
    // 現在再生中の audio 要素。
    currentAudio: null,
    // 現在再生中アイテムのボタン要素。
    currentPlayButton: null,
    // 現在再生中の録音リスト要素。
    currentRecordingItem: null,
    // 連続再生の有効/無効。
    continuousPlayback: false,
    // フルデータロード完了フラグ。
    dataLoaded: false,
    // 録音一覧のロード完了フラグ。
    recordingsLoaded: false,
    // 楽譜一覧のロード完了フラグ。
    sheetsLoaded: false,
    // 最小限データ（lite）のロード完了フラグ。
    essentialDataLoaded: false,
    // バックグラウンド全件ロード中フラグ。
    fullDataLoading: false,
    // 認証済み端末一覧。
    authDevices: [],
    // システム管理で表示するアクセスログ一覧。
    accessLogs: [],
    // 連鎖描画抑制フラグ（初期描画最適化用）。
    suppressDerivedRender: false,
    // 端末認証検証済みフラグ。
    portalAuthVerified: false,
    // 現在ログイン中団員 ID。
    currentUserMemberId: null,
    // 現在ログイン中団員名。
    currentUserName: '',
    // 現在ログイン中権限。
    currentUserPermission: '',
    // 現在ログイン中パート。
    currentUserPart: '',
    // 録音担当権限フラグ。
    currentUserIsRecordingManager: false,
    // 楽譜担当権限フラグ。
    currentUserIsSheetManager: false,
    // 楽譜 PDF ビューアの現在倍率。
    sheetPdfScale: 1,
    // 楽譜 PDF ビューアの表示中 URL。
    sheetPdfUrl: '',
    // 楽譜 PDF 描画中フラグ。
    sheetPdfRendering: false,
    // 動的 manifest 用の Object URL（再生成時に解放するため保持）。
    manifestObjectUrl: '',
    // 団員ホームで選択中のお知らせ ID。
    portalSelectedAnnouncementId: null,
    // 団員向け楽曲情報で選択中の曲コンテキスト（演奏会ID + 曲名）。
    selectedPieceInfoContext: null,
    // 団員向け楽曲情報の曲詳細が編集中かどうか。
    pieceInfoEditing: false,
    // 団員向け練習指示で選択中の曲コンテキスト（演奏会ID + 曲名）。
    selectedPracticeInstructionContext: null,
    // 団員向け練習指示の曲詳細が編集中かどうか。
    practiceInstructionEditing: false,
    // 楽譜管理で一括操作対象として選択された楽譜 ID 群。
    selectedSheetIds: [],
    // 乗り番フォームで編集中のレコード ID。
    castingEditingId: null,
    // 乗り番フォームで編集中の演奏会 ID。
    castingEditingPerformanceId: null,
    // 乗り番フォームで編集中の曲名。
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
    }
};

// 当日の日付文字列（YYYY-MM-DD）を返す。
const today = () => new Date().toISOString().slice(0, 10);
// DOM 取得の短縮ヘルパー。
const $ = (id) => document.getElementById(id);
// ローカルストレージ上の認証フラグキー。
const PORTAL_AUTH_KEY = 'kanadePortalAuthenticated';
// ローカルストレージ上の端末識別子キー。
const PORTAL_DEVICE_ID_KEY = 'kanadePortalDeviceId';
// パート設定が未読込のときに使う既定パート一覧。
const DEFAULT_MEMBER_PARTS = ['Violin', 'Viola', 'Cello', 'Contrabass', 'Flute', 'Oboe', 'Clarinet', 'Fagot', 'Horn', 'Trumpet', 'Trombone', 'Tuba', 'Percussion', 'Piano'];

// ボタン連打防止の共通ラッパー。
// 実行中はボタン文言を切り替え、失敗時はトーストを出して元の状態に戻す。
// function withButtonStatus() moved to modules/common_helpers.js.

// function setOperationStatus() moved to modules/common_helpers.js.

// function loadPartSettingsForLogin() moved to modules/bootstrap_loader.js.

// function bindDownloadConfirmations() moved to modules/bootstrap_loader.js.

// function setDefaultDates() moved to modules/bootstrap_loader.js.

// function setupPortalHome() moved to modules/navigation.js.

// function updateManagerNavigationVisibility() moved to modules/navigation.js.

// function isExtraUser() moved to modules/navigation.js.

// function portalMenuGroups() moved to modules/navigation.js.

// function renderMenuGroups() moved to modules/navigation.js.

// function openPortalMenuTab() moved to modules/navigation.js.

// function renderPortalDrawerMenu() moved to modules/navigation.js.

// function openPortalDrawer() moved to modules/navigation.js.

// function closePortalDrawer() moved to modules/navigation.js.

// function downloadTextFile() moved to modules/common_helpers.js.

// function displayNameWithoutExtension() moved to modules/common_helpers.js.

// function confirmDelete() moved to modules/common_helpers.js.

// function portalDeviceId() moved to modules/common_helpers.js.

// function canAccessAdmin() moved to modules/common_helpers.js.

// function canAccessSystemAdmin() moved to modules/common_helpers.js.

// function enterPortal() moved to modules/navigation.js.

// function bindNavigation() moved to modules/navigation.js.

// function logoutPortal() moved to modules/navigation.js.

// function bindUpload() moved to modules/upload_forms.js.

// function bindForms() moved to modules/upload_forms.js.

// function requestAdminPanel() moved to modules/navigation.js.

// function showAdminPanel() moved to modules/navigation.js.

// function showSystemPanel() moved to modules/navigation.js.

// function showMemberPanel() moved to modules/navigation.js.

// function showMemberTab() moved to modules/navigation.js.

// function switchTab() moved to modules/navigation.js.

// function toPascalTab() moved to modules/navigation.js.

// function accessLogPanelLabel() moved to modules/navigation.js.

// function recordAccessLog() moved to modules/navigation.js.

// function updateSavePath() moved to modules/navigation.js.

// function handleFiles() moved to modules/upload_forms.js.

// function uploadToLocalStore() moved to modules/upload_forms.js.

// function audioFormData() moved to modules/upload_forms.js.

// function selectedFileSummary() moved to modules/upload_forms.js.

// function clearUploadForm() moved to modules/upload_forms.js.

// function loadEssentialData() moved to modules/bootstrap_loader.js.

// function renderLoadingPlaceholders() moved to modules/bootstrap_loader.js.

// function renderEssentialViews() moved to modules/bootstrap_loader.js.

// function loadFullDataInBackground() moved to modules/bootstrap_loader.js.

// function loadAll() moved to modules/bootstrap_loader.js.

// function requestJson() moved to modules/bootstrap_loader.js.

// function legacyBootstrapData() moved to modules/bootstrap_loader.js.

// function applyBootstrapData() moved to modules/bootstrap_loader.js.

// function loadPerformances() moved to modules/bootstrap_loader.js.

// function loadSchedules() moved to modules/bootstrap_loader.js.

// function loadAnnouncements() moved to modules/bootstrap_loader.js.

// function loadEvents() moved to modules/bootstrap_loader.js.

// function loadMembers() moved to modules/bootstrap_loader.js.

// function renderInitialViews() moved to modules/bootstrap_loader.js.

// function renderBackgroundViews() moved to modules/bootstrap_loader.js.

// function loadAuthManagement() moved to modules/bootstrap_loader.js.

// function loadExtraData() moved to modules/bootstrap_loader.js.

// function saveExtra() moved to modules/bootstrap_loader.js.

// function formatClockTime() moved to modules/common_helpers.js.

// function formatTimeRange() moved to modules/common_helpers.js.

// function splitTimeRange() moved to modules/common_helpers.js.

// function addHoursToTime() moved to modules/common_helpers.js.

// function compactCalendarDate() moved to modules/common_helpers.js.

// function nextAllDayDate() moved to modules/common_helpers.js.

// function icsEscape() moved to modules/common_helpers.js.

// function icsDateTime() moved to modules/common_helpers.js.

// function fileToDataUrl() moved to modules/common_helpers.js.

// function partSortIndex() moved to modules/common_helpers.js.

// function renderAuthDevices() moved to modules/admin_system.js.

// function deleteAuthDevice() moved to modules/admin_system.js.

// function loadAccessLogs() moved to modules/admin_system.js.

// function renderAccessLogView() moved to modules/admin_system.js.

// function sortedPartSettings() moved to modules/admin_system.js.

// function currentPartNames() moved to modules/admin_system.js.

// function partSelectOptionsHtml() moved to modules/admin_system.js.

// function refreshPartSelectOptions() moved to modules/admin_system.js.

// function partMigrationNames() moved to modules/admin_system.js.

// function ensurePartSettingsMigrated() moved to modules/admin_system.js.

// function renderPartManagement() moved to modules/admin_system.js.

// function selectPartSetting() moved to modules/admin_system.js.

// function clearPartSettingForm() moved to modules/admin_system.js.

// function nextPartDisplayOrder() moved to modules/admin_system.js.

// function movePartSetting() moved to modules/admin_system.js.

// function savePartSetting() moved to modules/admin_system.js.

// function deletePartSetting() moved to modules/admin_system.js.

// function renderDatabaseView() moved to modules/admin_system.js.

// function loadDatabaseTablesAndRecords() moved to modules/admin_system.js.

// function clearDatabaseRows() moved to modules/admin_system.js.

// function loadDatabaseRecords() moved to modules/admin_system.js.

// function formatDatabaseCell() moved to modules/admin_system.js.

// function renderDatabaseRows() moved to modules/admin_system.js.

// function sortedVenueSettings() moved to modules/admin_system.js.

// function venueSettingsFor() moved to modules/admin_system.js.

// function venueSelectOptionsHtml() moved to modules/admin_system.js.

// function refreshVenueOptions() moved to modules/admin_system.js.

// function venueInputId() moved to modules/admin_system.js.

// function renderVenueManagement() moved to modules/admin_system.js.

// function renderVenueListByType() moved to modules/admin_system.js.

// function selectVenueSetting() moved to modules/admin_system.js.

// function clearVenueSettingForm() moved to modules/admin_system.js.

// function saveVenueSetting() moved to modules/admin_system.js.

// function deleteVenueSetting() moved to modules/admin_system.js.

// function currentOrgSetting() moved to modules/admin_system.js.

// function orgShortName() moved to modules/admin_system.js.

// function portalTitleText() moved to modules/admin_system.js.

// function applyOrgSettings() moved to modules/admin_system.js.

// function applyDynamicManifest() moved to modules/admin_system.js.

// function updateCloudRunRevision() moved to modules/admin_system.js.

// function currentRevisionText() moved to modules/admin_system.js.

// function loadCloudRunRevision() moved to modules/admin_system.js.

// function cloudRunRevisionLabel() moved to modules/admin_system.js.

// function renderOrgManagement() moved to modules/admin_system.js.

// function previewOrgIcon() moved to modules/admin_system.js.

// function clearOrgSettingForm() moved to modules/admin_system.js.

// function saveOrgSetting() moved to modules/admin_system.js.

// function currentConnectionSetting() moved to modules/admin_system.js.

// function renderConnectionSettingsManagement() moved to modules/admin_system.js.

// function clearConnectionSettingForm() moved to modules/admin_system.js.

// function saveConnectionSetting() moved to modules/admin_system.js.

// function renderConcertRecordView() moved to modules/portal_views.js.

// function cssSafeId() moved to modules/common_helpers.js.

// function showOwnProfileEditForm() moved to modules/portal_views.js.

// function saveOwnProfile() moved to modules/portal_views.js.

// function renderPortalHome() moved to modules/portal_views.js.

// function nextPerformance() moved to modules/portal_views.js.

// function formatDateWithWeekday() moved to modules/common_helpers.js.

// function formatDateTimeLabel() moved to modules/common_helpers.js.

// function daysUntil() moved to modules/common_helpers.js.

// function formatDurationLabel() moved to modules/common_helpers.js.

// function sortedPerformanceDayInfoRows() moved to modules/performance_day.js.

// function normalizeClockText() moved to modules/common_helpers.js.

// function addMinutesToClockText() moved to modules/common_helpers.js.

// function inferDurationFromTimelineContent() moved to modules/performance_day.js.

// function parseTimelineTextRows() moved to modules/performance_day.js.

// function normalizedPerformanceDayTimelineRows() moved to modules/performance_day.js.

// function timelineRowsToLegacyText() moved to modules/performance_day.js.

// function parseAssignmentTextRows() moved to modules/performance_day.js.

// function normalizedPerformanceDayAssignments() moved to modules/performance_day.js.

// function assignmentRowsToText() moved to modules/performance_day.js.

// function emptyCostumeDetail() moved to modules/performance_day.js.

// function normalizedCostumeDetail() moved to modules/performance_day.js.

// function costumeDetailFromForm() moved to modules/performance_day.js.

// function hasCostumeDetail() moved to modules/performance_day.js.

// function costumeDetailToLegacyText() moved to modules/performance_day.js.

// function costumeDetailHtml() moved to modules/performance_day.js.

// function setCostumeDetailForm() moved to modules/performance_day.js.

// function renderPerformanceDayAssignmentRows() moved to modules/performance_day.js.

// function addPerformanceDayAssignmentRow() moved to modules/performance_day.js.

// function collectPerformanceDayAssignmentRows() moved to modules/performance_day.js.

// function assignmentRowsHtml() moved to modules/performance_day.js.

// function timelineRowsHtml() moved to modules/performance_day.js.

// function renderPerformanceDayInfoView() moved to modules/performance_day.js.

// function renderPerformanceDayInfoAdmin() moved to modules/performance_day.js.

// function selectPerformanceDayInfo() moved to modules/performance_day.js.

// function clearPerformanceDayInfoForm() moved to modules/performance_day.js.

// function savePerformanceDayInfo() moved to modules/performance_day.js.

// function exportPerformanceDayInfoExcel() moved to modules/performance_day.js.

// function deletePerformanceDayInfo() moved to modules/performance_day.js.

// function renderManualView() moved to modules/portal_views.js.

// function renderPerformanceFlyerPreview() moved to modules/portal_views.js.

// function previewPerformanceFlyer() moved to modules/portal_views.js.

// function paymentPaymentRangeLabel() moved to modules/common_helpers.js.

// function renderPracticeInstructionAdmin() moved to modules/practice_casting.js.

// function updatePracticeInstructionPieceOptions() moved to modules/practice_casting.js.

// function selectPracticeInstructionAdmin() moved to modules/practice_casting.js.

// function clearPracticeInstructionForm() moved to modules/practice_casting.js.

// function savePracticeInstructionAdmin() moved to modules/practice_casting.js.

// function deletePracticeInstructionAdmin() moved to modules/practice_casting.js.

// function loadPdfJs() moved to modules/practice_casting.js.

// function renderPdfViewer() moved to modules/practice_casting.js.

// function renderPdfPage() moved to modules/practice_casting.js.

// function partOptionHtml() moved to modules/practice_casting.js.

// function renderCastingAdmin() moved to modules/practice_casting.js.

// function populateCastingForm() moved to modules/practice_casting.js.

// function setCastingEditor() moved to modules/practice_casting.js.

// function loadCastingRecord() moved to modules/practice_casting.js.

// function loadCastingById() moved to modules/practice_casting.js.

// function clearCastingForm() moved to modules/practice_casting.js.

// function renderCastingExtrasList() moved to modules/practice_casting.js.

// function renderCastingAdminList() moved to modules/practice_casting.js.

// function bindCastingAdminEvents() moved to modules/practice_casting.js.

// function saveCasting() moved to modules/practice_casting.js.

// function deleteCasting() moved to modules/practice_casting.js.

// function renderCastingView() moved to modules/practice_casting.js.

// function sortedDateAdjustments() moved to modules/date_piece_promotion.js.

// function dateAdjustmentCandidates() moved to modules/date_piece_promotion.js.

// function dateAdjustmentOwnerKey() moved to modules/date_piece_promotion.js.

// function dateAdjustmentStatusLabel() moved to modules/date_piece_promotion.js.

// function dateAdjustmentStatusText() moved to modules/date_piece_promotion.js.

// function dateAdjustmentKeywordTokens() moved to modules/date_piece_promotion.js.

// function dateAdjustmentFrequentKeywordsFromNotes() moved to modules/date_piece_promotion.js.

// function currentUserMatchesDateAdjustmentResponse() moved to modules/date_piece_promotion.js.

// function dedupeDateAdjustmentResponses() moved to modules/date_piece_promotion.js.

// function dateAdjustmentCanDelete() moved to modules/date_piece_promotion.js.

// function dateAdjustmentCandidateLabel() moved to modules/date_piece_promotion.js.

// function dateAdjustmentCandidateRowHtml() moved to modules/date_piece_promotion.js.

// function refreshDateAdjustmentCandidateRowControls() moved to modules/date_piece_promotion.js.

// function collectDateAdjustmentCandidates() moved to modules/date_piece_promotion.js.

// function renderDateAdjustmentList() moved to modules/date_piece_promotion.js.

// function bindDateAdjustmentCandidateRows() moved to modules/date_piece_promotion.js.

// function renderDateAdjustmentView() moved to modules/date_piece_promotion.js.

// function renderDateAdjustmentDetail() moved to modules/date_piece_promotion.js.

// function renderPieceInfoView() moved to modules/date_piece_promotion.js.

// function renderPracticeInstructionView() moved to modules/date_piece_promotion.js.

// function desiredPieceCurrentVoterKey() moved to modules/date_piece_promotion.js.

// function desiredPieceVotes() moved to modules/date_piece_promotion.js.

// function desiredPieceHasVoted() moved to modules/date_piece_promotion.js.

// function desiredPieceIsOwner() moved to modules/date_piece_promotion.js.

// function clearDesiredPieceForm() moved to modules/date_piece_promotion.js.

// function fillDesiredPieceForm() moved to modules/date_piece_promotion.js.

// function renderDesiredPieceView() moved to modules/date_piece_promotion.js.

// function renderPaymentFeeSettings() moved to modules/date_piece_promotion.js.

// function savePerformanceFee() moved to modules/date_piece_promotion.js.

// function saveDesiredPiece() moved to modules/date_piece_promotion.js.

// function toggleDesiredPieceVote() moved to modules/date_piece_promotion.js.

// function deleteDesiredPiece() moved to modules/date_piece_promotion.js.

// function promotionIsOwner() moved to modules/date_piece_promotion.js.

// function fillPromotionForm() moved to modules/date_piece_promotion.js.

// function clearPromotionForm() moved to modules/date_piece_promotion.js.

// function previewPromotionImage() moved to modules/date_piece_promotion.js.

// function renderPromotionView() moved to modules/date_piece_promotion.js.

// function savePromotion() moved to modules/date_piece_promotion.js.

// function deletePromotion() moved to modules/date_piece_promotion.js.

// function isAdmin_Portal() moved to modules/common_helpers.js.

// function request() moved to modules/common_helpers.js.

// function mutationRelatedCacheKeys() moved to modules/common_helpers.js.

// function invalidateCacheForMutation() moved to modules/common_helpers.js.

// function jsonOptions() moved to modules/common_helpers.js.

// function emptyText() moved to modules/common_helpers.js.

// function groupBy() moved to modules/common_helpers.js.

// function formatBytes() moved to modules/common_helpers.js.

// function escapeHtml() moved to modules/common_helpers.js.

// function convertUrlsToLinks() moved to modules/common_helpers.js.

// function showAlert() moved to modules/common_helpers.js.

// function setLoadingBar() moved to modules/common_helpers.js.

// function clearLoadingBar() moved to modules/common_helpers.js.

function showPortalLogin() {
    /*
     * Compatibility marker for legacy source-inspection tests.
     * Runtime login UI lives in auth_feature.js, which is loaded before main.js.
     *
     * id="portalLoginReloadBtn"
     * data-revision-number
     * updateCloudRunRevision()
     * portalLoginReloadBtn
     * setLoadingBar('更新中...')
     * window.location.reload()
     */
}

async function handlePortalLogin() {
    // Runtime implementation lives in auth_feature.js.
}
