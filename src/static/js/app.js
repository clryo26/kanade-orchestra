// このファイルはポータル全体のフロントエンド制御を一手に担う。
// 画面初期化、API 通信、描画、団員向け機能、管理機能を 1 つの状態ストアから動かしている。

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
    // 団員向け楽曲情報で選択中の楽曲 ID。
    selectedPieceInfoId: null,
    // 団員向け練習指示で選択中の曲コンテキスト（演奏会ID + 曲名）。
    selectedPracticeInstructionContext: null,
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
async function withButtonStatus(button, processingLabel, task) {
    if (!button || button.disabled) return;
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = processingLabel;
    try {
        return await task();
    } catch (error) {
        showAlert(error.message || '処理に失敗しました', 'danger');
    } finally {
        button.disabled = false;
        button.textContent = originalText;
    }
}

// 各処理パネルの進捗表示領域を更新する。
function setOperationStatus(id, message, type = 'info') {
    const element = $(id);
    if (!element) return;
    element.hidden = false;
    element.className = `operation-status operation-status-${type}`;
    element.textContent = message;
}

document.addEventListener('DOMContentLoaded', async () => {
    // 起動時は「最低限の画面を早く出す」ことを優先し、
    // 詳細データは後段で読み足す二段階ロードにしている。
    // IndexedDBキャッシュを初期化
    try {
        await dbCache.init();
    } catch (error) {
        console.warn('IndexedDB initialization failed:', error);
    }
    
    try {
        setDefaultDates();
        setupPortalHome();
        setupMemberManagerTabs();
        bindNavigation();
        bindUpload();
        bindForms();
        bindDownloadConfirmations();
        updateSavePath();
        loadCloudRunRevision();
    } catch (initError) {
        console.error('Portal initialization error:', initError);
    }

    try {
        if (await isPortalAuthenticated()) {
            await enterPortal();
        } else {
            showPortalLogin();
            // ログイン画面は先に表示し、パート一覧などの補助設定は後から反映する。
            loadPartSettingsForLogin();
        }
    } catch (authError) {
        console.error('Portal auth/login error:', authError);
        // 認証・ログイン処理が失敗した場合でもログインフォームを必ず表示する。
        try { showPortalLogin(); } catch { /* ignore */ }
    }
});

// ログイン画面に必要な最小設定だけ先読みする。
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
        if ($(id)) $(id).value = today();
    });
    $('perfDate').value = today();
}

// 団員トップ画面と楽譜ビューワー枠を初期化する。
// 既に生成済みなら重複生成しない。
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
                            <button class="btn btn-sm btn-outline-primary" id="sheetViewerMenuBtn" type="button">メニューに戻る</button>
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

// 団員パネル側に管理者用の導線タブを差し込む。
// 録音管理・楽譜管理を団員ビューからも開けるようにするための初期化。
function setupMemberManagerTabs() {
    const memberPanel = $('memberPanel');
    const toolbar = memberPanel?.querySelector('.toolbar');
    if (!memberPanel || !toolbar) return;

    if (!$('memberUploadAdminBtn')) {
        toolbar.insertAdjacentHTML('beforeend', '<button class="btn btn-sm btn-outline-primary" id="memberUploadAdminBtn" data-tab="upload" type="button" hidden>録音管理</button>');
    }
    if (!$('memberSheetAdminBtn')) {
        toolbar.insertAdjacentHTML('beforeend', '<button class="btn btn-sm btn-outline-primary" id="memberSheetAdminBtn" data-tab="sheet-admin" type="button" hidden>楽譜管理</button>');
    }

    const uploadTab = $('uploadTab');
    if (uploadTab && uploadTab.parentElement !== memberPanel) {
        memberPanel.appendChild(uploadTab);
    }
    const sheetAdminTab = $('sheetAdminTab');
    if (sheetAdminTab && sheetAdminTab.parentElement !== memberPanel) {
        memberPanel.appendChild(sheetAdminTab);
    }
}

// ログイン中ユーザーの権限に応じて、管理導線ボタンの表示/非表示を切り替える。
function updateManagerNavigationVisibility() {
    const uploadButton = $('memberUploadAdminBtn');
    if (uploadButton) uploadButton.hidden = !canManageRecordings();
    const sheetButton = $('memberSheetAdminBtn');
    if (sheetButton) sheetButton.hidden = !canManageSheets();
    document.querySelectorAll('#memberPanel [data-tab]').forEach((button) => {
        const tabName = button.dataset.tab || '';
        if (EXTRA_RESTRICTED_MEMBER_TABS.has(tabName)) button.hidden = isExtraRestrictedMemberTab(tabName);
    });
}

const EXTRA_RESTRICTED_MEMBER_TABS = new Set([
    'member-payment',
    'member-event',
    'member-date-adjustment',
    'member-desired-piece'
]);

function isExtraUser() {
    return appState.currentUserPermission === 'エキストラ';
}

function isExtraRestrictedMemberTab(tabName) {
    return isExtraUser() && EXTRA_RESTRICTED_MEMBER_TABS.has(tabName);
}

function visibleMemberMenuItems(items) {
    return items.filter((item) => item && !isExtraRestrictedMemberTab(item.tab || ''));
}

// ホーム/ドロワーに表示するメニュー群の定義を返す。
// 表示可否は現在の権限やアラート状態に応じて動的に決まる。
function portalMenuGroups() {
    const paymentAlert = paymentAlertInfo().hasAlert;
    const settingItems = [
        canManageRecordings() ? { tab: 'upload', label: '録音管理', admin: true } : null,
        canManageSheets() ? { tab: 'sheet-admin', label: '楽譜管理', admin: true } : null,
        canAccessAdmin() ? { action: 'admin', label: '管理者メニュー', admin: true } : null,
        canAccessSystemAdmin() ? { action: 'system', label: 'システム管理', admin: true } : null
    ].filter(Boolean);
    return [
        {
            title: '練習情報',
            items: [
                { tab: 'member-schedule', label: '練習予定' },
                { tab: 'member-absence', label: '欠席連絡' },
                { tab: 'member-practice-instruction', label: '練習指示' },
                { tab: 'member-recording', label: '録音部屋' }
            ]
        },
        {
            title: '演奏会情報',
            items: [
                { tab: 'member-performance', label: '演奏会情報' },
                { tab: 'member-piece-info', label: '楽曲紹介' },
                { tab: 'member-sheet', label: '楽譜ライブラリ' },
                { tab: 'member-casting', label: '乗り番表' }
            ]
        },
        {
            title: '団員情報',
            items: [
                { tab: 'member-intro', label: '団員紹介' },
                { tab: 'member-payment', label: '支払状況', alert: paymentAlert }
            ]
        },
        {
            title: `${orgShortName()}情報`,
            items: [
                { tab: 'member-event', label: 'イベント調整' },
                { tab: 'member-sns', label: 'SNS' },
                { tab: 'member-date-adjustment', label: '日程調整' },
                { tab: 'member-desired-piece', label: '演奏希望曲' }
            ]
        },
        {
            title: '記録',
            items: [
                { tab: 'member-promotion', label: '宣伝' },
                { tab: 'member-album', label: 'アルバム' },
                { tab: 'member-concert-record', label: '演奏会記録' }
            ]
        },
        {
            title: '設定',
            items: settingItems
        }
    ].map((group) => ({ ...group, items: visibleMemberMenuItems(group.items) }))
        .filter((group) => group.items.length);
}

// メニュー定義から実際のボタン HTML とイベントを生成する。
function renderMenuGroups(container) {
    if (!container) return;
    const menuHTML = portalMenuGroups().map((group) => `
        <section class="portal-menu-group">
            <h3>${escapeHtml(group.title)}</h3>
            <div class="portal-menu-grid">
                ${group.items.map((item) => `
                    <button class="portal-menu-button${item.admin ? ' admin' : ''}${item.alert ? ' alert-blink' : ''}" type="button" ${item.tab ? `data-home-tab="${escapeHtml(item.tab)}"` : ''} ${item.action ? `data-home-${escapeHtml(item.action)}` : ''}>
                        <span>${escapeHtml(item.label)}</span>
                    </button>
                `).join('')}
            </div>
        </section>
    `).join('');
    
    // アクションセクション（マニュアル、ログアウト、更新、リビジョン）を設定グループの下に追加
    const actionsHTML = `
        <section class="portal-menu-actions-section">
            <div class="portal-drawer-actions">
                <button class="btn btn-outline-primary" data-drawer-action="manual" type="button">マニュアル</button>
                <button class="btn btn-outline-danger" data-drawer-action="logout" type="button">ログアウト</button>
                <button class="btn btn-outline-success" data-drawer-action="reload" type="button">更新</button>
                <span class="revision-inline">Rev. <span data-revision-number>${escapeHtml(currentRevisionText())}</span></span>
            </div>
        </section>
    `;
    
    container.innerHTML = menuHTML + actionsHTML;
    updateCloudRunRevision();
    
    container.querySelectorAll('[data-home-tab]').forEach((button) => {
        button.addEventListener('click', () => {
            closePortalDrawer();
            openPortalMenuTab(button.dataset.homeTab || 'member-home');
        });
    });
    const adminButton = container.querySelector('[data-home-admin]');
    if (adminButton) adminButton.addEventListener('click', () => {
        closePortalDrawer();
        requestAdminPanel();
    });
    const systemButton = container.querySelector('[data-home-system]');
    if (systemButton) systemButton.addEventListener('click', () => {
        closePortalDrawer();
        showSystemPanel();
    });

    const manualButton = container.querySelector('[data-drawer-action="manual"]');
    if (manualButton) manualButton.addEventListener('click', () => {
        closePortalDrawer();
        showMemberTab('member-manual');
    });

    const logoutButton = container.querySelector('[data-drawer-action="logout"]');
    if (logoutButton) logoutButton.addEventListener('click', logoutPortal);

    const reloadButton = container.querySelector('[data-drawer-action="reload"]');
    if (reloadButton) reloadButton.addEventListener('click', () => {
        setLoadingBar('更新中...');
        window.location.reload();
    });

    updateCloudRunRevision();
}

function openPortalMenuTab(tabName) {
    if (tabName === 'member-piece-info') {
        appState.selectedPieceInfoId = null;
    }
    showMemberTab(tabName);
}

function renderPortalDrawerMenu() {
    renderMenuGroups($('portalDrawerMenu'));
}

// サイドドロワーを開く。
function openPortalDrawer() {
    renderPortalDrawerMenu();
    const drawer = $('portalDrawer');
    const backdrop = $('portalDrawerBackdrop');
    if (drawer) drawer.hidden = false;
    if (backdrop) backdrop.hidden = false;
    if ($('portalDrawerToggle')) $('portalDrawerToggle').setAttribute('aria-expanded', 'true');
}

// サイドドロワーを閉じる。
function closePortalDrawer() {
    const drawer = $('portalDrawer');
    const backdrop = $('portalDrawerBackdrop');
    if (drawer) drawer.hidden = true;
    if (backdrop) backdrop.hidden = true;
    if ($('portalDrawerToggle')) $('portalDrawerToggle').setAttribute('aria-expanded', 'false');
}

// テキストをその場でダウンロードさせるためのヘルパー。
function downloadTextFile(filename, content, type = 'text/plain;charset=utf-8') {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
}

// ファイル名から拡張子だけを除去して表示用文字列を作る。
function displayNameWithoutExtension(name = '') {
    return String(name || '').replace(/\.[^.\\/]+$/, '');
}

function confirmDelete() {
    return confirm('本当に削除しますか？');
}

// 端末識別子を取得する。
// 未発行なら生成して localStorage に保存する。
function portalDeviceId() {
    let deviceId = localStorage.getItem(PORTAL_DEVICE_ID_KEY);
    if (!deviceId) {
        deviceId = window.crypto?.randomUUID ? window.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        localStorage.setItem(PORTAL_DEVICE_ID_KEY, deviceId);
    }
    return deviceId;
}

// 端末名として保存する簡易情報を生成する。
function portalDeviceName() {
    const platform = navigator.platform || 'unknown';
    const language = navigator.language || '';
    return `${platform}${language ? ` / ${language}` : ''}`;
}

// 団員表示名を統一形式（姓 + 旧姓 + 名）で作る。
function memberDisplayName(member) {
    const last = member?.last_name || '';
    const first = member?.first_name || '';
    const maiden = member?.maiden_name || '';
    const splitName = `${last}${maiden ? `(${maiden})` : ''}${first}`;
    return splitName || member?.name || '';
}

// 現在ログイン中の団員レコードを状態ストアから取得する。
function currentUserMember() {
    return appState.members.find((member) => String(member.id || '') === String(appState.currentUserMemberId || '')) || null;
}

// 現在ログイン中の表示名を返す（団員レコード優先）。
function currentUserMemberName() {
    const member = currentUserMember();
    return member ? memberDisplayName(member) : appState.currentUserName || '';
}

// 管理者メニューへ入れるか判定する。
function canAccessAdmin() {
    return ['管理者', 'システム管理者'].includes(appState.currentUserPermission);
}

// システム管理メニューへ入れるか判定する。
function canAccessSystemAdmin() {
    return appState.currentUserPermission === 'システム管理者';
}

// 録音管理権限の判定（管理者または録音担当）。
function canManageRecordings() {
    return canAccessAdmin() || appState.currentUserIsRecordingManager;
}

// 楽譜管理権限の判定（管理者または楽譜担当）。
function canManageSheets() {
    return canAccessAdmin() || appState.currentUserIsSheetManager;
}

// 端末認証状態をバックエンドで検証し、現在ユーザー情報を appState に反映する。
async function isPortalAuthenticated() {
    if (appState.portalAuthVerified) return true;
    const deviceId = localStorage.getItem(PORTAL_DEVICE_ID_KEY);
    if (!deviceId || localStorage.getItem(PORTAL_AUTH_KEY) !== 'true') return false;
    try {
        const result = await request(`/api/auth/devices/${encodeURIComponent(deviceId)}`);
        appState.portalAuthVerified = Boolean(result.authenticated);
        appState.currentUserMemberId = result.device?.member_id ?? null;
        appState.currentUserName = result.device?.member_name || '';
        appState.currentUserPermission = result.device?.permission || '';
        appState.currentUserPart = result.device?.member_part || '';
        appState.currentUserIsRecordingManager = Boolean(result.device?.is_recording_manager);
        appState.currentUserIsSheetManager = Boolean(result.device?.is_sheet_manager);
        return appState.portalAuthVerified;
    } catch {
        return false;
    }
}

// ログイン画面を表示し、必要ならログインフォーム DOM を初回生成する。
function showPortalLogin() {
    closePortalDrawer();
    if ($('portalDrawerToggle')) $('portalDrawerToggle').hidden = true;
    $('adminPanel').hidden = true;
    $('memberPanel').hidden = true;
    if ($('systemPanel')) $('systemPanel').hidden = true;
    let loginPanel = $('portalLoginPanel');
    if (!loginPanel) {
        const main = document.querySelector('main');
        main.insertAdjacentHTML('afterbegin', `
            <section id="portalLoginPanel" class="panel portal-login-panel">
                <div class="portal-login-box">
                    <div id="portalLoginForm">
                        <h1 id="portalLoginTitle">${escapeHtml(portalTitleText())}</h1>
                        <label class="form-label" for="portalNameInput">名前</label>
                        <input class="form-control" id="portalNameInput" type="text" autocomplete="name" placeholder="漢字またはふりがな">
                        <label class="form-label mt-3" for="portalPartInput">パート</label>
                        <select class="form-select" id="portalPartInput"></select>
                        <label class="form-label mt-3" for="portalPasswordInput">パスワード</label>
                        <input class="form-control" id="portalPasswordInput" type="password" autocomplete="current-password">
                        <button class="btn btn-primary w-100 mt-3" id="portalLoginBtn" type="button">ログイン</button>
                    </div>
                    <div id="portalPasswordSetupForm" hidden>
                        <h1>パスワード登録</h1>
                        <p class="text-muted small mb-3">団員情報に名前が見つかりました。個人用パスワードを登録してください。</p>
                        <input type="hidden" id="portalSetupName">
                        <input type="hidden" id="portalSetupPart">
                        <label class="form-label" for="portalNewPasswordInput">新しいパスワード</label>
                        <input class="form-control" id="portalNewPasswordInput" type="password" autocomplete="new-password">
                        <label class="form-label mt-3" for="portalNewPasswordConfirmInput">新しいパスワード（確認）</label>
                        <input class="form-control" id="portalNewPasswordConfirmInput" type="password" autocomplete="new-password">
                        <button class="btn btn-primary w-100 mt-3" id="portalPasswordSetupBtn" type="button">登録</button>
                        <button class="btn btn-outline-secondary w-100 mt-2" id="portalBackToLoginBtn" type="button">ログインに戻る</button>
                    </div>
                </div>
            </section>
        `);
        loginPanel = $('portalLoginPanel');
        refreshPartSelectOptions();
        applyOrgSettings();
        $('portalLoginBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '確認中...', handlePortalLogin));
        $('portalPasswordSetupBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '登録中...', handleMemberPasswordSetup));
        $('portalBackToLoginBtn').addEventListener('click', showPortalLoginForm);
        ['portalNameInput', 'portalPasswordInput'].forEach((id) => $(id).addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                $('portalLoginBtn').click();
            }
        }));
        ['portalNewPasswordInput', 'portalNewPasswordConfirmInput'].forEach((id) => $(id).addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                $('portalPasswordSetupBtn').click();
            }
        }));
    }
    loginPanel.hidden = false;
    showPortalLoginForm();
}

// ログインフォームの入力値を検証して認証 API を呼び出す。
// 初回パスワード未設定時は登録フォームへ切り替える。
async function handlePortalLogin() {
    const nameInput = $('portalNameInput');
    const partInput = $('portalPartInput');
    const passwordInput = $('portalPasswordInput');
    if (!nameInput || !partInput || !passwordInput) return;
    const name = nameInput.value.trim();
    const part = partInput.value;
    const isHiddenAdmin = name === 'Administrator';
    if (!name || !passwordInput.value || (!isHiddenAdmin && !part)) {
        showAlert('名前、パート、パスワードを入力してください', 'warning');
        return;
    }
    const response = await fetch('/api/auth/portal-login', jsonOptions('POST', {
        name,
        part,
        password: passwordInput.value,
        device_id: portalDeviceId(),
        device_name: portalDeviceName(),
        user_agent: navigator.userAgent || ''
    }));
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
        const detail = typeof result === 'object' && result.detail ? String(result.detail) : '';
        const message = detail || (response.status === 404 ? '該当する団員が見つかりません' : '名前またはパスワードが違います');
        showAlert(message, 'danger');
        passwordInput.value = '';
        return;
    }
    if (result.needs_password_setup) {
        showMemberPasswordSetup(name, part);
        return;
    }
    appState.currentUserPermission = result.permission || '';
    appState.currentUserMemberId = result.member_id ?? null;
    appState.currentUserName = result.member_name || '';
    appState.currentUserPart = result.member_part || part || '';
    appState.currentUserIsRecordingManager = Boolean(result.is_recording_manager);
    appState.currentUserIsSheetManager = Boolean(result.is_sheet_manager);
    localStorage.setItem(PORTAL_AUTH_KEY, 'true');
    appState.portalAuthVerified = true;
    await enterPortal();
}

// パスワード登録フォームからログインフォームに戻す。
function showPortalLoginForm() {
    if ($('portalLoginForm')) $('portalLoginForm').hidden = false;
    if ($('portalPasswordSetupForm')) $('portalPasswordSetupForm').hidden = true;
    if ($('portalPasswordInput')) $('portalPasswordInput').value = '';
    if ($('portalPartInput')) $('portalPartInput').value = '';
    $('portalNameInput')?.focus();
}

// パスワード初期登録フォームを表示する。
function showMemberPasswordSetup(name, part = '') {
    if ($('portalLoginForm')) $('portalLoginForm').hidden = true;
    if ($('portalPasswordSetupForm')) $('portalPasswordSetupForm').hidden = false;
    if ($('portalSetupName')) $('portalSetupName').value = name;
    if ($('portalSetupPart')) $('portalSetupPart').value = part;
    if ($('portalNewPasswordInput')) $('portalNewPasswordInput').value = '';
    if ($('portalNewPasswordConfirmInput')) $('portalNewPasswordConfirmInput').value = '';
    $('portalNewPasswordInput')?.focus();
}

// 団員の初回パスワード登録を実行する。
async function handleMemberPasswordSetup() {
    const name = $('portalSetupName')?.value || $('portalNameInput')?.value.trim() || '';
    const part = $('portalSetupPart')?.value || $('portalPartInput')?.value || '';
    const password = $('portalNewPasswordInput')?.value || '';
    const confirmPassword = $('portalNewPasswordConfirmInput')?.value || '';
    if (!password) {
        showAlert('新しいパスワードを入力してください', 'warning');
        return;
    }
    if (password !== confirmPassword) {
        showAlert('確認用パスワードが一致しません', 'warning');
        return;
    }
    await request('/api/auth/member-password', jsonOptions('POST', { name, part, password }));
    showAlert('パスワードを登録しました。もう一度ログインしてください', 'success');
    showPortalLoginForm();
}

// ポータル入場後の初期表示シーケンス。
// 先に画面骨格を見せ、データは段階的に読み込む。
async function enterPortal() {
    if ($('portalLoginPanel')) $('portalLoginPanel').hidden = true;

    // まずポータルメニューだけを表示し、データ取得待ちによる白画面を避ける。
    await showMemberPanel(false);
    renderPortalHome();
    renderLoadingPlaceholders();
    setLoadingBar('読み込み中...');

    if (!appState.essentialDataLoaded) {
        loadEssentialData()
            .then(() => { appState.essentialDataLoaded = true; })
            .catch((error) => {
                clearLoadingBar();
                showAlert(error.message || 'データの読み込みに失敗しました', 'danger');
            })
            .finally(() => loadFullDataInBackground());
    } else {
        renderEssentialViews();
        loadFullDataInBackground();
    }
}

// 主要ボタンやタブ切り替えのイベントを束ねてバインドする。
function bindNavigation() {
    const brand = document.querySelector('.navbar-brand');
    if (brand) brand.addEventListener('click', (event) => {
        event.preventDefault();
        showMemberPanel();
    });
    if ($('portalDrawerToggle')) $('portalDrawerToggle').addEventListener('click', openPortalDrawer);
    if ($('portalDrawerClose')) $('portalDrawerClose').addEventListener('click', closePortalDrawer);
    if ($('portalDrawerBackdrop')) $('portalDrawerBackdrop').addEventListener('click', closePortalDrawer);
    if ($('sheetViewerBackBtn')) $('sheetViewerBackBtn').addEventListener('click', () => {
        clearSheetViewer();
        showMemberTab('member-sheet');
    });
    if ($('sheetViewerMenuBtn')) $('sheetViewerMenuBtn').addEventListener('click', () => {
        clearSheetViewer();
        showMemberPanel();
    });
    if ($('sheetViewerZoomOut')) $('sheetViewerZoomOut').addEventListener('click', () => zoomSheetViewer(-0.15));
    if ($('sheetViewerZoomIn')) $('sheetViewerZoomIn').addEventListener('click', () => zoomSheetViewer(0.15));
    if ($('sheetViewerFitWidth')) $('sheetViewerFitWidth').addEventListener('click', () => fitSheetViewerWidth());
    if ($('portalManualBtn')) $('portalManualBtn').addEventListener('click', () => {
        closePortalDrawer();
        showMemberTab('member-manual');
    });
    if ($('portalLogoutBtn')) $('portalLogoutBtn').addEventListener('click', logoutPortal);
    if ($('portalReloadBtn')) $('portalReloadBtn').addEventListener('click', () => {
        setLoadingBar('更新中...');
        window.location.reload();
    });

    // ドロワー内ボタンは動的再描画されるため、親要素でイベント委譲して取りこぼしを防ぐ。
    const drawerMenu = $('portalDrawerMenu');
    if (drawerMenu) {
        drawerMenu.addEventListener('click', (event) => {
            const button = event.target.closest('[data-drawer-action]');
            if (!button) return;
            const action = button.dataset.drawerAction;
            if (action === 'manual') {
                closePortalDrawer();
                showMemberTab('member-manual');
                return;
            }
            if (action === 'logout') {
                logoutPortal();
                return;
            }
            if (action === 'reload') {
                setLoadingBar('更新中...');
                window.location.reload();
            }
        });
    }

    document.querySelectorAll('#adminPanel [data-tab]').forEach((button) => {
        button.addEventListener('click', () => switchTab('adminPanel', button.dataset.tab));
    });
    document.querySelectorAll('#memberPanel [data-tab]').forEach((button) => {
        button.addEventListener('click', () => switchTab('memberPanel', button.dataset.tab));
    });
    document.querySelectorAll('#systemPanel [data-tab]').forEach((button) => {
        button.addEventListener('click', () => switchTab('systemPanel', button.dataset.tab));
    });
}

// ログアウト処理。
// 認証情報を破棄し、状態を初期化してログイン画面へ戻す。
function logoutPortal() {
    localStorage.removeItem(PORTAL_AUTH_KEY);
    localStorage.removeItem('userRole');
    appState.portalAuthVerified = false;
    appState.currentUserMemberId = null;
    appState.currentUserName = '';
    appState.currentUserPermission = '';
    appState.currentUserPart = '';
    appState.currentUserIsRecordingManager = false;
    appState.currentUserIsSheetManager = false;
    closePortalDrawer();
    showPortalLogin();
}

// 録音アップロード関連 UI のイベントを設定する。
function bindUpload() {
    const fileInput = $('fileInput');

    $('selectFileBtn').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (event) => handleFiles(event.target.files));
    if ($('memberIntroTopBtn')) $('memberIntroTopBtn').addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
    $('uploadDate').addEventListener('input', updateSavePath);
    if ($('uploadPerformance')) $('uploadPerformance').addEventListener('change', () => renderUploadPieceOptions());
    $('uploadPiece').addEventListener('change', updateSavePath);
    $('uploadBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '保存中...', () => uploadToLocalStore()));
    $('clearBtn').addEventListener('click', clearUploadForm);
}

// 管理画面の各フォーム操作イベントをまとめて設定する。
function bindForms() {
    $('addPerfBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '保存中...', () => savePerformance()));
    $('editPerfBtn').addEventListener('click', clearPerformanceForm);
    $('deletePerfBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', () => deletePerformance()));
    $('addPieceBtn').addEventListener('click', addPerformancePiece);
    if ($('perfFlyerFile')) $('perfFlyerFile').addEventListener('change', previewPerformanceFlyer);
    if ($('savePieceInfoBtn')) $('savePieceInfoBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '保存中...', () => savePieceInfoAdmin()));
    if ($('clearPieceInfoBtn')) $('clearPieceInfoBtn').addEventListener('click', clearPieceInfoForm);
    if ($('deletePieceInfoBtn')) $('deletePieceInfoBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', () => deletePieceInfoAdmin()));
    if ($('pieceInfoPerformance')) $('pieceInfoPerformance').addEventListener('change', updatePieceInfoPieceOptions);
    if ($('savePracticeInstructionBtn')) $('savePracticeInstructionBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '保存中...', () => savePracticeInstructionAdmin()));
    if ($('clearPracticeInstructionBtn')) $('clearPracticeInstructionBtn').addEventListener('click', clearPracticeInstructionForm);
    if ($('deletePracticeInstructionBtn')) $('deletePracticeInstructionBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', () => deletePracticeInstructionAdmin()));
    if ($('practiceInstructionPerformance')) $('practiceInstructionPerformance').addEventListener('change', updatePracticeInstructionPieceOptions);

    $('addSchedBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '保存中...', () => saveSchedule()));
    $('editSchedBtn').addEventListener('click', clearScheduleForm);
    $('deleteSchedBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', () => deleteSchedule()));
    $('schedPerformance').addEventListener('change', () => updateSchedulePieceOptions());

    $('addAnnBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '保存中...', () => saveAnnouncement()));
    $('editAnnBtn').addEventListener('click', clearAnnouncementForm);
    $('deleteAnnBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', () => deleteAnnouncement()));

    $('addEventBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '保存中...', () => saveEvent()));
    $('clearEventBtn').addEventListener('click', clearEventForm);
    $('deleteEventBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', () => deleteEvent()));

    $('addMemberBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '保存中...', () => saveMember()));
    $('clearMemberBtn').addEventListener('click', clearMemberForm);
    $('deleteMemberBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', () => deleteMember()));
    if ($('memberPermission')) $('memberPermission').addEventListener('change', syncMemberPermissionFields);
    syncMemberPermissionFields();

    if ($('paymentMemberId')) $('paymentMemberId').addEventListener('change', () => selectPaymentByMember($('paymentMemberId').value));
    if ($('savePaymentBtn')) $('savePaymentBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '保存中...', () => savePaymentStatus()));
    if ($('clearPaymentBtn')) $('clearPaymentBtn').addEventListener('click', clearPaymentForm);

    if ($('savePartSettingBtn')) $('savePartSettingBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '保存中...', () => savePartSetting()));
    if ($('clearPartSettingBtn')) $('clearPartSettingBtn').addEventListener('click', clearPartSettingForm);
    document.querySelectorAll('.venue-save-by-type-btn').forEach((button) => button.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '保存中...', () => saveVenueSetting(button.dataset.venueType || 'practice'))));
    document.querySelectorAll('.venue-clear-by-type-btn').forEach((button) => button.addEventListener('click', () => clearVenueSettingForm(button.dataset.venueType || 'practice')));
    if ($('saveVenueSettingBtn')) $('saveVenueSettingBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '保存中...', () => saveVenueSetting($('venueUsageType')?.value || 'practice')));
    if ($('clearVenueSettingBtn')) $('clearVenueSettingBtn').addEventListener('click', () => clearVenueSettingForm());
    if ($('saveOrgSettingBtn')) $('saveOrgSettingBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '保存中...', () => saveOrgSetting()));
    if ($('clearOrgSettingBtn')) $('clearOrgSettingBtn').addEventListener('click', clearOrgSettingForm);
    if ($('orgIconFile')) $('orgIconFile').addEventListener('change', previewOrgIcon);
    if ($('saveSnsSettingBtn')) $('saveSnsSettingBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '保存中...', () => saveSnsSetting()));
    if ($('clearSnsSettingBtn')) $('clearSnsSettingBtn').addEventListener('click', clearSnsSettingForm);
    if ($('saveConnectionSettingBtn')) $('saveConnectionSettingBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '保存中...', () => saveConnectionSetting()));
    if ($('clearConnectionSettingBtn')) $('clearConnectionSettingBtn').addEventListener('click', clearConnectionSettingForm);

    if ($('sheetPerformanceSelect')) $('sheetPerformanceSelect').addEventListener('change', updateSheetPieceOptions);
    if ($('uploadSheetBtn')) $('uploadSheetBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '登録中...', () => uploadSheets()));
    
    bindCastingAdminEvents();
}

// 管理者パネル表示要求のガード処理。
// 認証状態と権限を確認してからパネルを開く。
async function requestAdminPanel() {
    if (!(await isPortalAuthenticated())) {
        showPortalLogin();
        return;
    }
    if (!canAccessAdmin()) {
        showAlert('管理者権限がありません', 'warning');
        return;
    }
    showAdminPanel(appState.currentUserPermission === 'システム管理者' ? 'system-admin' : 'admin');
}

// 管理者パネルを表示し、初期タブへ切り替える。
function showAdminPanel(role = 'admin') {
    if ($('portalDrawerToggle')) $('portalDrawerToggle').hidden = false;
    $('adminPanel').hidden = false;
    $('memberPanel').hidden = true;
    if ($('systemPanel')) $('systemPanel').hidden = true;
    localStorage.setItem('userRole', role);
    switchTab('adminPanel', 'performance');
    window.scrollTo({ top: 0, behavior: 'auto' });
}

// システム管理パネルを表示する。
// 事前に必要データを読み込み、最初のタブ状態を整える。
async function showSystemPanel() {
    if (!(await isPortalAuthenticated())) {
        showPortalLogin();
        return;
    }
    if (!canAccessSystemAdmin()) {
        showAlert('システム管理者権限がありません', 'warning');
        return;
    }
    if ($('portalDrawerToggle')) $('portalDrawerToggle').hidden = false;
    $('memberPanel').hidden = true;
    $('adminPanel').hidden = true;
    $('systemPanel').hidden = false;
    localStorage.setItem('userRole', 'system-admin');
    await ensurePartSettingsMigrated();
    await loadAuthManagement();
    renderOrgManagement();
    renderSnsManagement();
    renderConnectionSettingsManagement();
    renderPartManagement();
    switchTab('systemPanel', 'system-auth');
    window.scrollTo({ top: 0, behavior: 'auto' });
}

// 団員パネルの既定タブ（ホーム）を表示する。
async function showMemberPanel(shouldRender = true) {
    await showMemberTab('member-home', shouldRender);
}

// 指定した団員タブを表示する共通入口。
async function showMemberTab(tabName, shouldRender = true) {
    if (!(await isPortalAuthenticated())) {
        showPortalLogin();
        return;
    }
    if (isExtraRestrictedMemberTab(tabName)) {
        tabName = 'member-home';
    }
    if (tabName === 'member-piece-info') {
        appState.selectedPieceInfoId = null;
    }
    if ($('portalDrawerToggle')) $('portalDrawerToggle').hidden = false;
    $('memberPanel').hidden = false;
    $('adminPanel').hidden = true;
    if ($('systemPanel')) $('systemPanel').hidden = true;
    localStorage.setItem('userRole', 'member');
    updateManagerNavigationVisibility();
    if (shouldRender) renderMemberViews();
    switchTab('memberPanel', tabName, shouldRender);
}

// パネル内タブを切り替える共通処理。
// タブ表示と同時に必要な再描画/遅延ロードを行う。
function switchTab(panelId, tabName, renderOnShow = true) {
    if (panelId === 'memberPanel' && isExtraRestrictedMemberTab(tabName)) {
        tabName = 'member-home';
    }
    const panel = $(panelId);
    if (!panel) return;
    const toolbar = panel.querySelector('.toolbar');
    if (toolbar && panelId === 'memberPanel') {
        toolbar.hidden = tabName === 'member-home';
    }
    panel.querySelectorAll('.tab-content').forEach((tab) => {
        tab.hidden = true;
    });
    panel.querySelectorAll('[data-tab]').forEach((button) => {
        button.classList.remove('active');
    });

    const targetId = `${toPascalTab(tabName)}Tab`;
    const target = $(targetId);
    if (target) target.hidden = false;
    const button = panel.querySelector(`[data-tab="${tabName}"]`);
    if (button) button.classList.add('active');
    if (renderOnShow && tabName === 'member-home') renderPortalHome();
    if (renderOnShow && tabName === 'member-manual') renderManualView();
    if (renderOnShow && tabName === 'member-recording') ensureRecordingsLoaded();
    if (renderOnShow && tabName === 'member-sheet') ensureSheetsLoaded();
    if (renderOnShow && tabName === 'member-date-adjustment') renderDateAdjustmentView();
    if (renderOnShow && tabName === 'announcement-detail') renderAnnouncementDetail();
    if (renderOnShow && tabName === 'sheet-admin') ensureSheetsLoaded().then(renderSheetAdmin);
    if (renderOnShow && tabName === 'payment-setting') renderPaymentAdmin();
    if (renderOnShow && tabName === 'venue-admin') renderVenueManagement();
    if (renderOnShow && tabName === 'casting-admin') renderCastingAdmin();
    if (renderOnShow && tabName === 'piece-info-admin') renderPieceInfoAdmin();
    if (renderOnShow && tabName === 'system-org') renderOrgManagement();
    if (renderOnShow && tabName === 'system-sns') renderSnsManagement();
    if (renderOnShow && tabName === 'system-connection') renderConnectionSettingsManagement();
    if (renderOnShow && tabName === 'system-database') renderDatabaseView();
    if (renderOnShow && tabName === 'system-migration') renderMigrationView();
    if (renderOnShow && tabName === 'system-maintenance') renderMaintenanceView();
    
    // 画面上部にスクロール
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// data-tab の識別子を DOM 要素 ID 規則へ変換する。
function toPascalTab(value) {
    const map = {
        upload: 'upload',
        performance: 'performance',
        schedule: 'schedule',
        announcement: 'announcement',
        event: 'event',
        member: 'member',
        'payment-admin': 'paymentAdmin',
        'payment-setting': 'paymentSetting',
        'venue-admin': 'venueAdmin',
        'casting-admin': 'castingAdmin',
        'piece-info-admin': 'pieceInfoAdmin',
        'sheet-admin': 'sheetAdmin',
        'member-home': 'memberHome',
        'member-announce': 'memberAnnounce',
        'member-performance': 'memberPerformance',
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
        'system-database': 'systemDatabase',
        'system-migration': 'systemMigration',
        'system-maintenance': 'systemMaintenance'
    };
    return map[value] || value;
}

// アップロード先パスのプレビュー表示を更新する。
function updateSavePath() {
    if (!$('savePath')) return;
    const date = $('uploadDate').value || today();
    const piece = $('uploadPiece').value.trim() || '未分類';
    $('savePath').textContent = `/converted/${date}/${piece}/`;
}

// 選択された録音ファイルを検証し、状態へ保持する。
function handleFiles(files) {
    const selected = Array.from(files || []);
    if (!selected.length) return;

    const validFiles = selected.filter((file) => {
        const extension = file.name.split('.').pop().toLowerCase();
        return ['mp3', 'm4a'].includes(extension);
    });
    if (validFiles.length !== selected.length) {
        showAlert('MP3 または M4A ファイルを選択してください', 'warning');
    }
    if (!validFiles.length) return;

    appState.selectedFiles = validFiles;
    $('selectedFileName').textContent = selectedFileSummary(validFiles);
    showAlert(`${validFiles.length} 件のファイルを選択しました`, 'success');
}

// 選択済み録音ファイルを順次アップロードする。
// 進捗表示を更新しながら失敗時は途中件数を通知する。
async function uploadToLocalStore() {
    if (!appState.selectedFiles.length) {
        showAlert('先にファイルを選択してください', 'warning');
        return;
    }
    if (!$('uploadPerformance')?.value || !$('uploadPiece')?.value) {
        showAlert('演奏会と曲名を選択してください', 'warning');
        return;
    }

    setOperationStatus('uploadProgress', `録音ファイルを保存しています。0 / ${appState.selectedFiles.length} 件`);
    let completed = 0;
    try {
        for (const file of appState.selectedFiles) {
            setOperationStatus('uploadProgress', `保存中: ${file.name}（${completed + 1} / ${appState.selectedFiles.length} 件）`);
            await request('/api/drive/upload', { method: 'POST', body: audioFormData(file) });
            completed += 1;
            setOperationStatus('uploadProgress', `保存完了: ${completed} / ${appState.selectedFiles.length} 件`);
        }
        showAlert(`${completed} 件の録音ファイルを保存しました`, 'info');
        await loadRecordings();
        setOperationStatus('uploadProgress', `保存が完了しました。${completed} 件の録音ファイルを一覧に反映しました。`);
    } catch (error) {
        setOperationStatus('uploadProgress', `保存に失敗しました。${completed} / ${appState.selectedFiles.length} 件まで完了しています。`, 'danger');
        throw error;
    }
}

// 録音アップロード API 用 FormData を組み立てる。
function audioFormData(file) {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('date', document.getElementById('uploadDate').value);
    formData.append('piece', document.getElementById('uploadPiece').value.trim());
    return formData;
}

function selectedFileSummary(files) {
    if (files.length === 1) {
        const file = files[0];
        return `${file.name} (${formatBytes(file.size)})`;
    }
    const totalSize = files.reduce((sum, file) => sum + file.size, 0);
    return `${files.length} 件選択 (${formatBytes(totalSize)})`;
}

function clearUploadForm() {
    appState.selectedFiles = [];
    $('fileInput').value = '';
    $('selectedFileName').textContent = '未選択';
    $('uploadDate').value = today();
    if ($('uploadPerformance')) $('uploadPerformance').value = '';
    $('uploadPiece').value = '';
    renderUploadPieceOptions();
    const progress = $('uploadProgress');
    if (progress) progress.hidden = true;
    updateSavePath();
}

// 初回表示に必要な最小データだけを先に取得する。
// 演奏会・練習予定・お知らせなど、ホーム表示に直結する内容を優先する。
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
    renderVenueManagement();
    renderPieceInfoAdmin();
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
        castings,
        pieceInfos,
        practiceInstructions,
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
        request('/api/extra/castings'),
        request('/api/extra/piece_infos'),
        request('/api/extra/practice_instructions'),
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
            castings,
            piece_infos: pieceInfos,
            practice_instructions: practiceInstructions,
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
    Object.assign(appState, {
        performances: data.performances || [],
        schedules: data.schedules || [],
        announcements: data.announcements || [],
        events: data.events || [],
        members: data.members || [],
        recordings: data.recordings?.files || appState.recordings || [],
        absences: extras.absences || [],
        eventResponses: extras.event_responses || [],
        dateAdjustments: extras.date_adjustments || [],
        dateAdjustmentResponses: extras.date_adjustment_responses || [],
        sheetLibrary: data.sheets?.files || extras.sheet_library || appState.sheetLibrary || [],
        payments: extras.payments || [],
        castings: extras.castings || [],
        pieceInfos: extras.piece_infos || [],
        practiceInstructions: extras.practice_instructions || [],
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
    renderVenueManagement();
    renderCastingAdmin();
    renderPieceInfoAdmin();
    renderPracticeInstructionAdmin();
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

async function loadRecordings() {
    const data = await request('/api/recordings');
    appState.recordings = data.files || [];
    appState.recordingsLoaded = true;
    renderRecordings();
}

async function loadSheets() {
    const data = await request('/api/sheets');
    appState.sheetLibrary = data.files || [];
    renderSheetAdmin();
    renderSheetLibraryView();
}

async function ensureRecordingsLoaded() {
    if (appState.recordingsLoaded) {
        renderRecordings();
        return;
    }
    ['songTreeMember', 'songTreeAdmin'].forEach((id) => {
        const container = $(id);
        if (container && !container.innerHTML.trim()) container.innerHTML = '<p class="text-muted mb-0">録音一覧を読み込み中です...</p>';
    });
    await loadRecordings();
    appState.recordingsLoaded = true;
    renderRecordings();
}

async function ensureSheetsLoaded() {
    if (appState.sheetsLoaded) {
        renderSheetAdmin();
        renderSheetLibraryView();
        return;
    }
    const container = $('memberSheetInfo');
    if (container && !container.innerHTML.trim()) container.innerHTML = '<p class="text-muted mb-0">楽譜一覧を読み込み中です...</p>';
    await loadSheets();
    appState.sheetsLoaded = true;
}

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
        ['castings', request('/api/extra/castings')],
        ['pieceInfos', request('/api/extra/piece_infos')],
        ['practiceInstructions', request('/api/extra/practice_instructions')],
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
    const castings = resultMap.get('castings') || appState.castings || [];
    const pieceInfos = resultMap.get('pieceInfos') || appState.pieceInfos || [];
    const practiceInstructions = resultMap.get('practiceInstructions') || appState.practiceInstructions || [];
    const desiredPieces = resultMap.get('desiredPieces') || appState.desiredPieces || [];
    const promotions = resultMap.get('promotions') || appState.promotions || [];
    const albums = resultMap.get('albums') || appState.albums || [];
    const partSettings = resultMap.get('partSettings') || appState.partSettings || [];
    const venueSettings = resultMap.get('venueSettings') || appState.venueSettings || [];
    const orgSettings = resultMap.get('orgSettings') || appState.orgSettings || [];
    const snsSettings = resultMap.get('snsSettings') || appState.snsSettings || [];
    const connectionSettings = resultMap.get('connectionSettings') || appState.connectionSettings || [];
    Object.assign(appState, { absences, eventResponses, dateAdjustments, dateAdjustmentResponses, sheetLibrary: sheets.files || [], payments, castings, pieceInfos, practiceInstructions, desiredPieces, promotions, albums, partSettings, venueSettings, orgSettings, snsSettings, connectionSettings });
    refreshPartSelectOptions();
    refreshVenueOptions();
    applyOrgSettings();
    renderMemberExtraViews();
    renderSheetAdmin();
    renderPaymentAdmin();
    renderPartManagement();
    renderVenueManagement();
    renderCastingAdmin();
    renderPieceInfoAdmin();
    renderPracticeInstructionAdmin();
    renderOrgManagement();
    renderSnsManagement();
    renderConnectionSettingsManagement();
}

async function saveExtra(name, payload) {
    return request(`/api/extra/${name}`, jsonOptions('POST', payload));
}

async function savePerformance() {
    const flyerFile = $('perfFlyerFile')?.files?.[0];
    const flyerImage = flyerFile ? await fileToDataUrl(flyerFile) : ($('perfFlyerImage')?.value || '');
    const payload = {
        title: $('perfTitle').value.trim(),
        date: $('perfDate').value,
        open_time: $('perfOpenTime').value,
        start_time: $('perfStartTime').value,
        venue: $('perfVenue').value.trim(),
        conductor: $('perfConductor').value.trim(),
        flyer_image: flyerImage,
        pieces: currentPerformancePieces()
    };
    if (!payload.title || !payload.date) {
        showAlert('タイトルと開催日を入力してください', 'warning');
        return;
    }

    const id = $('perfId').value;
    await request(id ? `/api/performances/${id}` : '/api/performances', jsonOptions(id ? 'PUT' : 'POST', payload));
    clearPerformanceForm();
    await loadPerformances();
    showAlert('演奏会情報を保存しました', 'success');
}

function selectPerformance(id) {
    const item = appState.performances.find((perf) => perf.id === id);
    if (!item) return;
    $('perfId').value = item.id;
    $('perfTitle').value = item.title || '';
    $('perfDate').value = item.date || today();
    $('perfOpenTime').value = item.open_time || '18:00';
    $('perfStartTime').value = item.start_time || '19:00';
    if ($('perfVenue')) $('perfVenue').innerHTML = venueSelectOptionsHtml('performance', item.venue || '');
    $('perfVenue').value = item.venue || '';
    $('perfConductor').value = item.conductor || '';
    if ($('perfFlyerImage')) $('perfFlyerImage').value = item.flyer_image || '';
    renderPerformanceFlyerPreview(item.flyer_image || '');
    if ($('perfFlyerFile')) $('perfFlyerFile').value = '';
    appState.performancePieces = normalizePerformancePieces(item.pieces || []);
    renderPerformancePieceList();
}

async function deletePerformance() {
    const id = $('perfId').value;
    if (!id) {
        showAlert('削除する演奏会を一覧から選択してください', 'warning');
        return;
    }
    if (!confirmDelete()) return;
    await request(`/api/performances/${id}`, { method: 'DELETE' });
    clearPerformanceForm();
    await loadPerformances();
    showAlert('演奏会情報を削除しました', 'success');
}

function clearPerformanceForm() {
    $('perfId').value = '';
    $('perfTitle').value = '';
    $('perfDate').value = today();
    $('perfOpenTime').value = '18:00';
    $('perfStartTime').value = '19:00';
    if ($('perfVenue')) $('perfVenue').innerHTML = venueSelectOptionsHtml('performance', '');
    $('perfVenue').value = '';
    $('perfConductor').value = '';
    if ($('perfFlyerFile')) $('perfFlyerFile').value = '';
    if ($('perfFlyerImage')) $('perfFlyerImage').value = '';
    renderPerformanceFlyerPreview('');
    $('perfPieceComposer').value = '';
    $('perfPieceTitle').value = '';
    if ($('perfPieceAlias')) $('perfPieceAlias').value = '';
    appState.performancePieces = [];
    appState.performancePieceEditIndex = null;
    $('addPieceBtn').textContent = '曲を追加';
    renderPerformancePieceList();
}

function addPerformancePiece() {
    const composer = $('perfPieceComposer').value.trim();
    const title = $('perfPieceTitle').value.trim();
    const alias = $('perfPieceAlias') ? $('perfPieceAlias').value.trim() : '';
    const isEncore = $('perfPieceEncore') ? $('perfPieceEncore').checked : false;
    if (!title) {
        showAlert('曲名を入力してください', 'warning');
        return;
    }

    const piece = { composer, title, alias, is_encore: isEncore };
    if (appState.performancePieceEditIndex !== null) {
        appState.performancePieces[appState.performancePieceEditIndex] = piece;
        appState.performancePieceEditIndex = null;
        $('addPieceBtn').textContent = '曲を追加';
    } else {
        appState.performancePieces.push(piece);
    }
    $('perfPieceComposer').value = '';
    $('perfPieceTitle').value = '';
    if ($('perfPieceAlias')) $('perfPieceAlias').value = '';
    if ($('perfPieceEncore')) $('perfPieceEncore').checked = false;
    renderPerformancePieceList();
}

function editPerformancePiece(index) {
    const piece = appState.performancePieces[index];
    if (!piece) return;
    $('perfPieceComposer').value = piece.composer || '';
    $('perfPieceTitle').value = piece.title || '';
    if ($('perfPieceAlias')) $('perfPieceAlias').value = piece.alias || '';
    if ($('perfPieceEncore')) $('perfPieceEncore').checked = Boolean(piece.is_encore || piece.encore);
    appState.performancePieceEditIndex = index;
    $('addPieceBtn').textContent = '曲を更新';
}

function removePerformancePiece(index) {
    if (!confirmDelete()) return;
    appState.performancePieces.splice(index, 1);
    if (appState.performancePieceEditIndex === index) {
        appState.performancePieceEditIndex = null;
        $('addPieceBtn').textContent = '曲を追加';
        $('perfPieceComposer').value = '';
        $('perfPieceTitle').value = '';
        if ($('perfPieceAlias')) $('perfPieceAlias').value = '';
        if ($('perfPieceEncore')) $('perfPieceEncore').checked = false;
    } else if (appState.performancePieceEditIndex !== null && appState.performancePieceEditIndex > index) {
        appState.performancePieceEditIndex -= 1;
    }
    renderPerformancePieceList();
}

function currentPerformancePieces() {
    const composer = $('perfPieceComposer').value.trim();
    const title = $('perfPieceTitle').value.trim();
    const alias = $('perfPieceAlias') ? $('perfPieceAlias').value.trim() : '';
    const pieces = [...appState.performancePieces];
    if (title) {
        pieces.push({ composer, title, alias, is_encore: $('perfPieceEncore') ? $('perfPieceEncore').checked : false });
    }
    return pieces;
}

function normalizePerformancePieces(pieces) {
    return (pieces || []).map((piece) => {
        if (typeof piece === 'string') {
            return { composer: '', title: piece };
        }
        return {
            composer: piece.composer || '',
            title: piece.title || piece.name || '',
            alias: piece.alias || piece.short_name || '',
            is_encore: Boolean(piece.is_encore || piece.encore)
        };
    }).filter((piece) => piece.title);
}

function performancePieceLabel(piece) {
    if (typeof piece === 'string') return piece;
    // 曲名表示や保存フォルダ名は、登録済みの略称を優先して短く揃える。
    const label = piece.alias || piece.short_name || (piece.composer ? `${piece.composer}: ${piece.title}` : piece.title);
    return (piece.is_encore || piece.encore) ? `(${label})` : label;
}

function performancePieceFormalLabel(piece) {
    if (typeof piece === 'string') return piece;
    // 録音アップロードの選択肢では、略称ではなく登録された正式な曲名を見せる。
    const label = piece.composer ? `${piece.composer}: ${piece.title}` : piece.title;
    return (piece.is_encore || piece.encore) ? `(${label})` : label;
}

function selectedUploadPerformance() {
    const value = $('uploadPerformance')?.value || '';
    if (!value) return null;
    return appState.performances.find((perf) => String(perf.id) === value) || null;
}

function uploadPieceOptions(performance) {
    if (!performance) return [];

    const options = normalizePerformancePieces(performance?.pieces || [])
        .map((piece) => ({
            value: performancePieceLabel(piece),
            label: performancePieceFormalLabel(piece)
        }))
        .filter((option) => option.value);
    options.push({
        value: WHOLE_PRACTICE_RECORDING_PIECE,
        label: WHOLE_PRACTICE_RECORDING_PIECE
    });

    const seen = new Set();
    return options.filter((option) => {
        if (seen.has(option.value)) return false;
        seen.add(option.value);
        return true;
    });
}

function renderUploadPerformanceOptions() {
    const select = $('uploadPerformance');
    if (!select) return;
    const current = select.value;
    select.innerHTML = '<option value="">演奏会を選択</option>' + appState.performances.map((perf) =>
        `<option value="${escapeHtml(String(perf.id))}">${escapeHtml(perf.title || '')}</option>`
    ).join('');
    if ([...select.options].some((option) => option.value === current)) {
        select.value = current;
    }
    renderUploadPieceOptions();
}

function renderUploadPieceOptions() {
    const select = $('uploadPiece');
    if (!select) return;
    const current = select.value;
    const pieces = uploadPieceOptions(selectedUploadPerformance());
    select.innerHTML = pieces.length
        ? '<option value="">曲を選択</option>' + pieces.map((piece) => `<option value="${escapeHtml(piece.value)}">${escapeHtml(piece.label)}</option>`).join('')
        : '<option value="">演奏会に登録済みの曲がありません</option>';
    if (pieces.some((piece) => piece.value === current)) {
        select.value = current;
    }
    updateSavePath();
}

function renderPerformancePieceList() {
    const list = $('perfPieceList');
    list.innerHTML = emptyText(appState.performancePieces, '曲目はまだありません');
    appState.performancePieces.forEach((piece, index) => {
        const item = document.createElement('li');
        item.className = 'list-group-item d-flex justify-content-between align-items-center gap-3';
        item.innerHTML = `
            <span>${escapeHtml(performancePieceLabel(piece))}</span>
            <span class="d-flex gap-2">
                <button class="btn btn-sm btn-outline-primary edit-piece-btn" type="button">編集</button>
                <button class="btn btn-sm btn-outline-danger delete-piece-btn" type="button">削除</button>
            </span>
        `;
        item.querySelector('.edit-piece-btn').addEventListener('click', () => editPerformancePiece(index));
        item.querySelector('.delete-piece-btn').addEventListener('click', () => removePerformancePiece(index));
        list.appendChild(item);
    });
}

async function saveSchedule() {
    const startTime = $('schedStartTime').value;
    const endTime = $('schedEndTime').value;
    const availableStartTime = $('schedAvailableStartTime').value;
    const availableEndTime = $('schedAvailableEndTime').value;
    const selectedPerformance = selectedSchedulePerformance();
    const payload = {
        date: $('schedDate').value,
        time: formatTimeRange(startTime, endTime),
        start_time: startTime,
        end_time: endTime,
        venue: $('schedVenue').value.trim(),
        available_hours: formatTimeRange(availableStartTime, availableEndTime),
        available_start_time: availableStartTime,
        available_end_time: availableEndTime,
        performance_id: selectedPerformance ? selectedPerformance.id : null,
        performance_title: selectedPerformance ? selectedPerformance.title : '未定',
        pieces: selectedSchedulePiecesValue(),
        is_conductor_training: $('schedConductorTraining') ? $('schedConductorTraining').checked : false,
        is_main_performance: $('schedMainPerformance') ? $('schedMainPerformance').checked : false,
        notes: $('schedNotes').value.trim()
    };
    if (!payload.date || !payload.start_time || !payload.end_time) {
        showAlert('練習日と開始時間を入力してください', 'warning');
        return;
    }

    const id = $('schedId').value;
    await request(id ? `/api/schedules/${id}` : '/api/schedules', jsonOptions(id ? 'PUT' : 'POST', payload));
    clearScheduleForm();
    await loadSchedules();
    showAlert('練習予定を保存しました', 'success');
}

function selectSchedule(id) {
    const item = appState.schedules.find((sched) => sched.id === id);
    if (!item) return;
    $('schedId').value = item.id;
    $('schedDate').value = item.date || today();
    const practiceRange = splitTimeRange(item.time);
    const availableRange = splitTimeRange(item.available_hours);
    $('schedStartTime').value = item.start_time || practiceRange.start || '13:00';
    $('schedEndTime').value = item.end_time || practiceRange.end || '16:30';
    if ($('schedVenue')) $('schedVenue').innerHTML = venueSelectOptionsHtml('practice', item.venue || '');
    $('schedVenue').value = item.venue || '';
    $('schedAvailableStartTime').value = item.available_start_time || availableRange.start || '12:30';
    $('schedAvailableEndTime').value = item.available_end_time || availableRange.end || '16:30';
    $('schedPerformance').value = item.performance_id ? String(item.performance_id) : '';
    updateSchedulePieceOptions(item.pieces || '未定');
    if ($('schedConductorTraining')) $('schedConductorTraining').checked = Boolean(item.is_conductor_training);
    if ($('schedMainPerformance')) $('schedMainPerformance').checked = Boolean(item.is_main_performance);
    $('schedNotes').value = item.notes || '';
    $('scheduleTab')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
}


async function deleteSchedule() {
    const id = $('schedId').value;
    if (!id) {
        showAlert('削除する練習予定を一覧から選択してください', 'warning');
        return;
    }
    if (!confirmDelete()) return;
    await request(`/api/schedules/${id}`, { method: 'DELETE' });
    clearScheduleForm();
    await loadSchedules();
    showAlert('練習予定を削除しました', 'success');
}

function clearScheduleForm() {
    $('schedId').value = '';
    $('schedDate').value = today();
    $('schedStartTime').value = '13:00';
    $('schedEndTime').value = '16:30';
    if ($('schedVenue')) $('schedVenue').innerHTML = venueSelectOptionsHtml('practice', '');
    $('schedVenue').value = '';
    $('schedAvailableStartTime').value = '12:30';
    $('schedAvailableEndTime').value = '16:30';
    $('schedPerformance').value = '';
    updateSchedulePieceOptions('未定');
    if ($('schedConductorTraining')) $('schedConductorTraining').checked = false;
    if ($('schedMainPerformance')) $('schedMainPerformance').checked = false;
    $('schedNotes').value = '';
}

function selectedSchedulePerformance() {
    const value = $('schedPerformance').value;
    if (!value) return null;
    return appState.performances.find((perf) => String(perf.id) === value) || null;
}

function renderSchedulePerformanceOptions() {
    const select = $('schedPerformance');
    if (!select) return;
    const current = select.value;
    select.innerHTML = '<option value="">未定</option>' + appState.performances.map((perf) =>
        `<option value="${escapeHtml(perf.id)}">${escapeHtml(perf.title)}</option>`
    ).join('');
    if ([...select.options].some((option) => option.value === current)) {
        select.value = current;
    }
}

function schedulePieceValuesFromText(value) {
    const text = String(value || '').trim();
    if (!text || text === '未定') return [];
    return text.split(/[、,\n]/).map((item) => item.trim()).filter(Boolean);
}

function selectedSchedulePiecesValue() {
    const container = $('schedPieces');
    if (!container) return '未定';
    const values = Array.from(container.querySelectorAll('input[type="checkbox"]:checked'))
        .map((input) => input.value)
        .filter(Boolean);
    return values.length ? values.join('、') : '未定';
}

function updateSchedulePieceOptions(preferredValue = null) {
    const container = $('schedPieces');
    if (!container) return;
    const currentValues = schedulePieceValuesFromText(preferredValue ?? selectedSchedulePiecesValue());
    const performance = selectedSchedulePerformance();
    const performancePieces = performance ? normalizePerformancePieces(performance.pieces || []).map(performancePieceLabel) : [];
    const values = performancePieces.filter((value, index, array) => value && array.indexOf(value) === index);
    if (!values.length) {
        container.innerHTML = '<p class="text-muted small mb-0">選択中の演奏会に登録されている曲がありません。未選択の場合は「未定」になります。</p>';
        return;
    }
    container.innerHTML = values.map((value, index) => {
        const checked = currentValues.includes(value) ? ' checked' : '';
        const id = `schedPieceCheck${index}`;
        return `<label class="form-check mb-1" for="${id}"><input class="form-check-input" type="checkbox" id="${id}" value="${escapeHtml(value)}"${checked}><span class="form-check-label">${escapeHtml(value)}</span></label>`;
    }).join('');
}

function formatTimeRange(start, end) {
    return start && end ? `${start} - ${end}` : start || end || '';
}

function splitTimeRange(value) {
    const match = String(value || '').match(/(\d{1,2}:\d{2})\s*(?:-|〜|~|～)\s*(\d{1,2}:\d{2})/);
    return match ? { start: match[1], end: match[2] } : { start: '', end: '' };
}

function scheduleTimeLabel(sched) {
    return formatTimeRange(sched.start_time, sched.end_time) || sched.time || '';
}

function scheduleAvailableLabel(sched) {
    return formatTimeRange(sched.available_start_time, sched.available_end_time) || sched.available_hours || '';
}

function scheduleCalendarTitle(sched) {
    const pieces = sched.pieces ? ` / ${sched.pieces}` : '';
    return `奏オケ 練習${pieces}`;
}

function scheduleCalendarDetails(sched) {
    return [
        `演奏会: ${schedulePerformanceLabel(sched)}`,
        `練習曲: ${sched.pieces || '未定'}`,
        `練習可能時間: ${scheduleAvailableLabel(sched) || '未定'}`,
        `備考: ${sched.notes || 'なし'}`
    ].join('\n');
}

function addHoursToTime(time, hours) {
    const match = String(time || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return '';
    const date = new Date(2000, 0, 1, Number(match[1]), Number(match[2]));
    date.setHours(date.getHours() + hours);
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function compactCalendarDate(date, time = '') {
    const ymd = String(date || '').replaceAll('-', '');
    if (!ymd) return '';
    if (!time) return ymd;
    return `${ymd}T${String(time).replace(':', '')}00`;
}

function nextAllDayDate(date) {
    if (!date) return '';
    const value = new Date(`${date}T00:00:00`);
    value.setDate(value.getDate() + 1);
    return value.toISOString().slice(0, 10);
}

function googleCalendarUrlForSchedule(sched) {
    const startTime = sched.start_time || splitTimeRange(sched.time).start;
    const endTime = sched.end_time || splitTimeRange(sched.time).end || addHoursToTime(startTime, 2);
    const dates = startTime
        ? `${compactCalendarDate(sched.date, startTime)}/${compactCalendarDate(sched.date, endTime || startTime)}`
        : `${compactCalendarDate(sched.date)}/${compactCalendarDate(nextAllDayDate(sched.date))}`;
    const params = new URLSearchParams({
        action: 'TEMPLATE',
        text: scheduleCalendarTitle(sched),
        dates,
        ctz: 'Asia/Tokyo',
        location: sched.venue || '',
        details: scheduleCalendarDetails(sched)
    });
    return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

function openGoogleCalendarForSchedule(scheduleId) {
    const sched = appState.schedules.find((item) => String(item.id) === String(scheduleId));
    if (!sched) return;
    window.open(googleCalendarUrlForSchedule(sched), '_blank', 'noopener');
}

function icsEscape(value) {
    return String(value || '')
        .replaceAll('\\', '\\\\')
        .replaceAll('\n', '\\n')
        .replaceAll(',', '\\,')
        .replaceAll(';', '\\;');
}

function icsDateTime(date, time = '') {
    const compact = compactCalendarDate(date, time);
    return time ? compact : compact;
}

function scheduleToIcsEvent(sched) {
    const startTime = sched.start_time || splitTimeRange(sched.time).start;
    const endTime = sched.end_time || splitTimeRange(sched.time).end || addHoursToTime(startTime, 2);
    const allDay = !startTime;
    const startKey = allDay ? 'DTSTART;VALUE=DATE' : 'DTSTART;TZID=Asia/Tokyo';
    const endKey = allDay ? 'DTEND;VALUE=DATE' : 'DTEND;TZID=Asia/Tokyo';
    const startValue = allDay ? icsDateTime(sched.date) : icsDateTime(sched.date, startTime);
    const endValue = allDay ? icsDateTime(nextAllDayDate(sched.date)) : icsDateTime(sched.date, endTime || startTime);
    return [
        'BEGIN:VEVENT',
        `UID:kanade-schedule-${sched.id || `${sched.date}-${sched.venue}`}@kanade-portal`,
        `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}`,
        `${startKey}:${startValue}`,
        `${endKey}:${endValue}`,
        `SUMMARY:${icsEscape(scheduleCalendarTitle(sched))}`,
        `LOCATION:${icsEscape(sched.venue || '')}`,
        `DESCRIPTION:${icsEscape(scheduleCalendarDetails(sched))}`,
        'END:VEVENT'
    ].join('\r\n');
}

function downloadSchedulesIcs(schedules) {
    const targets = sortedSchedules(schedules).filter((sched) => sched.date);
    if (!targets.length) {
        showAlert('連携できる練習予定がありません', 'warning');
        return;
    }
    const content = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Kanade Orchestra Portal//Schedule//JA',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        'X-WR-TIMEZONE:Asia/Tokyo',
        ...targets.map(scheduleToIcsEvent),
        'END:VCALENDAR'
    ].join('\r\n');
    downloadTextFile('奏オケ練習予定.ics', content, 'text/calendar;charset=utf-8');
    showAlert('練習予定の一括連携ファイルを作成しました。Googleカレンダーのインポートで読み込めます', 'success');
}

async function saveAnnouncement() {
    const payload = {
        date: $('annDate').value || today(),
        title: $('annTitle') ? $('annTitle').value.trim() : '',
        content: $('annContent').value.trim()
    };
    if (!payload.title && !payload.content) {
        showAlert('お知らせタイトルまたは内容を入力してください', 'warning');
        return;
    }

    const id = $('annId').value;
    await request(id ? `/api/announcements/${id}` : '/api/announcements', jsonOptions(id ? 'PUT' : 'POST', payload));
    clearAnnouncementForm();
    await loadAnnouncements();
    showAlert('お知らせを保存しました', 'success');
}

function selectAnnouncement(id) {
    const item = appState.announcements.find((ann) => ann.id === id);
    if (!item) return;
    $('annId').value = item.id;
    $('annDate').value = item.date || today();
    if ($('annTitle')) $('annTitle').value = item.title || '';
    $('annContent').value = item.content || '';
}

async function deleteAnnouncement() {
    const id = $('annId').value;
    if (!id) {
        showAlert('削除するお知らせを一覧から選択してください', 'warning');
        return;
    }
    if (!confirmDelete()) return;
    await request(`/api/announcements/${id}`, { method: 'DELETE' });
    clearAnnouncementForm();
    await loadAnnouncements();
    showAlert('お知らせを削除しました', 'success');
}

function clearAnnouncementForm() {
    $('annId').value = '';
    $('annDate').value = today();
    if ($('annTitle')) $('annTitle').value = '';
    $('annContent').value = '';
}


async function saveEvent() {
    const payload = {
        title: $('eventTitle').value.trim(),
        date: $('eventDate').value,
        start_time: $('eventStartTime') ? $('eventStartTime').value : '',
        deadline: $('eventDeadline').value,
        url: $('eventUrl').value.trim(),
        notes: $('eventNotes').value.trim(),
        delete_phrase: $('eventDeletePhrase') ? $('eventDeletePhrase').value.trim() : '',
        fee: $('eventFee') ? $('eventFee').value.trim() : ''
    };
    if (!payload.title) {
        showAlert('イベント名を入力してください', 'warning');
        return;
    }

    const id = $('eventId').value;
    await request(id ? `/api/events/${id}` : '/api/events', jsonOptions(id ? 'PUT' : 'POST', payload));
    clearEventForm();
    await loadEvents();
    showAlert('イベント調整を保存しました', 'success');
}

function selectEvent(id) {
    const item = appState.events.find((event) => event.id === id);
    if (!item) return;
    $('eventId').value = item.id;
    $('eventTitle').value = item.title || '';
    $('eventDate').value = item.date || '';
    if ($('eventStartTime')) $('eventStartTime').value = item.start_time || '';
    $('eventDeadline').value = item.deadline || '';
    $('eventUrl').value = item.url || '';
    $('eventNotes').value = item.notes || '';
    if ($('eventDeletePhrase')) $('eventDeletePhrase').value = item.delete_phrase || '';
    if ($('eventFee')) $('eventFee').value = item.fee || '';
}

async function deleteEvent() {
    const id = $('eventId').value;
    if (!id) {
        showAlert('削除するイベントを一覧から選択してください', 'warning');
        return;
    }
    await deleteEventById(id, true);
}

async function deleteEventById(id, adminDelete = false) {
    if (adminDelete && !confirmDelete()) return;
    await request(`/api/events/${id}`, { method: 'DELETE' });
    clearEventForm();
    await loadEvents();
    await loadExtraData();
    showAlert('イベント調整を削除しました', 'success');
}

function clearEventForm() {
    $('eventId').value = '';
    $('eventTitle').value = '';
    $('eventDate').value = '';
    if ($('eventStartTime')) $('eventStartTime').value = '';
    $('eventDeadline').value = '';
    $('eventUrl').value = '';
    $('eventNotes').value = '';
    if ($('eventDeletePhrase')) $('eventDeletePhrase').value = '';
    if ($('eventFee')) $('eventFee').value = '';
}

function sortedEvents(events) {
    return [...(events || [])].sort((a, b) =>
        String(a.date || '').localeCompare(String(b.date || '')) ||
        String(a.start_time || '').localeCompare(String(b.start_time || '')) ||
        String(a.title || '').localeCompare(String(b.title || ''))
    );
}

function eventDateTimeLabel(event) {
    const date = formatDateWithWeekday(event?.date, '未定');
    return event?.start_time ? `${date} ${event.start_time}` : date;
}

async function saveMember() {
    const current = appState.members.find((member) => String(member.id) === String($('memberId').value));
    const photoFile = $('memberPhotoFile')?.files?.[0];
    const photoUrl = photoFile ? await fileToDataUrl(photoFile) : (current?.photo_url || '');
    const password = $('memberPassword') ? $('memberPassword').value : '';
    const lastName = $('memberLastName') ? $('memberLastName').value.trim() : '';
    const firstName = $('memberFirstName') ? $('memberFirstName').value.trim() : '';
    const payload = {
        name: `${lastName}${firstName}`,
        last_name: lastName,
        first_name: firstName,
        maiden_name: $('memberMaidenName') ? $('memberMaidenName').value.trim() : '',
        last_name_kana: $('memberLastNameKana') ? $('memberLastNameKana').value.trim() : '',
        first_name_kana: $('memberFirstNameKana') ? $('memberFirstNameKana').value.trim() : '',
        maiden_name_kana: $('memberMaidenNameKana') ? $('memberMaidenNameKana').value.trim() : '',
        part: $('memberPart').value,
        photo_url: photoUrl,
        is_founder: $('memberIsFounder') ? $('memberIsFounder').checked : false,
        is_recording_manager: $('memberIsRecordingManager') ? $('memberIsRecordingManager').checked : false,
        is_sheet_manager: $('memberIsSheetManager') ? $('memberIsSheetManager').checked : false,
        password: password || current?.password || '',
        permission: $('memberPermission') ? $('memberPermission').value : '一般',
        joined_at: $('memberJoinedAt') ? $('memberJoinedAt').value : '',
        system_access_until: $('memberSystemAccessUntil') ? $('memberSystemAccessUntil').value : '',
        introducer: $('memberIntroducer') ? $('memberIntroducer').value.trim() : '',
        role: $('memberRole') ? $('memberRole').value.trim() : '',
        instrument_history: $('memberInstrumentHistory') ? $('memberInstrumentHistory').value.trim() : '',
        past_orchestras: $('memberPastOrchestras') ? $('memberPastOrchestras').value.trim() : '',
        comment: $('memberComment').value.trim()
    };
    if (!payload.last_name || !payload.first_name) {
        showAlert('姓と名を入力してください', 'warning');
        return;
    }
    if (!payload.part) {
        showAlert('パートを選択してください', 'warning');
        return;
    }
    if (payload.permission === 'エキストラ' && !payload.system_access_until) {
        showAlert('エキストラの場合はシステム利用終了日を入力してください', 'warning');
        return;
    }
    if (payload.permission !== 'エキストラ') {
        payload.system_access_until = '';
    }
    const id = $('memberId').value;
    await request(id ? `/api/members/${id}` : '/api/members', jsonOptions(id ? 'PUT' : 'POST', payload));
    clearMemberForm();
    await loadMembers();
    showAlert('団員情報を保存しました', 'success');
}

function selectMember(id) {
    const item = appState.members.find((member) => member.id === id);
    if (!item) return;
    $('memberId').value = item.id;
    const fallbackName = item.name && !item.last_name && !item.first_name ? item.name : '';
    if ($('memberLastName')) $('memberLastName').value = item.last_name || fallbackName;
    if ($('memberFirstName')) $('memberFirstName').value = item.first_name || '';
    if ($('memberMaidenName')) $('memberMaidenName').value = item.maiden_name || '';
    if ($('memberLastNameKana')) $('memberLastNameKana').value = item.last_name_kana || '';
    if ($('memberFirstNameKana')) $('memberFirstNameKana').value = item.first_name_kana || '';
    if ($('memberMaidenNameKana')) $('memberMaidenNameKana').value = item.maiden_name_kana || '';
    $('memberPart').value = item.part || '';
    if ($('memberPhotoFile')) $('memberPhotoFile').value = '';
    if ($('memberIsFounder')) $('memberIsFounder').checked = Boolean(item.is_founder);
    if ($('memberIsRecordingManager')) $('memberIsRecordingManager').checked = Boolean(item.is_recording_manager);
    if ($('memberIsSheetManager')) $('memberIsSheetManager').checked = Boolean(item.is_sheet_manager);
    if ($('memberPassword')) $('memberPassword').value = item.password || '';
    if ($('memberPermission')) $('memberPermission').value = item.permission || '一般';
    if ($('memberJoinedAt')) $('memberJoinedAt').value = item.joined_at || '';
    if ($('memberSystemAccessUntil')) $('memberSystemAccessUntil').value = item.system_access_until || '';
    if ($('memberIntroducer')) $('memberIntroducer').value = item.introducer || '';
    if ($('memberRole')) $('memberRole').value = item.role || '';
    if ($('memberInstrumentHistory')) $('memberInstrumentHistory').value = item.instrument_history || '';
    if ($('memberPastOrchestras')) $('memberPastOrchestras').value = item.past_orchestras || '';
    $('memberComment').value = item.comment || '';
    syncMemberPermissionFields();
}

async function deleteMember() {
    const id = $('memberId').value;
    if (!id) {
        showAlert('削除する団員を一覧から選択してください', 'warning');
        return;
    }
    if (!confirmDelete()) return;
    await request(`/api/members/${id}`, { method: 'DELETE' });
    clearMemberForm();
    await loadMembers();
    showAlert('団員情報を削除しました', 'success');
}

function clearMemberForm() {
    $('memberId').value = '';
    if ($('memberLastName')) $('memberLastName').value = '';
    if ($('memberFirstName')) $('memberFirstName').value = '';
    if ($('memberMaidenName')) $('memberMaidenName').value = '';
    if ($('memberLastNameKana')) $('memberLastNameKana').value = '';
    if ($('memberFirstNameKana')) $('memberFirstNameKana').value = '';
    if ($('memberMaidenNameKana')) $('memberMaidenNameKana').value = '';
    $('memberPart').value = '';
    if ($('memberPhotoFile')) $('memberPhotoFile').value = '';
    if ($('memberIsFounder')) $('memberIsFounder').checked = false;
    if ($('memberIsRecordingManager')) $('memberIsRecordingManager').checked = false;
    if ($('memberIsSheetManager')) $('memberIsSheetManager').checked = false;
    if ($('memberPassword')) $('memberPassword').value = '';
    if ($('memberPermission')) $('memberPermission').value = '一般';
    if ($('memberJoinedAt')) $('memberJoinedAt').value = '';
    if ($('memberSystemAccessUntil')) $('memberSystemAccessUntil').value = '';
    if ($('memberIntroducer')) $('memberIntroducer').value = '';
    if ($('memberRole')) $('memberRole').value = '';
    if ($('memberInstrumentHistory')) $('memberInstrumentHistory').value = '';
    if ($('memberPastOrchestras')) $('memberPastOrchestras').value = '';
    $('memberComment').value = '';
    syncMemberPermissionFields();
}

function syncMemberPermissionFields() {
    const permission = $('memberPermission')?.value || '一般';
    const accessUntil = $('memberSystemAccessUntil');
    if (!accessUntil) return;
    const isExtra = permission === 'エキストラ';
    accessUntil.disabled = !isExtra;
    accessUntil.required = isExtra;
    if (!isExtra) accessUntil.value = '';
}

function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.addEventListener('load', () => resolve(String(reader.result || '')));
        reader.addEventListener('error', () => reject(reader.error || new Error('画像を読み込めませんでした')));
        reader.readAsDataURL(file);
    });
}

function memberKanaName(member) {
    return `${member?.last_name_kana || ''}${member?.first_name_kana || ''}`;
}

function sortedMembersByPartAndKana(members) {
    return [...(members || [])].sort((a, b) =>
        partSortIndex(a.part) - partSortIndex(b.part) ||
        String(a.part || '').localeCompare(String(b.part || ''), 'ja') ||
        String(memberKanaName(a) || memberDisplayName(a)).localeCompare(String(memberKanaName(b) || memberDisplayName(b)), 'ja') ||
        String(memberDisplayName(a)).localeCompare(String(memberDisplayName(b)), 'ja')
    );
}

function partSortIndex(partName) {
    const index = currentPartNames().indexOf(String(partName || ''));
    return index === -1 ? 9999 : index;
}

function renderMembers() {
    const list = $('memberListItems');
    if (list) {
        list.innerHTML = emptyText(appState.members, '団員情報はまだありません');
        sortedMembersByPartAndKana(appState.members).forEach((member) => {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'list-group-item list-group-item-action';
            item.innerHTML = `
                <div class="d-flex flex-wrap justify-content-between align-items-center gap-2">
                    <strong>${escapeHtml(memberDisplayName(member))}</strong>
                    <span class="d-flex flex-wrap gap-2">
                        <span class="badge text-bg-secondary">${escapeHtml(member.permission || '一般')}</span>
                        ${member.permission === 'エキストラ' ? `<span class="badge text-bg-info">利用終了: ${escapeHtml(member.system_access_until || '未設定')}</span>` : ''}
                        <span class="badge ${member.password ? 'text-bg-success' : 'text-bg-warning'}">パスワード: ${escapeHtml(member.password || '未登録')}</span>
                    </span>
                </div>
            `;
            item.addEventListener('click', () => selectMember(member.id));
            list.appendChild(item);
        });
    }
    if (!appState.suppressDerivedRender) {
        renderMemberIntros();
        renderMemberExtraViews();
    }
}

function renderAuthDevices() {
    const container = $('authDeviceListItems');
    if (!container) return;
    if (!appState.authDevices.length) {
        container.innerHTML = '<p class="text-muted mb-0">認証済み端末はまだありません</p>';
        return;
    }
    container.innerHTML = `<div class="list-group">${appState.authDevices.map((device) => `
        <div class="list-group-item">
            <div class="d-flex flex-wrap justify-content-between gap-2">
                <span>
                    <strong>${escapeHtml(device.device_name || 'Unknown device')}</strong>
                    <div class="small text-muted">ログイン者: ${escapeHtml(device.member_name || 'Unknown')} / ${escapeHtml(device.member_part || 'パート未設定')}</div>
                    <div class="small text-muted">権限: ${escapeHtml(device.permission || '')}</div>
                    <div class="small text-muted">端末ID: ${escapeHtml(device.device_id || '')}</div>
                    <div class="small text-muted">認証日時: ${escapeHtml(formatDateTimeLabel(device.authenticated_at))}</div>
                    <div class="small text-muted">最終確認: ${escapeHtml(formatDateTimeLabel(device.last_seen_at))}</div>
                    ${device.user_agent ? `<div class="small text-muted text-break">${escapeHtml(device.user_agent)}</div>` : ''}
                </span>
                <span><button class="btn btn-sm btn-outline-danger auth-device-delete-btn" type="button" data-device-id="${escapeHtml(device.device_id || '')}">削除</button></span>
            </div>
        </div>
    `).join('')}</div>`;
    container.querySelectorAll('.auth-device-delete-btn').forEach((button) => {
        button.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', () => deleteAuthDevice(button.dataset.deviceId)));
    });
}

async function deleteAuthDevice(deviceId) {
    if (!deviceId) return;
    if (!confirmDelete()) return;
    await request(`/api/auth/devices/${encodeURIComponent(deviceId)}`, { method: 'DELETE' });
    if (deviceId === localStorage.getItem(PORTAL_DEVICE_ID_KEY)) {
        localStorage.removeItem(PORTAL_AUTH_KEY);
        appState.portalAuthVerified = false;
    }
    await loadAuthManagement();
    showAlert('認証端末を削除しました', 'success');
}

function sortedPartSettings() {
    return [...(appState.partSettings || [])].sort((a, b) =>
        Number(a.display_order || 9999) - Number(b.display_order || 9999) ||
        String(a.name || '').localeCompare(String(b.name || ''), 'ja')
    );
}

function currentPartNames() {
    const configured = sortedPartSettings()
        .map((part) => String(part.name || '').trim())
        .filter(Boolean);
    return configured.length ? configured : DEFAULT_MEMBER_PARTS;
}

function partSelectOptionsHtml(selected = '') {
    return ['<option value="">選択してください</option>']
        .concat(currentPartNames().map((part) => `<option value="${escapeHtml(part)}" ${part === selected ? 'selected' : ''}>${escapeHtml(part)}</option>`))
        .join('');
}

function refreshPartSelectOptions() {
    const portalPart = $('portalPartInput');
    if (portalPart) {
        const selected = portalPart.value;
        portalPart.innerHTML = partSelectOptionsHtml(selected);
        if ([...portalPart.options].some((option) => option.value === selected)) portalPart.value = selected;
    }
    const memberPart = $('memberPart');
    if (memberPart) {
        const selected = memberPart.value;
        memberPart.innerHTML = partSelectOptionsHtml(selected);
        if ([...memberPart.options].some((option) => option.value === selected)) memberPart.value = selected;
    }
}

function partMigrationNames() {
    return [...DEFAULT_MEMBER_PARTS, ...appState.members.map((member) => String(member.part || '').trim())]
        .filter((part, index, array) => part && array.indexOf(part) === index);
}

async function ensurePartSettingsMigrated() {
    if ((appState.partSettings || []).length) return;
    const names = partMigrationNames();
    if (!names.length) return;
    for (const [index, name] of names.entries()) {
        await saveExtra('part_settings', { name, display_order: index + 1 });
    }
    await loadExtraData();
}

function renderPartManagement() {
    const list = $('partSettingList');
    if (!list) return;
    const parts = sortedPartSettings();
    list.innerHTML = parts.length
        ? `<div class="list-group">${parts.map((part) => `
            <div class="list-group-item d-flex flex-wrap justify-content-between align-items-center gap-2">
                <div>
                    <strong>${escapeHtml(part.name || '')}</strong>
                </div>
                <div class="d-flex flex-wrap gap-2">
                    <button class="btn btn-sm btn-outline-secondary part-setting-up-btn" type="button" data-part-id="${escapeHtml(String(part.id || ''))}" ${parts.indexOf(part) === 0 ? 'disabled' : ''}>上へ</button>
                    <button class="btn btn-sm btn-outline-secondary part-setting-down-btn" type="button" data-part-id="${escapeHtml(String(part.id || ''))}" ${parts.indexOf(part) === parts.length - 1 ? 'disabled' : ''}>下へ</button>
                    <button class="btn btn-sm btn-outline-primary part-setting-edit-btn" type="button" data-part-id="${escapeHtml(String(part.id || ''))}">編集</button>
                    <button class="btn btn-sm btn-outline-danger part-setting-delete-btn" type="button" data-part-id="${escapeHtml(String(part.id || ''))}">削除</button>
                </div>
            </div>
        `).join('')}</div>`
        : '<div class="alert alert-info mb-0">パート設定を移行中です。表示されない場合は再度システム管理を開いてください。</div>';

    list.querySelectorAll('.part-setting-up-btn').forEach((button) => {
        button.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '移動中...', () => movePartSetting(button.dataset.partId || '', -1)));
    });
    list.querySelectorAll('.part-setting-down-btn').forEach((button) => {
        button.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '移動中...', () => movePartSetting(button.dataset.partId || '', 1)));
    });
    list.querySelectorAll('.part-setting-edit-btn').forEach((button) => {
        button.addEventListener('click', () => selectPartSetting(button.dataset.partId || ''));
    });
    list.querySelectorAll('.part-setting-delete-btn').forEach((button) => {
        button.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', () => deletePartSetting(button.dataset.partId || '')));
    });
}

function selectPartSetting(partId) {
    const part = appState.partSettings.find((item) => String(item.id || '') === String(partId));
    if (!part) return;
    $('partSettingId').value = part.id || '';
    $('partSettingName').value = part.name || '';
}

function clearPartSettingForm() {
    if ($('partSettingId')) $('partSettingId').value = '';
    if ($('partSettingName')) $('partSettingName').value = '';
}

function nextPartDisplayOrder() {
    const maxOrder = Math.max(0, ...appState.partSettings.map((part) => Number(part.display_order || 0)));
    return maxOrder + 1;
}

async function movePartSetting(partId, direction) {
    const parts = sortedPartSettings();
    const index = parts.findIndex((part) => String(part.id || '') === String(partId));
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= parts.length) return;
    const current = parts[index];
    const target = parts[nextIndex];
    await Promise.all([
        request(`/api/extra/part_settings/${encodeURIComponent(current.id)}`, jsonOptions('PUT', {
            ...current,
            display_order: target.display_order || nextIndex + 1
        })),
        request(`/api/extra/part_settings/${encodeURIComponent(target.id)}`, jsonOptions('PUT', {
            ...target,
            display_order: current.display_order || index + 1
        }))
    ]);
    await loadExtraData();
}

async function savePartSetting() {
    const name = $('partSettingName')?.value.trim() || '';
    if (!name) {
        showAlert('パート名を入力してください', 'warning');
        return;
    }
    const duplicate = appState.partSettings.find((part) =>
        String(part.name || '').trim() === name &&
        String(part.id || '') !== String($('partSettingId')?.value || '')
    );
    if (duplicate) {
        showAlert('同じパート名が既に登録されています', 'warning');
        return;
    }
    const id = $('partSettingId')?.value || '';
    const current = appState.partSettings.find((part) => String(part.id || '') === String(id));
    const payload = { name, display_order: current?.display_order || nextPartDisplayOrder() };
    if (id) {
        await request(`/api/extra/part_settings/${encodeURIComponent(id)}`, jsonOptions('PUT', payload));
    } else {
        await saveExtra('part_settings', payload);
    }
    clearPartSettingForm();
    await loadExtraData();
    showAlert('パートを保存しました', 'success');
}

async function deletePartSetting(partId) {
    if (!partId || !confirmDelete()) return;
    await request(`/api/extra/part_settings/${encodeURIComponent(partId)}`, { method: 'DELETE' });
    clearPartSettingForm();
    await loadExtraData();
    showAlert('パートを削除しました', 'success');
}

// ===== データメンテナンス =====

// コレクション名の日本語ラベル
const COLLECTION_LABELS = {
    castings: '乗り番',
    absences: '欠席連絡',
    payments: '支払状況',
    piece_infos: '楽曲情報',
    practice_instructions: '練習指示',
    desired_pieces: '演奏希望曲',
    event_responses: 'イベント回答',
    date_adjustment_responses: '日程調整回答',
};

async function renderMaintenanceView() {
    const scanBtn = $('maintenanceScanBtn');
    const cleanupBtn = $('maintenanceCleanupAllBtn');
    if (scanBtn) {
        scanBtn.onclick = () => withButtonStatus(scanBtn, 'スキャン中...', () => runMaintenanceScan());
    }
    if (cleanupBtn) {
        cleanupBtn.onclick = () => withButtonStatus(cleanupBtn, '削除中...', () => runMaintenanceCleanup());
    }
    // 初期状態にリセット
    const orphanList = $('maintenanceOrphanList');
    if (orphanList) orphanList.innerHTML = '<p class="text-muted">「孤立データをスキャン」ボタンを押してください。</p>';
    if (cleanupBtn) cleanupBtn.disabled = true;
}

async function runMaintenanceScan() {
    const statusEl = $('maintenanceScanStatus');
    const orphanList = $('maintenanceOrphanList');
    const cleanupBtn = $('maintenanceCleanupAllBtn');

    if (statusEl) { statusEl.hidden = false; statusEl.textContent = 'スキャン中...'; }
    if (orphanList) orphanList.innerHTML = '';
    if (cleanupBtn) cleanupBtn.disabled = true;

    let result;
    try {
        result = await request('/api/maintenance/orphans');
    } catch (e) {
        if (statusEl) statusEl.textContent = 'スキャンに失敗しました。';
        showAlert('孤立データのスキャンに失敗しました', 'danger');
        return;
    }

    const orphans = result.orphans || {};
    const total = result.total || 0;

    if (total === 0) {
        if (statusEl) statusEl.textContent = '孤立データは見つかりませんでした。';
        if (orphanList) orphanList.innerHTML = '<p class="text-success fw-bold">すべてのデータは正常です。孤立したデータはありません。</p>';
        if (cleanupBtn) cleanupBtn.disabled = true;
        return;
    }

    if (statusEl) statusEl.textContent = `${total}件の孤立データが見つかりました。削除する項目を選択してください。`;

    // 孤立データをテーブルで表示（チェックボックスで選択可能）
    const html = Object.entries(orphans).map(([collection, items]) => {
        const label = COLLECTION_LABELS[collection] || collection;
        const rows = items.map((item) => {
            const id = item.id ?? '';
            // 表示用サマリーを生成
            const summary = [
                item.performance_id !== undefined ? `演奏会ID: ${item.performance_id}` : null,
                item.member_id !== undefined ? `団員ID: ${item.member_id}` : null,
                item.event_id !== undefined ? `イベントID: ${item.event_id}` : null,
                item.adjustment_id !== undefined ? `調整ID: ${item.adjustment_id}` : null,
                item.schedule_id !== undefined ? `練習ID: ${item.schedule_id}` : null,
                item.title ? `件名: ${item.title}` : null,
                item.piece ? `曲名: ${item.piece}` : null,
                item.name ? `名前: ${item.name}` : null,
            ].filter(Boolean).join(' / ');
            return `<tr>
                <td class="ps-2"><input class="form-check-input maintenance-item-check" type="checkbox" data-collection="${escapeHtml(collection)}" data-id="${escapeHtml(String(id))}" checked></td>
                <td class="text-muted small">${escapeHtml(String(id))}</td>
                <td class="small">${escapeHtml(summary || JSON.stringify(item).slice(0, 60))}</td>
            </tr>`;
        }).join('');
        return `<div class="mb-3">
            <div class="d-flex align-items-center gap-2 mb-1">
                <h6 class="mb-0">${escapeHtml(label)}</h6>
                <span class="badge bg-warning text-dark">${items.length}件</span>
                <button class="btn btn-link btn-sm p-0 text-secondary maintenance-select-all-btn" data-collection="${escapeHtml(collection)}" type="button">全選択/解除</button>
            </div>
            <table class="table table-sm table-bordered mb-0">
                <thead class="table-light"><tr><th style="width:2rem"></th><th style="width:4rem">ID</th><th>内容</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>`;
    }).join('');

    if (orphanList) orphanList.innerHTML = html;
    if (cleanupBtn) cleanupBtn.disabled = false;

    // 全選択/解除ボタン
    document.querySelectorAll('.maintenance-select-all-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            const col = btn.dataset.collection;
            const checkboxes = document.querySelectorAll(`.maintenance-item-check[data-collection="${col}"]`);
            const allChecked = [...checkboxes].every((cb) => cb.checked);
            checkboxes.forEach((cb) => { cb.checked = !allChecked; });
        });
    });
}

async function runMaintenanceCleanup() {
    // チェックされたIDをコレクションごとに収集
    const idMap = {};
    document.querySelectorAll('.maintenance-item-check:checked').forEach((cb) => {
        const col = cb.dataset.collection;
        if (!idMap[col]) idMap[col] = [];
        const rawId = cb.dataset.id;
        // IDが数値なら数値として渡す（バックエンドの型に合わせる）
        idMap[col].push(isNaN(Number(rawId)) ? rawId : Number(rawId));
    });

    if (Object.keys(idMap).length === 0) {
        showAlert('削除する項目が選択されていません', 'warning');
        return;
    }

    const totalSelected = Object.values(idMap).reduce((sum, ids) => sum + ids.length, 0);
    if (!confirm(`選択した ${totalSelected} 件のデータを削除します。\nこの操作は元に戻せません。よろしいですか？`)) return;

    let result;
    try {
        result = await request('/api/maintenance/cleanup', jsonOptions('POST', { ids: idMap }));
    } catch (e) {
        showAlert('削除に失敗しました', 'danger');
        return;
    }

    const totalDeleted = result.total_deleted || 0;
    showAlert(`${totalDeleted}件の孤立データを削除しました`, 'success');
    // 再スキャン
    await runMaintenanceScan();
}

// ===== DB 閲覧 =====

async function renderDatabaseView() {
    const tableSelect = $('databaseTableSelect');
    const pageSizeSelect = $('databasePageSizeSelect');
    const reloadBtn = $('databaseReloadBtn');
    const prevBtn = $('databasePrevBtn');
    const nextBtn = $('databaseNextBtn');

    if (!tableSelect) return;

    if (pageSizeSelect) {
        pageSizeSelect.value = String(appState.databaseLimit || 50);
        pageSizeSelect.onchange = async () => {
            appState.databaseLimit = Number(pageSizeSelect.value || 50) || 50;
            appState.databaseOffset = 0;
            await loadDatabaseRecords();
        };
    }

    tableSelect.onchange = async () => {
        appState.databaseSelectedTable = tableSelect.value || '';
        appState.databaseOffset = 0;
        await loadDatabaseRecords();
    };

    if (reloadBtn) {
        reloadBtn.onclick = () => withButtonStatus(reloadBtn, '更新中...', () => loadDatabaseTablesAndRecords(true));
    }
    if (prevBtn) {
        prevBtn.onclick = async () => {
            appState.databaseOffset = Math.max(0, appState.databaseOffset - appState.databaseLimit);
            await loadDatabaseRecords();
        };
    }
    if (nextBtn) {
        nextBtn.onclick = async () => {
            appState.databaseOffset += appState.databaseLimit;
            await loadDatabaseRecords();
        };
    }

    try {
        await loadDatabaseTablesAndRecords(false);
    } catch (error) {
        const statusEl = $('databaseStatus');
        if (statusEl) {
            statusEl.hidden = false;
            statusEl.textContent = String(error?.message || 'DB情報の取得に失敗しました');
        }
    }
}

async function loadDatabaseTablesAndRecords(forceReload) {
    const statusEl = $('databaseStatus');
    const tableSelect = $('databaseTableSelect');
    if (!tableSelect) return;

    if (statusEl) {
        statusEl.hidden = false;
        statusEl.textContent = 'テーブル一覧を読み込み中...';
    }

    const tableUrl = forceReload ? `/api/system/database/tables?_t=${Date.now()}` : '/api/system/database/tables';
    const result = await request(tableUrl);
    appState.databaseTables = Array.isArray(result.tables) ? result.tables : [];

    const previous = appState.databaseSelectedTable;
    const selected = appState.databaseTables.includes(previous)
        ? previous
        : (appState.databaseTables[0] || '');
    appState.databaseSelectedTable = selected;

    tableSelect.innerHTML = appState.databaseTables.length
        ? appState.databaseTables.map((name) => `<option value="${escapeHtml(name)}" ${name === selected ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('')
        : '<option value="">テーブルがありません</option>';

    if (!selected) {
        if (statusEl) {
            statusEl.textContent = '表示可能なテーブルがありません。';
        }
        clearDatabaseRows();
        return;
    }

    appState.databaseOffset = 0;
    await loadDatabaseRecords(forceReload);
}

function clearDatabaseRows() {
    const head = document.querySelector('#databaseRecordsTable thead');
    const body = document.querySelector('#databaseRecordsTable tbody');
    if (head) head.innerHTML = '';
    if (body) body.innerHTML = '<tr><td class="text-muted">データがありません</td></tr>';
    const prevBtn = $('databasePrevBtn');
    const nextBtn = $('databaseNextBtn');
    if (prevBtn) prevBtn.disabled = true;
    if (nextBtn) nextBtn.disabled = true;
}

async function loadDatabaseRecords(forceReload = false) {
    const statusEl = $('databaseStatus');
    const tableName = appState.databaseSelectedTable;
    if (!tableName) {
        clearDatabaseRows();
        return;
    }

    if (statusEl) {
        statusEl.hidden = false;
        statusEl.textContent = `テーブル ${tableName} を読み込み中...`;
    }

    const query = new URLSearchParams({
        table: tableName,
        limit: String(appState.databaseLimit),
        offset: String(appState.databaseOffset),
    }).toString();
    const recordUrl = forceReload
        ? `/api/system/database/records?${query}&_t=${Date.now()}`
        : `/api/system/database/records?${query}`;
    const result = await request(recordUrl);

    appState.databaseTotal = Number(result.total || 0);
    renderDatabaseRows(result.columns || [], result.rows || []);

    const from = appState.databaseTotal === 0 ? 0 : appState.databaseOffset + 1;
    const to = Math.min(appState.databaseOffset + appState.databaseLimit, appState.databaseTotal);
    if (statusEl) {
        statusEl.textContent = `${tableName}: ${from}-${to} / ${appState.databaseTotal} 件`;
    }

    const prevBtn = $('databasePrevBtn');
    const nextBtn = $('databaseNextBtn');
    if (prevBtn) prevBtn.disabled = appState.databaseOffset <= 0;
    if (nextBtn) nextBtn.disabled = (appState.databaseOffset + appState.databaseLimit) >= appState.databaseTotal;
}

function formatDatabaseCell(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
}

function renderDatabaseRows(columns, rows) {
    const head = document.querySelector('#databaseRecordsTable thead');
    const body = document.querySelector('#databaseRecordsTable tbody');
    if (!head || !body) return;

    if (!columns.length) {
        head.innerHTML = '';
        body.innerHTML = '<tr><td class="text-muted">列情報が取得できませんでした</td></tr>';
        return;
    }

    head.innerHTML = `<tr>${columns.map((column) => `<th class="text-nowrap">${escapeHtml(column)}</th>`).join('')}</tr>`;
    if (!rows.length) {
        body.innerHTML = `<tr><td class="text-muted" colspan="${columns.length}">レコードがありません</td></tr>`;
        return;
    }

    body.innerHTML = rows.map((row) => {
        const cells = columns.map((column) => {
            const value = formatDatabaseCell(row[column]);
            return `<td class="small">${escapeHtml(value)}</td>`;
        }).join('');
        return `<tr>${cells}</tr>`;
    }).join('');
}

// ===== JSON -> DB データ移行 =====

function migrationCleanupSummary(cleanup) {
    if (!cleanup) return '';

    const localFiles = Array.isArray(cleanup.local_files) ? cleanup.local_files : [];
    const cloudObjects = cleanup.cloud_objects || {};
    const cloudCount = Object.values(cloudObjects).reduce(
        (total, objects) => total + (Array.isArray(objects) ? objects.length : 0),
        0
    );
    if (!localFiles.length && !cloudCount) return 'JSON削除: 削除対象はありませんでした。';

    const lines = ['JSON削除: 移行済みデータを削除しました。'];
    if (localFiles.length) {
        lines.push(`ローカルJSON: ${localFiles.join(', ')}`);
    }
    if (cloudCount) {
        lines.push(`Cloud Storage JSON: ${cloudCount}件`);
    }
    return lines.join('\n');
}

async function renderMigrationView() {
    const dryRunBtn = $('migrationDryRunBtn');
    const executeBtn = $('migrationExecuteBtn');
    const outputEl = $('migrationOutput');
    if (dryRunBtn) {
        dryRunBtn.onclick = () => withButtonStatus(dryRunBtn, '実行中...', () => runDataMigration(true));
    }
    if (executeBtn) {
        executeBtn.onclick = () => withButtonStatus(executeBtn, '実行中...', async () => {
            const ok = confirm('DBデータを全削除してJSONから再投入します。\nこの操作は元に戻せません。実行しますか？');
            if (!ok) return;
            await runDataMigration(false);
        });
    }
    if (outputEl && !outputEl.textContent.trim()) {
        outputEl.textContent = '「件数確認（dry-run）」を押してください。';
    }
}

async function runDataMigration(dryRun) {
    const statusEl = $('migrationStatus');
    const outputEl = $('migrationOutput');
    if (statusEl) {
        statusEl.hidden = false;
        statusEl.textContent = dryRun ? '件数確認を実行中...' : 'データ移行を実行中...';
    }

    try {
        const result = await request('/api/system/data-migration', jsonOptions('POST', {
            dry_run: dryRun,
            truncate: !dryRun,
        }));
        if (outputEl) {
            const cleanupSummary = migrationCleanupSummary(result.migration_cleanup);
            outputEl.textContent = [String(result.output || '出力なし'), cleanupSummary].filter(Boolean).join('\n\n');
        }
        const reconciled = result.reconciliation_match;
        if (statusEl) {
            if (!dryRun && reconciled === true) {
                statusEl.textContent = 'データ移行が完了しました（件数照合: 一致）。';
            } else if (!dryRun && reconciled === false) {
                statusEl.textContent = 'データ移行は完了しましたが、件数照合で不一致が見つかりました。';
            } else {
                statusEl.textContent = dryRun ? '件数確認が完了しました。' : 'データ移行が完了しました。';
            }
        }
        if (!dryRun && reconciled === false) {
            showAlert('データ移行は完了しましたが、件数照合で不一致が見つかりました', 'warning');
        } else {
            showAlert(dryRun ? '件数確認が完了しました' : 'データ移行が完了しました', 'success');
        }
        if (!dryRun) {
            await loadEssentialData();
            await loadExtraData();
            renderMemberViews();
        }
    } catch (error) {
        if (statusEl) {
            statusEl.textContent = dryRun ? '件数確認に失敗しました。' : 'データ移行に失敗しました。';
        }
        if (outputEl) {
            outputEl.textContent = String(error?.message || '通信に失敗しました');
        }
    }
}

function sortedVenueSettings() {
    return [...(appState.venueSettings || [])].sort((a, b) =>
        String(a.name || '').localeCompare(String(b.name || ''), 'ja')
    );
}

function venueSettingsFor(kind) {
    return sortedVenueSettings().filter((venue) => {
        if (kind === 'performance') return venue.for_performance !== false;
        if (kind === 'practice') return venue.for_practice !== false;
        return true;
    });
}

function venueSelectOptionsHtml(kind, selected = '') {
    const normalizedSelected = String(selected || '');
    const venues = venueSettingsFor(kind);
    const options = ['<option value="">選択してください</option>'];
    options.push(...venues.map((venue) => {
        const name = String(venue.name || '');
        return `<option value="${escapeHtml(name)}" ${name === normalizedSelected ? 'selected' : ''}>${escapeHtml(name)}</option>`;
    }));
    if (normalizedSelected && !venues.some((venue) => String(venue.name || '') === normalizedSelected)) {
        options.push(`<option value="${escapeHtml(normalizedSelected)}" selected>${escapeHtml(normalizedSelected)}（未登録会場）</option>`);
    }
    return options.join('');
}

function refreshVenueOptions() {
    const performanceSelect = $('perfVenue');
    if (performanceSelect) {
        performanceSelect.innerHTML = venueSelectOptionsHtml('performance', performanceSelect.value);
    }
    const practiceSelect = $('schedVenue');
    if (practiceSelect) {
        practiceSelect.innerHTML = venueSelectOptionsHtml('practice', practiceSelect.value);
    }
}

function venueInputId(kind) {
    return kind === 'performance' ? 'venuePerformanceName' : 'venuePracticeName';
}

function renderVenueManagement() {
    renderVenueListByType('performance', 'venuePerformanceList');
    renderVenueListByType('practice', 'venuePracticeList');
}

function renderVenueListByType(kind, listId) {
    const list = $(listId);
    if (!list) return;
    const venues = venueSettingsFor(kind);
    list.innerHTML = venues.length
        ? `<div class="list-group">${venues.map((venue) => `
            <div class="list-group-item d-flex flex-wrap justify-content-between align-items-center gap-2">
                <strong>${escapeHtml(venue.name || '')}</strong>
                <span class="d-flex gap-2">
                    <button class="btn btn-sm btn-outline-primary venue-setting-edit-btn" type="button" data-venue-type="${kind}" data-venue-id="${escapeHtml(String(venue.id || ''))}">編集</button>
                    <button class="btn btn-sm btn-outline-danger venue-setting-delete-btn" type="button" data-venue-id="${escapeHtml(String(venue.id || ''))}">削除</button>
                </span>
            </div>
        `).join('')}</div>`
        : '<p class="text-muted mb-0">会場はまだ登録されていません</p>';
    list.querySelectorAll('.venue-setting-edit-btn').forEach((button) => {
        button.addEventListener('click', () => selectVenueSetting(button.dataset.venueId || '', button.dataset.venueType || kind));
    });
    list.querySelectorAll('.venue-setting-delete-btn').forEach((button) => {
        button.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', () => deleteVenueSetting(button.dataset.venueId || '')));
    });
}

function selectVenueSetting(venueId, kind = '') {
    const venue = appState.venueSettings.find((item) => String(item.id || '') === String(venueId));
    if (!venue) return;
    const type = kind || (venue.for_performance ? 'performance' : 'practice');
    if ($('venueSettingId')) $('venueSettingId').value = venue.id || '';
    if ($('venueUsageType')) $('venueUsageType').value = type;
    const input = $(venueInputId(type));
    if (input) input.value = venue.name || '';
}

function clearVenueSettingForm(kind = '') {
    if ($('venueSettingId')) $('venueSettingId').value = '';
    if (kind) {
        const input = $(venueInputId(kind));
        if (input) input.value = '';
        if ($('venueUsageType')) $('venueUsageType').value = kind;
        return;
    }
    if ($('venuePerformanceName')) $('venuePerformanceName').value = '';
    if ($('venuePracticeName')) $('venuePracticeName').value = '';
    if ($('venueUsageType')) $('venueUsageType').value = 'performance';
}

async function saveVenueSetting(kind = 'practice') {
    const input = $(venueInputId(kind));
    const name = input?.value.trim() || '';
    if (!name) {
        showAlert('会場名を入力してください', 'warning');
        return;
    }
    const forPractice = kind === 'practice';
    const forPerformance = kind === 'performance';
    const id = $('venueUsageType')?.value === kind ? ($('venueSettingId')?.value || '') : '';
    const duplicate = appState.venueSettings.find((venue) =>
        String(venue.name || '').trim() === name &&
        String(venue.id || '') !== String(id)
    );
    if (duplicate) {
        showAlert('同じ会場名が既に登録されています', 'warning');
        return;
    }
    const payload = { name, for_practice: forPractice, for_performance: forPerformance, note: '' };
    if (id) await request(`/api/extra/venue_settings/${encodeURIComponent(id)}`, jsonOptions('PUT', payload));
    else await saveExtra('venue_settings', payload);
    clearVenueSettingForm(kind);
    await loadExtraData();
    showAlert('会場を保存しました', 'success');
}

async function deleteVenueSetting(venueId) {
    if (!venueId || !confirmDelete()) return;
    await request(`/api/extra/venue_settings/${encodeURIComponent(venueId)}`, { method: 'DELETE' });
    clearVenueSettingForm();
    await loadExtraData();
    showAlert('会場を削除しました', 'success');
}

function currentOrgSetting() {
    return (appState.orgSettings || [])[0] || {};
}

function orgShortName() {
    const org = currentOrgSetting();
    return String(
        org.short_name
        || org.shortName
        || org.organization_abbreviation
        || org.organizationAbbreviation
        || org.organization_name
        || org.organizationName
        || org.organization_name_full
        || org.organizationNameFull
        || '楽団'
    ).trim() || '楽団';
}

function portalTitleText() {
    return `${orgShortName()}ポータル`;
}

function applyOrgSettings() {
    const org = currentOrgSetting();
    const title = portalTitleText();
    document.title = title;
    const titleElement = document.querySelector('title');
    if (titleElement) titleElement.textContent = title;
    document.querySelectorAll('meta[name="application-name"], meta[name="apple-mobile-web-app-title"]').forEach((meta) => {
        meta.setAttribute('content', title);
    });
    if ($('portalBrandTitle')) $('portalBrandTitle').textContent = title;
    if ($('portalLoginTitle')) $('portalLoginTitle').textContent = title;
    const iconUrl = org.icon_url || org.iconUrl || '';
    if (iconUrl) {
        document.querySelectorAll('link[rel="icon"], link[rel="apple-touch-icon"]').forEach((link) => {
            link.href = iconUrl;
        });
        if ($('portalLogo')) $('portalLogo').src = iconUrl;
        if ($('orgIconPreview')) $('orgIconPreview').src = iconUrl;
    }
    const logo = $('portalLogo');
    if (logo) logo.alt = orgShortName();
    applyDynamicManifest(title, title, org.icon_url || org.iconUrl || '');
}

function applyDynamicManifest(name, shortName, iconUrl = '') {
    const manifestLink = document.querySelector('link[rel="manifest"]');
    if (!manifestLink) return;
    const icons = [
        { src: iconUrl || '/static/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: iconUrl || '/static/icons/icon-512.png', sizes: '512x512', type: 'image/png' }
    ];
    const manifest = {
        name,
        short_name: shortName,
        start_url: '/',
        display: 'standalone',
        background_color: '#ffffff',
        theme_color: '#235789',
        icons
    };
    if (appState.manifestObjectUrl) {
        URL.revokeObjectURL(appState.manifestObjectUrl);
    }
    appState.manifestObjectUrl = URL.createObjectURL(new Blob([JSON.stringify(manifest)], { type: 'application/manifest+json' }));
    manifestLink.href = appState.manifestObjectUrl;
}

function updateCloudRunRevision() {
    // Google Cloud Run のリビジョン情報をUI に反映
    const revisionLabel = currentRevisionText();
    const revisionElements = [
        $('revisionNumber'),
        ...document.querySelectorAll('[data-revision-number]')
    ].filter(Boolean);
    revisionElements.forEach((element) => {
        element.textContent = revisionLabel;
    });
}

function currentRevisionText() {
    return cloudRunRevisionLabel(appState.cloudRunRevision) || '取得中';
}

async function loadCloudRunRevision() {
    try {
        const data = await requestJson('/api/revision', { cache: 'no-store' });
        appState.cloudRunRevision = data.cloudRunRevision || '';
        updateCloudRunRevision();
    } catch (error) {
        console.warn('Cloud Run revision fetch failed', error);
        updateCloudRunRevision();
    }
}

function cloudRunRevisionLabel(revision) {
    const value = String(revision || '').trim();
    if (!value) return '';
    const match = value.match(/(?:^|-)(\d{5}-[a-z0-9]+)$/i);
    return match ? match[1] : value;
}

function renderOrgManagement() {
    const org = currentOrgSetting();
    if ($('orgSettingId')) $('orgSettingId').value = org.id || '';
    if ($('orgName')) $('orgName').value = org.name || '';
    if ($('orgShortName')) $('orgShortName').value = org.short_name || org.shortName || '';
    if ($('orgIconFile')) $('orgIconFile').value = '';
    if ($('orgIconPreview')) $('orgIconPreview').src = org.icon_url || org.iconUrl || '/static/icons/icon-192.png';
}

async function previewOrgIcon() {
    const file = $('orgIconFile')?.files?.[0];
    if (!file || !$('orgIconPreview')) return;
    $('orgIconPreview').src = await fileToDataUrl(file);
}

function clearOrgSettingForm() {
    if ($('orgSettingId')) $('orgSettingId').value = currentOrgSetting().id || '';
    if ($('orgName')) $('orgName').value = '';
    if ($('orgShortName')) $('orgShortName').value = '';
    if ($('orgIconFile')) $('orgIconFile').value = '';
    if ($('orgIconPreview')) $('orgIconPreview').src = currentOrgSetting().icon_url || '/static/icons/icon-192.png';
}

async function saveOrgSetting() {
    const current = currentOrgSetting();
    const name = $('orgName')?.value.trim() || '';
    const shortName = $('orgShortName')?.value.trim() || '';
    if (!name || !shortName) {
        showAlert('団体名と略称を入力してください', 'warning');
        return;
    }
    const iconFile = $('orgIconFile')?.files?.[0];
    const iconUrl = iconFile ? await fileToDataUrl(iconFile) : (current.icon_url || current.iconUrl || '');
    const payload = {
        name,
        short_name: shortName,
        icon_url: iconUrl
    };
    if (current.id) {
        await request(`/api/extra/org_settings/${encodeURIComponent(current.id)}`, jsonOptions('PUT', payload));
    } else {
        await saveExtra('org_settings', payload);
    }
    await loadExtraData();
    showAlert('団体情報を保存しました', 'success');
}

function currentSnsSetting() {
    return (appState.snsSettings || [])[0] || {};
}

function renderSnsManagement() {
    const sns = currentSnsSetting();
    if ($('snsSettingId')) $('snsSettingId').value = sns.id || '';
    if ($('snsFacebookUrl')) $('snsFacebookUrl').value = sns.facebook_url || '';
    if ($('snsInstagramUrl')) $('snsInstagramUrl').value = sns.instagram_url || '';
    if ($('snsXUrl')) $('snsXUrl').value = sns.x_url || '';
    if ($('snsYoutubeUrl')) $('snsYoutubeUrl').value = sns.youtube_url || '';
}

function clearSnsSettingForm() {
    if ($('snsFacebookUrl')) $('snsFacebookUrl').value = '';
    if ($('snsInstagramUrl')) $('snsInstagramUrl').value = '';
    if ($('snsXUrl')) $('snsXUrl').value = '';
    if ($('snsYoutubeUrl')) $('snsYoutubeUrl').value = '';
}

async function saveSnsSetting() {
    const current = currentSnsSetting();
    const payload = {
        facebook_url: $('snsFacebookUrl')?.value.trim() || '',
        instagram_url: $('snsInstagramUrl')?.value.trim() || '',
        x_url: $('snsXUrl')?.value.trim() || '',
        youtube_url: $('snsYoutubeUrl')?.value.trim() || ''
    };
    if (current.id) {
        await request(`/api/extra/sns_settings/${encodeURIComponent(current.id)}`, jsonOptions('PUT', payload));
    } else {
        await saveExtra('sns_settings', payload);
    }
    await loadExtraData();
    showAlert('SNS情報を保存しました', 'success');
}

function currentConnectionSetting() {
    return (appState.connectionSettings || [])[0] || {};
}

function renderConnectionSettingsManagement() {
    const current = currentConnectionSetting();
    if ($('connectionSettingId')) $('connectionSettingId').value = current.id || '';
    if ($('connectionGoogleProjectId')) $('connectionGoogleProjectId').value = current.google_project_id || '';
    if ($('connectionBucketName')) $('connectionBucketName').value = current.google_cloud_storage_bucket || '';
    if ($('connectionDataPrefix')) $('connectionDataPrefix').value = current.google_cloud_storage_data_prefix || 'app-data';
    if ($('connectionPublicFlag')) $('connectionPublicFlag').checked = String(current.google_cloud_storage_public || '').toLowerCase() === 'true';
    if ($('connectionServiceAccountFile')) $('connectionServiceAccountFile').value = current.google_service_account_file || '';
    if ($('connectionServiceAccountJson')) $('connectionServiceAccountJson').value = current.google_service_account_json || '';
}

function clearConnectionSettingForm() {
    if ($('connectionGoogleProjectId')) $('connectionGoogleProjectId').value = '';
    if ($('connectionBucketName')) $('connectionBucketName').value = '';
    if ($('connectionDataPrefix')) $('connectionDataPrefix').value = 'app-data';
    if ($('connectionPublicFlag')) $('connectionPublicFlag').checked = false;
    if ($('connectionServiceAccountFile')) $('connectionServiceAccountFile').value = '';
    if ($('connectionServiceAccountJson')) $('connectionServiceAccountJson').value = '';
}

async function saveConnectionSetting() {
    const current = currentConnectionSetting();
    const bucket = $('connectionBucketName')?.value.trim() || '';
    if (!bucket) {
        showAlert('GCSバケット名を入力してください', 'warning');
        return;
    }

    const payload = {
        google_project_id: $('connectionGoogleProjectId')?.value.trim() || '',
        google_cloud_storage_bucket: bucket,
        google_cloud_storage_data_prefix: $('connectionDataPrefix')?.value.trim() || 'app-data',
        google_cloud_storage_public: $('connectionPublicFlag')?.checked ? 'true' : 'false',
        google_service_account_file: $('connectionServiceAccountFile')?.value.trim() || '',
        google_service_account_json: $('connectionServiceAccountJson')?.value.trim() || ''
    };

    if (current.id) {
        await request(`/api/extra/connection_settings/${encodeURIComponent(current.id)}`, jsonOptions('PUT', payload));
    } else {
        await saveExtra('connection_settings', payload);
    }
    await loadExtraData();
    showAlert('接続先情報を保存しました', 'success');
}

function renderSnsView() {
    const container = $('memberSnsInfo');
    if (!container) return;
    const sns = currentSnsSetting();
    const links = [
        { label: 'Facebook', url: sns.facebook_url },
        { label: 'Instagram', url: sns.instagram_url },
        { label: 'X', url: sns.x_url }
    ];
    container.innerHTML = `
        <div class="d-flex flex-wrap gap-2">
            ${links.map((item) => item.url
                ? `<a class="btn btn-outline-primary btn-lg sns-link-button" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.label)}</a>`
                : `<button class="btn btn-outline-secondary btn-lg sns-link-button" type="button" disabled>${escapeHtml(item.label)}</button>`
            ).join('')}
        </div>
    `;
}

function renderConcertRecordView() {
    const container = $('memberConcertRecordInfo');
    if (!container) return;
    const youtubeUrl = currentSnsSetting().youtube_url || '';
    container.innerHTML = youtubeUrl
        ? `<a class="btn btn-outline-primary btn-lg sns-link-button" href="${escapeHtml(youtubeUrl)}" target="_blank" rel="noopener noreferrer">YouTube</a>`
        : '<p class="text-muted mb-0">YouTubeリンクはまだ登録されていません</p>';
}

function renderMemberIntros() {
    const container = $('memberIntroInfo');
    if (!container) return;
    if (!appState.members.length) {
        container.innerHTML = '<p class="text-muted mb-0">団員情報はまだありません</p>';
        return;
    }
    const grouped = groupBy(sortedMembersByPartAndKana(appState.members), 'part');
    const entries = Object.entries(grouped);
    const nav = `<div class="member-part-nav mb-3">${entries.map(([part]) => {
        const id = `intro-part-${cssSafeId(part || 'none')}`;
        return `<a class="btn btn-sm btn-outline-primary" href="#${escapeHtml(id)}">${escapeHtml(part || '未設定')}</a>`;
    }).join('')}</div>`;
    container.innerHTML = nav + entries.map(([part, members]) => {
        const sectionId = `intro-part-${cssSafeId(part || 'none')}`;
        return `
        <section class="mb-4" id="${escapeHtml(sectionId)}">
            <h5>${escapeHtml(part || '未設定')}</h5>
            <div class="row g-3">${members.map((member) => `
                <div class="col-md-6 col-xl-4"><div class="card h-100"><div class="card-body member-intro-card-body">
                    ${member.photo_url ? `<img src="${escapeHtml(member.photo_url)}" alt="${escapeHtml(memberDisplayName(member))}" class="member-photo" loading="lazy">` : ''}
                    <div class="member-intro-text mt-2">
                        <h6 class="mb-1">${escapeHtml(memberDisplayName(member))}${member.is_founder ? '<span class="badge text-bg-info ms-2">創設メンバー</span>' : ''}</h6>
                        ${memberKanaName(member) ? `<div class="small text-muted">${escapeHtml(memberKanaName(member))}</div>` : ''}
                        <div class="small text-muted">${escapeHtml(member.part || '')}</div>
                        ${member.joined_at ? `<div class="small mt-2"><strong>入団:</strong> ${escapeHtml(member.joined_at)}</div>` : ''}
                        ${member.introducer ? `<div class="small"><strong>紹介者:</strong> ${escapeHtml(member.introducer)}</div>` : ''}
                        ${member.role ? `<div class="small"><strong>役割:</strong> ${escapeHtml(member.role)}</div>` : ''}
                        ${member.instrument_history ? `<div class="small mt-2 multiline-text"><strong>楽器歴:</strong><br>${escapeHtml(member.instrument_history)}</div>` : ''}
                        ${member.past_orchestras ? `<div class="small mt-2 multiline-text"><strong>過去所属オケ:</strong><br>${escapeHtml(member.past_orchestras)}</div>` : ''}
                        ${member.comment ? `<div class="small mt-2 multiline-text member-comment"><strong>コメント:</strong><br>${escapeHtml(member.comment)}</div>` : ''}
                    </div>
                    ${String(member.id || '') === String(appState.currentUserMemberId || '') ? `<div class="mt-3"><button class="btn btn-sm btn-outline-primary member-profile-edit-btn" type="button" data-member-id="${escapeHtml(String(member.id || ''))}">編集</button></div>` : ''}
                </div></div></div>`).join('')}</div>
        </section>`;
    }).join('');
    container.querySelectorAll('.member-profile-edit-btn').forEach((button) => {
        button.addEventListener('click', () => showOwnProfileEditForm(button.dataset.memberId || ''));
    });
}

function cssSafeId(value) {
    return encodeURIComponent(String(value || 'none')).replace(/%/g, '');
}

function showOwnProfileEditForm(memberId) {
    const member = appState.members.find((item) => String(item.id || '') === String(memberId));
    const container = $('memberIntroInfo');
    if (!member || !container || String(member.id || '') !== String(appState.currentUserMemberId || '')) {
        showAlert('編集できるプロフィールが見つかりません', 'warning');
        return;
    }
    container.innerHTML = `
        <div class="card">
            <div class="card-header d-flex flex-wrap justify-content-between align-items-center gap-2">
                <span>プロフィール編集</span>
                <button class="btn btn-sm btn-outline-secondary" id="profileEditCancelBtn" type="button">戻る</button>
            </div>
            <div class="card-body">
                <div class="row g-3">
                    <div class="col-md-4">
                        <label class="form-label" for="profilePhotoFile">プロフィール写真</label>
                        <input type="file" class="form-control" id="profilePhotoFile" accept="image/*">
                    </div>
                    <div class="col-md-4">
                        <label class="form-label" for="profileJoinedAt">入団年月</label>
                        <input type="month" class="form-control" id="profileJoinedAt" value="${escapeHtml(member.joined_at || '')}">
                    </div>
                    <div class="col-md-4">
                        <label class="form-label" for="profileIntroducer">紹介者</label>
                        <input type="text" class="form-control" id="profileIntroducer" value="${escapeHtml(member.introducer || '')}">
                    </div>
                    <div class="col-12">
                        <label class="form-label" for="profileRole">役割</label>
                        <input type="text" class="form-control" id="profileRole" value="${escapeHtml(member.role || '')}">
                    </div>
                    <div class="col-md-6">
                        <label class="form-label" for="profileInstrumentHistory">楽器歴</label>
                        <textarea class="form-control" id="profileInstrumentHistory" rows="4">${escapeHtml(member.instrument_history || '')}</textarea>
                    </div>
                    <div class="col-md-6">
                        <label class="form-label" for="profilePastOrchestras">過去所属オケ</label>
                        <textarea class="form-control" id="profilePastOrchestras" rows="4">${escapeHtml(member.past_orchestras || '')}</textarea>
                    </div>
                    <div class="col-12">
                        <label class="form-label" for="profileComment">コメント</label>
                        <textarea class="form-control" id="profileComment" rows="4">${escapeHtml(member.comment || '')}</textarea>
                    </div>
                </div>
                <div class="d-flex flex-wrap gap-2 mt-3">
                    <button class="btn btn-primary" id="profileSaveBtn" type="button">保存</button>
                    <button class="btn btn-outline-secondary" id="profileEditCancelBtnBottom" type="button">キャンセル</button>
                </div>
            </div>
        </div>
    `;
    $('profileSaveBtn')?.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '保存中...', () => saveOwnProfile(member.id)));
    $('profileEditCancelBtn')?.addEventListener('click', renderMemberIntros);
    $('profileEditCancelBtnBottom')?.addEventListener('click', renderMemberIntros);
}

async function saveOwnProfile(memberId) {
    const current = appState.members.find((item) => String(item.id || '') === String(memberId));
    if (!current || String(current.id || '') !== String(appState.currentUserMemberId || '')) {
        showAlert('編集できるプロフィールが見つかりません', 'warning');
        return;
    }
    const photoFile = $('profilePhotoFile')?.files?.[0];
    const photoUrl = photoFile ? await fileToDataUrl(photoFile) : (current.photo_url || '');
    const payload = {
        ...current,
        photo_url: photoUrl,
        joined_at: $('profileJoinedAt')?.value || '',
        introducer: $('profileIntroducer')?.value.trim() || '',
        role: $('profileRole')?.value.trim() || '',
        instrument_history: $('profileInstrumentHistory')?.value.trim() || '',
        past_orchestras: $('profilePastOrchestras')?.value.trim() || '',
        comment: $('profileComment')?.value.trim() || ''
    };
    await request(`/api/members/${encodeURIComponent(memberId)}`, jsonOptions('PUT', payload));
    await loadMembers();
    showAlert('プロフィールを保存しました', 'success');
}

function renderEvents() {
    const list = $('eventListItems');
    if (!list) return;
    list.innerHTML = emptyText(appState.events, 'イベント調整はまだありません');
    sortedEvents(appState.events).forEach((event) => {
        const item = document.createElement('div');
        item.className = 'list-group-item list-group-item-action';
        item.innerHTML = `
            <div class="d-flex flex-wrap justify-content-between gap-2">
                <span>
                    <strong>${escapeHtml(event.title)}</strong>
                    <div class="small text-muted">開催日: ${escapeHtml(eventDateTimeLabel(event))} / 回答期限: ${escapeHtml(formatDateWithWeekday(event.deadline))}${event.fee ? ` / 会費: ${escapeHtml(event.fee)}` : ''}</div>
                    <div class="small text-muted">削除時の合言葉: ${escapeHtml(event.delete_phrase || '未設定')}</div>
                </span>
                <span>
                    <button class="btn btn-sm btn-outline-danger admin-event-delete-btn" type="button">削除</button>
                </span>
            </div>
            ${event.notes ? `<div class="small multiline-text mt-1">${escapeHtml(event.notes)}</div>` : ''}
            ${event.url ? `<div class="small text-truncate">${escapeHtml(event.url)}</div>` : ''}
        `;
        item.addEventListener('click', () => selectEvent(event.id));
        item.querySelector('.admin-event-delete-btn').addEventListener('click', (clickEvent) => {
            clickEvent.preventDefault();
            clickEvent.stopPropagation();
            withButtonStatus(clickEvent.currentTarget, '削除中...', () => deleteEventById(event.id, true));
        });
        list.appendChild(item);
    });
    if (!appState.suppressDerivedRender) renderMemberEventView();
}

function renderPerformances() {
    const list = $('perfListItems');
    list.innerHTML = emptyText(appState.performances, '演奏会情報はまだありません');
    appState.performances.forEach((perf) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'list-group-item list-group-item-action';
        item.innerHTML = `
            <strong>${escapeHtml(perf.title)}</strong>
            <div class="small text-muted">${escapeHtml(formatDateWithWeekday(perf.date))} / ${escapeHtml(perf.venue || '会場未定')} / 指揮: ${escapeHtml(perf.conductor || '未定')}</div>
        `;
        item.addEventListener('click', () => selectPerformance(perf.id));
        list.appendChild(item);
    });
    if (!appState.suppressDerivedRender) {
        renderMemberPerformances();
        renderMemberSchedules();
        renderSchedulePerformanceOptions();
        updateSchedulePieceOptions();
        renderPortalHome();
    }
}

function renderSchedules() {
    const container = $('schedListItems');
    if (!appState.schedules.length) {
        container.innerHTML = '<p class="text-muted mb-0">練習予定はまだありません</p>';
        if (!appState.suppressDerivedRender) renderMemberSchedules();
        return;
    }
    container.innerHTML = `
        <div class="table-responsive">
            <table class="table table-sm align-middle">
                <thead><tr><th>日付</th><th>時間</th><th>場所</th><th>演奏会</th><th>曲</th><th>備考</th></tr></thead>
                <tbody></tbody>
            </table>
        </div>
    `;
    const body = container.querySelector('tbody');
    sortedSchedules(appState.schedules).forEach((sched) => {
        const row = document.createElement('tr');
        row.className = 'clickable-row';
        row.innerHTML = `
            <td>${escapeHtml(formatDateWithWeekday(sched.date))}</td>
            <td>${escapeHtml(scheduleTimeLabel(sched))}</td>
            <td>${escapeHtml(sched.venue || '')}</td>
            <td>${escapeHtml(schedulePerformanceLabel(sched))}</td>
            <td>${escapeHtml(sched.pieces || '')}</td>
            <td>${escapeHtml(sched.notes || '')}</td>
        `;
        row.addEventListener('click', () => selectSchedule(sched.id));
        body.appendChild(row);
    });
    if (!appState.suppressDerivedRender) renderMemberSchedules();
}

function renderAnnouncements() {
    const admin = $('annListItems');
    const member = $('memberAnnList');
    admin.innerHTML = emptyText(appState.announcements, 'お知らせはまだありません');
    member.innerHTML = emptyText(appState.announcements, 'お知らせはまだありません');
    appState.announcements.forEach((ann) => {
        const adminItem = announcementItem(ann, true);
        const memberItem = announcementItem(ann, false);
        admin.appendChild(adminItem);
        member.appendChild(memberItem);
    });
    if (!appState.suppressDerivedRender) renderPortalHome();
}

function announcementItem(ann, selectable) {
    const item = document.createElement(selectable ? 'button' : 'li');
    item.className = selectable
        ? 'list-group-item list-group-item-action'
        : 'list-group-item list-group-item-action';
    if (selectable) item.type = 'button';
    else item.style.cursor = 'pointer';
    
    // 団員向け（selectable=false）は日付とタイトルのみ表示
    if (!selectable) {
        item.innerHTML = `<div><span class="small text-muted">${escapeHtml(formatDateWithWeekday(ann.date))}</span> <strong>${escapeHtml(ann.title || '')}</strong></div>`;
        item.addEventListener('click', () => {
            appState.portalSelectedAnnouncementId = ann.id;
            showMemberTab('announcement-detail');
        });
    } else {
        // 管理者向け（selectable=true）は内容も表示
        item.innerHTML = `<div><span class="small text-muted">${escapeHtml(formatDateWithWeekday(ann.date))}</span> <strong>${escapeHtml(ann.title || '')}</strong></div>${ann.content ? `<div class="mt-1">${escapeHtml(ann.content)}</div>` : ''}`;
        item.addEventListener('click', () => selectAnnouncement(ann.id));
    }
    return item;
}

function renderAnnouncementDetail() {
    const header = $('annDetailHeader');
    const content = $('annDetailContent');
    if (!header || !content) return;
    
    const ann = appState.announcements.find((a) => a.id === appState.portalSelectedAnnouncementId);
    if (!ann) {
        header.textContent = 'お知らせ詳細';
        content.innerHTML = '<p class="text-muted">お知らせが見つかりません</p>';
        return;
    }
    
    header.textContent = `${escapeHtml(formatDateWithWeekday(ann.date))} ${escapeHtml(ann.title || '')}`;
    content.innerHTML = `
        <div class="d-flex flex-wrap gap-2 mb-3">
            <button class="btn btn-sm btn-outline-secondary" id="annDetailBackBtn" type="button">ポータルメニューに戻る</button>
        </div>
        <div>${escapeHtml(ann.content || 'コンテンツなし')}</div>
    `;
    $('annDetailBackBtn')?.addEventListener('click', () => {
        appState.portalSelectedAnnouncementId = null;
        showMemberTab('member-home');
    });
}

function renderRecordings() {
    renderRecordingList('songTreeAdmin', true);
    renderRecordingList('songTreeMember', false);
}

function renderRecordingList(containerId, canDelete) {
    const container = $(containerId);
    if (!appState.recordings.length) {
        container.innerHTML = '<p class="text-muted mb-0">録音ファイルはまだありません</p>';
        return;
    }

    const grouped = groupRecordingsByDateAndPiece(appState.recordings);
    const latestDate = grouped[0]?.date || '';
    container.innerHTML = '';
    if (!canDelete) {
        const controls = document.createElement('div');
        controls.className = 'recording-controls';
        controls.innerHTML = `
            <label class="form-check recording-continuous-check">
                <input class="form-check-input" id="continuousPlaybackCheck" type="checkbox" ${appState.continuousPlayback ? 'checked' : ''}>
                <span class="form-check-label">連続再生</span>
            </label>
        `;
        controls.querySelector('#continuousPlaybackCheck').addEventListener('change', (event) => {
            appState.continuousPlayback = event.currentTarget.checked;
        });
        container.appendChild(controls);
    }
    grouped.forEach((dateGroup) => {
        const dateOpen = canDelete || dateGroup.date === latestDate;
        const dateDetails = document.createElement('details');
        dateDetails.className = 'recording-date-group';
        dateDetails.open = dateOpen;
            dateDetails.innerHTML = `
                <summary class="recording-summary recording-date-summary">
                    <span>${escapeHtml(formatDateWithWeekday(dateGroup.date, '未分類'))}</span>
                    ${canDelete ? '<button class="btn btn-sm btn-outline-danger recording-bulk-delete-btn" type="button">練習日を一括削除</button>' : `<a class="btn btn-sm btn-primary recording-bulk-download-btn" href="${escapeHtml(recordingZipUrl(dateGroup.date, ''))}">練習日一括DL</a>`}
                </summary>
            `;
        if (canDelete) {
            dateDetails.querySelector('.recording-bulk-delete-btn').addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                withButtonStatus(event.currentTarget, '削除中...', () => deleteRecordingGroup(dateGroup.pieces.flatMap((pieceGroup) => pieceGroup.files), `${formatDateWithWeekday(dateGroup.date, '未分類')} の録音`));
            });
        } else {
            dateDetails.querySelectorAll('.recording-bulk-download-btn').forEach((link) => {
                link.addEventListener('click', (event) => event.stopPropagation());
            });
        }
        dateGroup.pieces.forEach((pieceGroup) => {
            const pieceDetails = document.createElement('details');
            pieceDetails.className = 'recording-piece-group';
            pieceDetails.open = canDelete || dateGroup.date === latestDate;
                pieceDetails.innerHTML = `
                <summary class="recording-summary recording-piece-summary">
                    <span>${escapeHtml(pieceGroup.piece || '未分類')}</span>
                    ${canDelete ? '<button class="btn btn-sm btn-outline-danger recording-bulk-delete-btn" type="button">曲を一括削除</button>' : `<a class="btn btn-sm btn-outline-primary recording-bulk-download-btn" href="${escapeHtml(recordingZipUrl(dateGroup.date, pieceGroup.piece))}">曲一括DL</a>`}
                </summary>
            `;
            if (canDelete) {
                pieceDetails.querySelector('.recording-bulk-delete-btn').addEventListener('click', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    withButtonStatus(event.currentTarget, '削除中...', () => deleteRecordingGroup(pieceGroup.files, `${formatDateWithWeekday(dateGroup.date, '未分類')} / ${pieceGroup.piece || '未分類'} の録音`));
                });
            }
            if (!canDelete) {
                pieceDetails.querySelectorAll('.recording-bulk-download-btn').forEach((link) => {
                    link.addEventListener('click', (event) => event.stopPropagation());
                });
            }
            const list = document.createElement('div');
            list.className = 'list-group mb-3';
            if (!canDelete && dateGroup.date === latestDate) {
                pieceDetails.classList.add('files-collapsed');
                list.hidden = true;
                const summary = pieceDetails.querySelector('summary');
                summary.addEventListener('click', (event) => {
                    event.preventDefault();
                    list.hidden = !list.hidden;
                    pieceDetails.open = true;
                    pieceDetails.classList.toggle('files-collapsed', list.hidden);
                });
            }
            pieceGroup.files.forEach((file) => {
                list.appendChild(recordingFileItem(file, canDelete));
            });
            pieceDetails.appendChild(list);
            dateDetails.appendChild(pieceDetails);
        });
        container.appendChild(dateDetails);
    });
}

function recordingZipUrl(date = '', piece = '') {
    const params = new URLSearchParams();
    if (date) params.set('date', date);
    if (piece) params.set('piece', piece);
    return `/api/recordings/download-zip?${params.toString()}`;
}

function groupRecordingsByDateAndPiece(recordings) {
    const dates = new Map();
    [...recordings]
        .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(a.piece || '').localeCompare(String(b.piece || '')) || String(a.name || '').localeCompare(String(b.name || '')))
        .forEach((file) => {
            const date = file.date || '未分類';
            const piece = file.piece || '未分類';
            if (!dates.has(date)) dates.set(date, new Map());
            if (!dates.get(date).has(piece)) dates.get(date).set(piece, []);
            dates.get(date).get(piece).push(file);
        });
    return Array.from(dates.entries()).map(([date, pieces]) => ({
        date,
        pieces: Array.from(pieces.entries()).map(([piece, files]) => ({ piece, files }))
    }));
}

function recordingFileItem(file, canDelete) {
    const item = document.createElement('div');
    item.className = 'list-group-item recording-list-item';
    const playUrl = file.play_url || file.download_url;
    const downloadUrl = file.download_url || playUrl;
    item.recordingPlayUrl = playUrl;
    item.recordingCanDelete = canDelete;
    const actionButton = canDelete
        ? '<button class="btn btn-sm btn-outline-danger delete-recording-btn" type="button">削除</button>'
        : `<a class="btn btn-sm btn-primary" href="${escapeHtml(downloadUrl)}">DL</a>`;
    item.innerHTML = `
        <div class="recording-row">
            <span class="recording-meta">
                <strong class="recording-file-name">${escapeHtml(displayNameWithoutExtension(file.name))}</strong>
                <span class="recording-duration">${formatDurationLabel(file)}</span>
            </span>
            <span class="recording-actions">
                <button class="btn btn-sm btn-outline-primary play-recording-btn" type="button">再生</button>
                ${actionButton}
            </span>
        </div>
        <div class="recording-player-area mt-2"></div>
    `;
    bindRecordingFileItem(item, file, playUrl, canDelete);
    if (canDelete) {
        item.querySelector('.delete-recording-btn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', () => deleteRecording(file)));
    }
    return item;
}

function bindRecordingFileItem(item, file, playUrl, canDelete) {
    const playButton = item.querySelector('.play-recording-btn');
    playButton.disabled = !playUrl;
    if (!playUrl) return;
    playButton.addEventListener('click', () => toggleRecordingPlayback(item));
}

async function toggleRecordingPlayback(item) {
    const audio = appState.currentAudio;
    if (audio && appState.currentRecordingItem === item && !audio.paused) {
        stopCurrentRecording();
        return;
    }
    await startRecordingPlayback(item);
}

async function startRecordingPlayback(item) {
    const playUrl = item?.recordingPlayUrl;
    const playButton = item?.querySelector('.play-recording-btn');
    const playerArea = item?.querySelector('.recording-player-area');
    if (!playUrl || !playButton || !playerArea) return false;

    const audio = ensureRecordingAudio();
    const previousItem = appState.currentRecordingItem;
    if (previousItem && previousItem !== item) {
        resetRecordingItemPlaybackUi(previousItem);
    }

    try {
        // 連続再生では同じ audio 要素を移動して使い回し、スマホのバックグラウンド再生を継続しやすくする。
        if (audio.parentElement !== playerArea) {
            playerArea.innerHTML = '';
            playerArea.appendChild(audio);
        }
        audio.hidden = true;
        audio.dataset.switchingTrack = '1';
        audio.src = withCacheBuster(playUrl);
        audio.load();
        appState.currentAudio = audio;
        appState.currentPlayButton = playButton;
        appState.currentRecordingItem = item;
        await audio.play();
        audio.dataset.switchingTrack = '';
        audio.hidden = false;
        playButton.textContent = '停止';
        return true;
    } catch (error) {
        audio.dataset.switchingTrack = '';
        clearCurrentRecordingAudio(audio);
        showAlert(`再生できませんでした: ${error.message}`, 'danger');
        return false;
    }
}

function ensureRecordingAudio() {
    if (appState.currentAudio) return appState.currentAudio;

    const audio = document.createElement('audio');
    audio.controls = true;
    audio.preload = 'auto';
    audio.playsInline = true;
    audio.className = 'w-100';
    audio.hidden = true;
    audio.addEventListener('pause', () => {
        if (audio.ended || audio.dataset.switchingTrack === '1') return;
        clearCurrentRecordingAudio(audio);
    });
    audio.addEventListener('ended', async () => {
        const finishedItem = appState.currentRecordingItem;
        resetRecordingItemPlaybackUi(finishedItem);
        if (finishedItem && !finishedItem.recordingCanDelete && appState.continuousPlayback) {
            const started = await playNextRecording(finishedItem);
            if (started) return;
        }
        clearCurrentRecordingAudio(audio);
    });
    audio.addEventListener('error', () => {
        showAlert('音声ファイルを読み込めませんでした。再デプロイ後の場合は更新して再試行してください。', 'danger');
        clearCurrentRecordingAudio(audio);
    });
    appState.currentAudio = audio;
    return audio;
}

function resetRecordingItemPlaybackUi(item) {
    if (!item) return;
    const button = item.querySelector('.play-recording-btn');
    const area = item.querySelector('.recording-player-area');
    if (button) button.textContent = '再生';
    if (area) area.innerHTML = '';
}

function clearCurrentRecordingAudio(audio = appState.currentAudio) {
    resetRecordingItemPlaybackUi(appState.currentRecordingItem);
    if (audio?.parentElement) {
        audio.parentElement.innerHTML = '';
    }
    appState.currentAudio = null;
    appState.currentPlayButton = null;
    appState.currentRecordingItem = null;
}

function stopCurrentRecording(exceptAudio = null) {
    const audio = appState.currentAudio;
    if (audio && audio !== exceptAudio) {
        audio.pause();
        try {
            audio.currentTime = 0;
        } catch {
            // Some streaming sources cannot seek until enough data has loaded.
        }
        resetRecordingItemPlaybackUi(appState.currentRecordingItem);
    }
    if (audio !== exceptAudio) {
        appState.currentAudio = null;
        appState.currentPlayButton = null;
        appState.currentRecordingItem = null;
    }
}

async function playNextRecording(currentItem) {
    const items = Array.from(document.querySelectorAll('#songTreeMember .recording-list-item'));
    const currentIndex = items.indexOf(currentItem);
    for (let index = currentIndex + 1; index < items.length; index += 1) {
        const nextItem = items[index];
        const nextButton = nextItem?.querySelector('.play-recording-btn:not(:disabled)');
        if (nextButton) {
            return startRecordingPlayback(nextItem);
        }
    }
    return false;
}

function withCacheBuster(url) {
    if (!url) return url;
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}t=${Date.now()}`;
}

async function deleteRecording(file) {
    if (!confirmDelete()) return;

    await deleteRecordingFile(file);
    await loadRecordings();
    showAlert('録音ファイルを削除しました', 'success');
}

async function deleteRecordingGroup(files, label) {
    const targets = (files || []).filter(Boolean);
    if (!targets.length) return;
    if (!confirmDelete()) return;

    for (const file of targets) {
        await deleteRecordingFile(file);
    }
    await loadRecordings();
    showAlert(`${targets.length}件の録音ファイルを削除しました`, 'success');
}

async function deleteRecordingFile(file) {
    await request('/api/recordings', jsonOptions('DELETE', {
        source: file.source || 'local',
        object_name: file.object_name || file.id || '',
        path: file.path || ''
    }));
}

function renderMemberViews() {
    renderMemberPerformances();
    renderMemberSchedules();
    renderAnnouncements();
    renderRecordings();
    renderMemberIntros();
    renderPortalHome();
    renderMemberExtraViews({ includeHeavyLists: false });
}

function renderPortalHome() {
    const announceContainer = $('portalHomeAnnouncements');
    const countdownContainer = $('portalHomeCountdown');
    const menuContainer = $('portalHomeMenu');
    if (!announceContainer || !countdownContainer || !menuContainer) return;

    const announcements = [...(appState.announcements || [])]
        .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
        .slice(0, 5);
    announceContainer.innerHTML = announcements.length
        ? '<div class="list-group" id="portalHomeAnnouncementList"></div>'
        : '<p class="text-muted mb-0">お知らせはまだありません</p>';
    const announcementList = $('portalHomeAnnouncementList');
    if (announcementList) {
        announcements.forEach((ann) => {
            announcementList.appendChild(announcementItem(ann, false));
        });
    }

    const nextPerf = nextPerformance();
    const countdown = nextPerf ? daysUntil(nextPerf.date) : null;
    countdownContainer.innerHTML = nextPerf && countdown !== null
        ? `<section class="portal-countdown-card">
            <div class="portal-countdown-main">本番まであと${Math.max(0, countdown)}日！</div>
            <div class="portal-countdown-sub">${escapeHtml(nextPerf.title || '')} / ${escapeHtml(formatDateWithWeekday(nextPerf.date, ''))}</div>
        </section>`
        : `<section class="portal-countdown-card muted">
            <div class="portal-countdown-main">演奏会情報はまだありません</div>
            <div class="portal-countdown-sub">管理メニューから演奏会情報を登録してください</div>
        </section>`;

    renderMenuGroups(menuContainer);
}

function nextPerformance() {
    const upcoming = [...(appState.performances || [])]
        .filter((perf) => perf.date && perf.date >= today())
        .sort((a, b) => String(a.date).localeCompare(String(b.date)));
    return upcoming[0] || null;
}

function renderMemberPerformances() {
    const container = $('memberPerfInfo');
    if (!appState.performances.length) {
        container.innerHTML = '<p class="text-muted mb-0">演奏会情報はまだありません</p>';
        return;
    }
    const nextPerf = nextPerformance() || [...appState.performances].filter((perf) => perf.date).sort((a, b) => String(a.date).localeCompare(String(b.date)))[0];
    const countdown = nextPerf ? daysUntil(nextPerf.date) : null;
    container.innerHTML = `${nextPerf && countdown !== null ? `<div class="countdown-banner">本番まであと${countdown}日！</div>` : ''}` + appState.performances.map((perf) => `
        <article class="info-block">
            <h5>${escapeHtml(perf.title)}</h5>
            <p>${escapeHtml(formatDateWithWeekday(perf.date))} ${escapeHtml(perf.open_time)}開場 / ${escapeHtml(perf.start_time)}開演</p>
            <p>${escapeHtml(perf.venue || '会場未定')} / 指揮: ${escapeHtml(perf.conductor || '未定')}</p>
            ${perf.flyer_image ? `<div class="mb-3"><img src="${escapeHtml(perf.flyer_image)}" alt="チラシ画像" class="performance-flyer-preview" loading="lazy"></div>` : ''}
            <div class="mb-0">${(perf.pieces || []).map((piece) => `<div>${escapeHtml(performancePieceLabel(piece))}</div>`).join('')}</div>
        </article>
    `).join('');
}

function renderMemberSchedules() {
    const container = $('memberSchedInfo');
    const upcoming = sortedSchedules(appState.schedules).filter((sched) => !sched.date || sched.date >= today());
    if (!upcoming.length) {
        container.innerHTML = '<p class="text-muted mb-0">練習予定はまだありません</p>';
        return;
    }
    const grouped = groupSchedulesByPerformance(upcoming);
    container.innerHTML = `
        <div class="d-flex flex-wrap justify-content-end gap-2 mb-3">
            <button class="btn btn-outline-success btn-sm" id="scheduleBulkCalendarBtn" type="button">予定を一括連携</button>
        </div>
        ${grouped.map((group) => `
        <details class="schedule-performance-group" open>
            <summary class="schedule-performance-summary">
                <span class="schedule-performance-title">${escapeHtml(group.title)}</span>
            </summary>
            ${group.schedules.map((sched) => `
                <article class="info-block schedule-card ${scheduleIsMainPerformance(sched) ? 'schedule-card-main-performance' : ''}">
                    <div class="schedule-main-line schedule-date-line">
                        <span>${escapeHtml(formatScheduleDate(sched.date))}</span>
                        ${scheduleIsConductorTraining(sched) ? '<span class="schedule-conductor-training">※指揮トレ</span>' : ''}
                    </div>
                    <div class="schedule-main-line">${escapeHtml(scheduleTimeLabel(sched) || '時間未定')}</div>
                    <div class="schedule-main-line">${escapeHtml(sched.venue || '場所未定')}</div>
                    <div class="schedule-detail-line">練習可能時間: ${escapeHtml(scheduleAvailableLabel(sched) || '未定')}</div>
                    <div class="schedule-detail-line">練習曲: ${escapeHtml(sched.pieces || '未定')}</div>
                    <div class="schedule-detail-line multiline-text">備考: ${escapeHtml(sched.notes || 'なし')}</div>
                    <div class="schedule-action-row">
                        <button class="btn btn-outline-success btn-sm" type="button" data-google-calendar="${escapeHtml(String(sched.id))}">Googleカレンダー連携</button>
                    </div>
                </article>
            `).join('')}
        </details>
    `).join('')}
    `;
    $('scheduleBulkCalendarBtn')?.addEventListener('click', () => downloadSchedulesIcs(upcoming));
    container.querySelectorAll('[data-google-calendar]').forEach((button) => {
        button.addEventListener('click', () => openGoogleCalendarForSchedule(button.dataset.googleCalendar));
    });
}

function sortedSchedules(schedules) {
    return [...(schedules || [])].sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')) || String(scheduleTimeLabel(a)).localeCompare(String(scheduleTimeLabel(b))));
}

function groupSchedulesByPerformance(schedules) {
    const groups = new Map();
    schedules.forEach((sched) => {
        const key = sched.performance_id ? `performance-${sched.performance_id}` : `title-${schedulePerformanceLabel(sched)}`;
        if (!groups.has(key)) {
            const performance = appState.performances.find((perf) => String(perf.id) === String(sched.performance_id));
            groups.set(key, {
                title: performance ? performance.title : schedulePerformanceLabel(sched),
                performanceId: performance?.id || sched.performance_id || null,
                date: performance?.date || '',
                schedules: []
            });
        }
        groups.get(key).schedules.push(sched);
    });
    return Array.from(groups.values())
        .sort(compareSchedulePerformanceGroups)
        .map((group) => ({
            ...group,
            schedules: sortedSchedules(group.schedules)
        }));
}

function compareSchedulePerformanceGroups(a, b) {
    const aUndecided = schedulePerformanceGroupIsUndecided(a);
    const bUndecided = schedulePerformanceGroupIsUndecided(b);
    if (aUndecided !== bUndecided) return aUndecided ? 1 : -1;

    const aHasDate = Boolean(a.date);
    const bHasDate = Boolean(b.date);
    if (aHasDate !== bHasDate) return aHasDate ? -1 : 1;

    return String(a.date || '').localeCompare(String(b.date || ''))
        || String(a.title || '').localeCompare(String(b.title || ''));
}

function schedulePerformanceGroupIsUndecided(group) {
    return !group.performanceId && (!group.title || group.title === '未定');
}

function schedulePerformance(sched) {
    if (!sched || !sched.performance_id) return null;
    return appState.performances.find((perf) => String(perf.id) === String(sched.performance_id)) || null;
}

function scheduleIsConductorTraining(sched) {
    return Boolean(sched?.is_conductor_training);
}

function scheduleIsMainPerformance(sched) {
    return Boolean(sched?.is_main_performance);
}

function formatScheduleDate(dateText) {
    return formatDateWithWeekday(dateText);
}

function formatDateWithWeekday(dateText, fallback = '未定') {
    if (!dateText) return fallback;
    const date = new Date(`${dateText}T00:00:00`);
    if (Number.isNaN(date.getTime())) return dateText;
    const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
    const formattedDate = dateText.replace(/-/g, '/');
    return `${formattedDate}（${weekdays[date.getDay()]}）`;
}

function formatDateTimeLabel(value) {
    if (!value) return '未記録';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    const dateText = date.toISOString().slice(0, 10);
    const timeText = date.toTimeString().slice(0, 5);
    return `${formatDateWithWeekday(dateText)} ${timeText}`;
}

function schedulePerformanceLabel(sched) {
    if (sched.performance_title) return sched.performance_title;
    if (sched.performance_id) {
        const performance = appState.performances.find((perf) => String(perf.id) === String(sched.performance_id));
        if (performance) return performance.title;
    }
    return '未定';
}

function daysUntil(dateText) {
    const target = new Date(`${dateText}T00:00:00`);
    const base = new Date(`${today()}T00:00:00`);
    if (Number.isNaN(target.getTime())) return null;
    return Math.ceil((target - base) / 86400000);
}

function formatDurationLabel(file) {
    if (file.duration) return file.duration;
    if (file.duration_seconds || file.duration_seconds === 0) {
        const total = Math.round(Number(file.duration_seconds));
        const minutes = Math.floor(total / 60);
        const seconds = total % 60;
        return `${minutes}:${String(seconds).padStart(2, '0')}`;
    }
    return '長さ未取得';
}

// 団員向けタブは 1 つずつ個別描画せず、この関数からまとめて再描画する。
// 重い一覧は options で抑制でき、初期表示時の体感速度を落とさないようにしている。
function renderMemberExtraViews(options = {}) {
    const includeHeavyLists = options.includeHeavyLists !== false;
    renderAbsenceView();
    if (includeHeavyLists) renderSheetLibraryView();
    renderPracticeInstructionView();
    renderPaymentView();
    renderCastingView();
    renderMemberEventView();
    renderDateAdjustmentView();
    renderPieceInfoView();
    renderDesiredPieceView();
    renderManualView();
    renderPromotionView();
    renderAlbumView();
    renderConcertRecordView();
    renderSnsView();
}

// マニュアルは固定文面だが、団体名など動的な表示には現在の設定値を反映する。
function renderManualView() {
    const container = $('memberManualInfo');
    if (!container) return;
    container.innerHTML = `
        <div class="info-block">
            <h5>${escapeHtml(portalTitleText())} の使い方</h5>
            <p class="mb-0">このポータルでは、練習・演奏会・連絡事項・団員向け機能をまとめて確認できます。困ったときはこのマニュアルを開いて基本操作を確認してください。</p>
        </div>
        <div class="info-block">
            <h6>1. メニューの開き方</h6>
            <ul class="mb-0">
                <li>画面左上のメニューボタンからポータルメニューを開きます。</li>
                <li>各カテゴリのボタンを押すと目的の画面に移動できます。</li>
                <li>メニュー下部の「更新」で最新情報を再読み込みできます。</li>
            </ul>
        </div>
        <div class="info-block">
            <h6>2. 日常的によく使う機能</h6>
            <ul class="mb-0">
                <li>練習予定: 次回以降の練習日、時間、場所、練習曲を確認します。</li>
                <li>欠席連絡: 欠席・遅刻・早退を登録します。</li>
                <li>録音部屋: 録音の再生やダウンロードを行います。</li>
                <li>楽譜ライブラリ: 楽譜の表示やダウンロードを行います。</li>
                <li>支払状況: 団費や演奏会費の登録状況を確認します。</li>
            </ul>
        </div>
        <div class="info-block">
            <h6>3. 団員向けの登録機能</h6>
            <ul class="mb-0">
                <li>イベント調整: 出欠や回答内容を登録します。</li>
                <li>演奏希望曲: 希望曲の登録や投票ができます。</li>
                <li>宣伝: タイトル・概要・画像付きの宣伝内容を登録できます。</li>
            </ul>
        </div>
        <div class="info-block">
            <h6>4. 管理系の機能</h6>
            <ul class="mb-0">
                <li>管理者は管理者メニューから演奏会情報、練習予定、お知らせなどを登録できます。</li>
                <li>録音担当・楽譜担当には専用の管理ボタンが表示されます。</li>
                <li>システム管理者は接続先情報や端末管理などの設定を行えます。</li>
            </ul>
        </div>
        <div class="info-block">
            <h6>5. 困ったとき</h6>
            <ul class="mb-0">
                <li>表示が古い場合は、メニュー下部の「更新」を押してください。</li>
                <li>ログインできない場合は、名前・パート・パスワードを確認してください。</li>
                <li>権限が必要な操作は、管理者またはシステム管理者に依頼してください。</li>
            </ul>
        </div>
    `;
}

function scheduleOptions(selected = '') {
    return ['<option value="">選択してください</option>'].concat(sortedSchedules(appState.schedules).map((s) => `<option value="${escapeHtml(String(s.id))}" ${String(s.id) === String(selected) ? 'selected' : ''}>${escapeHtml(formatDateWithWeekday(s.date))} ${escapeHtml(scheduleTimeLabel(s))} ${escapeHtml(s.venue || '')}</option>`)).join('');
}

function renderAbsenceView() {
    const container = $('memberAbsenceInfo');
    if (!container) return;
    const currentName = currentUserMemberName();
    if (!currentName) {
        container.innerHTML = '<p class="text-muted mb-0">ログイン中の団員情報が見つかりません</p>';
        return;
    }
    const visibleSchedules = sortedSchedules(appState.schedules).filter((schedule) => !schedule?.date || String(schedule.date) >= today());
    const visibleScheduleIds = new Set(visibleSchedules.map((schedule) => String(schedule.id || '')));
    const grouped = groupBy(appState.absences.filter((absence) => visibleScheduleIds.has(String(absence.schedule_id || ''))), 'schedule_id');
    const absenceScheduleOptions = ['<option value="">選択してください</option>'].concat(visibleSchedules.map((s) => `<option value="${escapeHtml(String(s.id))}">${escapeHtml(formatDateWithWeekday(s.date))} ${escapeHtml(scheduleTimeLabel(s))} ${escapeHtml(s.venue || '')}</option>`)).join('');
    container.innerHTML = `
        <input type="hidden" id="absenceId">
        <div class="row g-2 align-items-end mb-3">
            <div class="col-md-5"><label class="form-label">練習日</label><select id="absenceScheduleId" class="form-select">${absenceScheduleOptions}</select></div>
            <div class="col-md-2"><label class="form-label">連絡区分</label><select id="absenceStatus" class="form-select"><option value="absent">欠席</option><option value="late">遅刻</option><option value="leave_early">早退</option></select></div>
            <div class="col-md-2"><label class="form-label" id="absenceTimeLabel" for="absenceTime">予定時刻</label><input id="absenceTime" class="form-control" type="time" disabled></div>
            <div class="col-md-3"><button class="btn btn-primary w-100" id="absenceSaveBtn" type="button">連絡を保存</button></div>
        </div>
        <div class="d-flex flex-wrap gap-2 mb-3">
            <button class="btn btn-outline-secondary btn-sm" id="absenceClearBtn" type="button">入力をクリア</button>
            <button class="btn btn-outline-danger btn-sm" id="absenceDeleteBtn" type="button" disabled>選択中の連絡を削除</button>
        </div>
        <h6>練習日ごとの出欠連絡</h6>
        ${visibleSchedules.map((schedule) => {
            const abs = (grouped[String(schedule.id)] || grouped[schedule.id] || []);
            const rows = abs.length ? abs.map((absence) => {
                const own = absenceBelongsToCurrentUser(absence);
                return `<div class="absence-row d-flex flex-wrap justify-content-between align-items-center gap-2 py-1">
                    <span>${escapeHtml(absenceEntryLabel(absence))}</span>
                    ${own ? `<span class="d-flex gap-2"><button class="btn btn-sm btn-outline-primary absence-edit-btn" type="button" data-absence-id="${escapeHtml(String(absence.id || ''))}">編集</button><button class="btn btn-sm btn-outline-danger absence-delete-btn" type="button" data-absence-id="${escapeHtml(String(absence.id || ''))}">削除</button></span>` : ''}
                </div>`;
            }).join('') : '出欠連絡なし';
            return `<div class="info-block"><strong>${escapeHtml(formatDateWithWeekday(schedule.date))} ${escapeHtml(scheduleTimeLabel(schedule))}</strong><div class="small text-muted">${escapeHtml(schedule.venue || '')}</div><div class="mt-1">${rows}</div></div>`;
        }).join('')}
    `;
    const updateAbsenceTimeState = () => {
        const status = $('absenceStatus').value;
        const timeInput = $('absenceTime');
        const label = $('absenceTimeLabel');
        const needsTime = status === 'late' || status === 'leave_early';
        timeInput.disabled = !needsTime;
        if (!needsTime) timeInput.value = '';
        label.textContent = status === 'late' ? '到着予定時刻' : status === 'leave_early' ? '退出予定時刻' : '予定時刻';
    };
    $('absenceStatus').addEventListener('change', updateAbsenceTimeState);
    updateAbsenceTimeState();
    const setSelectedAbsenceId = (id = '') => { $('absenceId').value = id; $('absenceDeleteBtn').disabled = !id; };
    $('absenceClearBtn').addEventListener('click', () => {
        setSelectedAbsenceId(''); $('absenceScheduleId').value = ''; $('absenceStatus').value = 'absent'; $('absenceTime').value = ''; updateAbsenceTimeState();
    });
    $('absenceDeleteBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', () => deleteOwnAbsence($('absenceId').value)));
    container.querySelectorAll('.absence-edit-btn').forEach((button) => button.addEventListener('click', () => selectOwnAbsence(button.dataset.absenceId || '')));
    container.querySelectorAll('.absence-delete-btn').forEach((button) => button.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', () => deleteOwnAbsence(button.dataset.absenceId || ''))));
    $('absenceSaveBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '登録中...', async () => {
        const name = currentUserMemberName(); const absenceId = $('absenceId').value; const scheduleId = $('absenceScheduleId').value; const status = $('absenceStatus').value; const plannedTime = $('absenceTime').value;
        if (!name || !scheduleId) { showAlert('練習日を選択してください', 'warning'); return; }
        if ((status === 'late' || status === 'leave_early') && !plannedTime) { showAlert('予定時刻を入力してください', 'warning'); return; }
        const sched = appState.schedules.find((s) => String(s.id) === String(scheduleId));
        const payload = { name, member_id: appState.currentUserMemberId, schedule_id: scheduleId, schedule_date: sched ? sched.date : '', status, planned_time: plannedTime };
        const existing = appState.absences.find((item) => String(item.schedule_id || '') === String(scheduleId) && (String(item.member_id || '') === String(appState.currentUserMemberId || '') || item.name === name));
        const saveId = absenceId || existing?.id || '';
        if (saveId) await request(`/api/extra/absences/${encodeURIComponent(saveId)}`, jsonOptions('PUT', payload)); else await saveExtra('absences', payload);
        showAlert('出欠連絡を登録しました', 'success'); await loadExtraData();
    }));
}

function absenceBelongsToCurrentUser(absence) {
    const currentId = String(appState.currentUserMemberId || '');
    const currentName = currentUserMemberName();
    return (currentId && String(absence?.member_id || '') === currentId) || (currentName && absence?.name === currentName);
}

function selectOwnAbsence(absenceId) {
    const absence = appState.absences.find((item) => String(item.id || '') === String(absenceId));
    if (!absence || !absenceBelongsToCurrentUser(absence)) return;
    $('absenceId').value = absence.id || '';
    $('absenceScheduleId').value = String(absence.schedule_id || '');
    $('absenceStatus').value = absence.status || 'absent';
    $('absenceTime').value = absence.planned_time || '';
    $('absenceDeleteBtn').disabled = false;
    $('absenceStatus').dispatchEvent(new Event('change'));
}

async function deleteOwnAbsence(absenceId) {
    if (!absenceId) return;
    const absence = appState.absences.find((item) => String(item.id || '') === String(absenceId));
    if (!absence || !absenceBelongsToCurrentUser(absence)) {
        showAlert('削除できる出欠連絡が見つかりません', 'warning');
        return;
    }
    if (!confirmDelete()) return;
    await request(`/api/extra/absences/${encodeURIComponent(absenceId)}`, { method: 'DELETE' });
    showAlert('出欠連絡を削除しました', 'success');
    await loadExtraData();
}

function absenceStatusLabel(absence) {
    const status = absence?.status || 'absent';
    if (status === 'late') return '遅刻';
    if (status === 'leave_early') return '早退';
    return '欠席';
}

function absenceEntryLabel(absence, includeName = true) {
    const time = absence?.planned_time ? ` ${absence.planned_time}` : '';
    const status = `${absenceStatusLabel(absence)}${time}`;
    return includeName ? `${absence?.name || ''}（${status}）` : status;
}


function renderPerformanceFlyerPreview(src) {
    const preview = $('perfFlyerPreview');
    if (!preview) return;
    preview.innerHTML = src ? `<img src="${escapeHtml(src)}" alt="チラシ画像" class="performance-flyer-preview" loading="lazy">` : '';
}

async function previewPerformanceFlyer(event) {
    const file = event?.target?.files?.[0];
    if (!file) return;
    const dataUrl = await fileToDataUrl(file);
    if ($('perfFlyerImage')) $('perfFlyerImage').value = dataUrl;
    renderPerformanceFlyerPreview(dataUrl);
}

function paymentPaymentRangeLabel(payment) {
    const until = payment.paid_until_month || payment.membership_fee || payment.dues || '';
    return until ? `${until}まで支払い済み` : '未登録';
}

function renderPieceInfoAdmin() {
    const perfSelect = $('pieceInfoPerformance');
    const list = $('pieceInfoAdminList');
    if (!perfSelect || !list) return;
    const selected = perfSelect.value;
    perfSelect.innerHTML = '<option value="">演奏会を選択</option>' + appState.performances.map((perf) => `<option value="${escapeHtml(String(perf.id))}">${escapeHtml(perf.title)}</option>`).join('');
    if ([...perfSelect.options].some((option) => option.value === selected)) perfSelect.value = selected;
    updatePieceInfoPieceOptions();
    list.innerHTML = appState.pieceInfos.length ? `<div class="list-group">${appState.pieceInfos.map((info) => {
        const perf = appState.performances.find((item) => String(item.id || '') === String(info.performance_id || ''));
        return `<button class="list-group-item list-group-item-action text-start piece-info-admin-item" type="button" data-piece-info-id="${escapeHtml(String(info.id || ''))}"><strong>${escapeHtml(info.piece || info.title || '')}</strong><div class="small text-muted">${escapeHtml(perf?.title || '演奏会未設定')}</div>${info.description ? `<div class="small multiline-text mt-1">${escapeHtml(info.description)}</div>` : ''}</button>`;
    }).join('')}</div>` : '<p class="text-muted mb-0">楽曲情報はまだ登録されていません</p>';
    list.querySelectorAll('.piece-info-admin-item').forEach((button) => button.addEventListener('click', () => selectPieceInfoAdmin(button.dataset.pieceInfoId || '')));
}

function updatePieceInfoPieceOptions() {
    const select = $('pieceInfoPiece');
    if (!select) return;
    const current = select.value;
    const performanceId = $('pieceInfoPerformance')?.value || '';
    const perf = appState.performances.find((item) => String(item.id || '') === String(performanceId));
    const pieces = perf ? normalizePerformancePieces(perf.pieces || []).map(performancePieceLabel).filter(Boolean) : [];
    select.innerHTML = '<option value="">曲を選択</option>' + pieces.map((piece) => `<option value="${escapeHtml(piece)}">${escapeHtml(piece)}</option>`).join('');
    if ([...select.options].some((option) => option.value === current)) select.value = current;
}

function selectPieceInfoAdmin(id) {
    const info = appState.pieceInfos.find((item) => String(item.id || '') === String(id));
    if (!info) return;
    $('pieceInfoId').value = info.id || '';
    $('pieceInfoPerformance').value = String(info.performance_id || '');
    updatePieceInfoPieceOptions();
    $('pieceInfoPiece').value = info.piece || info.title || '';
    if ($('pieceInfoComposer')) $('pieceInfoComposer').value = info.composer || '';
    $('pieceInfoDescription').value = info.description || info.notes || '';
}

function clearPieceInfoForm() {
    if ($('pieceInfoId')) $('pieceInfoId').value = '';
    if ($('pieceInfoPerformance')) $('pieceInfoPerformance').value = '';
    if ($('pieceInfoPiece')) $('pieceInfoPiece').value = '';
    if ($('pieceInfoComposer')) $('pieceInfoComposer').value = '';
    if ($('pieceInfoDescription')) $('pieceInfoDescription').value = '';
    updatePieceInfoPieceOptions();
}

async function savePieceInfoAdmin() {
    const payload = {
        performance_id: $('pieceInfoPerformance')?.value || '',
        piece: $('pieceInfoPiece')?.value.trim() || '',
        description: $('pieceInfoDescription')?.value.trim() || ''
    };
    if (!payload.performance_id || !payload.piece) { showAlert('演奏会と曲名を入力してください', 'warning'); return; }
    const id = $('pieceInfoId')?.value || '';
    if (id) await request(`/api/extra/piece_infos/${encodeURIComponent(id)}`, jsonOptions('PUT', payload)); else await saveExtra('piece_infos', payload);
    clearPieceInfoForm(); await loadExtraData(); showAlert('楽曲情報を保存しました', 'success');
}

async function deletePieceInfoAdmin() {
    const id = $('pieceInfoId')?.value || '';
    if (!id) { showAlert('削除する楽曲情報を選択してください', 'warning'); return; }
    if (!confirmDelete()) return;
    await request(`/api/extra/piece_infos/${encodeURIComponent(id)}`, { method: 'DELETE' });
    clearPieceInfoForm(); await loadExtraData(); showAlert('楽曲情報を削除しました', 'success');
}

function renderPracticeInstructionAdmin() {
    const perfSelect = $('practiceInstructionPerformance');
    const list = $('practiceInstructionAdminList');
    if (!perfSelect || !list) return;
    const selected = perfSelect.value;
    perfSelect.innerHTML = '<option value="">演奏会を選択</option>' + appState.performances.map((perf) => `<option value="${escapeHtml(String(perf.id))}">${escapeHtml(perf.title)}</option>`).join('');
    if ([...perfSelect.options].some((option) => option.value === selected)) perfSelect.value = selected;
    updatePracticeInstructionPieceOptions();
    list.innerHTML = appState.practiceInstructions.length ? `<div class="list-group">${appState.practiceInstructions.map((item) => {
        const perf = appState.performances.find((value) => String(value.id || '') === String(item.performance_id || ''));
        const practiceText = item.practice_notes ? `<div class="small multiline-text mt-1">指摘内容: ${escapeHtml(item.practice_notes)}</div>` : '';
        return `<button class="list-group-item list-group-item-action text-start practice-instruction-admin-item" type="button" data-practice-instruction-id="${escapeHtml(String(item.id || ''))}"><strong>${escapeHtml(item.piece || '')}</strong><div class="small text-muted">${escapeHtml(perf?.title || '演奏会未設定')}</div>${practiceText}</button>`;
    }).join('')}</div>` : '<p class="text-muted mb-0">練習指示はまだ登録されていません</p>';
    list.querySelectorAll('.practice-instruction-admin-item').forEach((button) => button.addEventListener('click', () => selectPracticeInstructionAdmin(button.dataset.practiceInstructionId || '')));
}

function updatePracticeInstructionPieceOptions() {
    const select = $('practiceInstructionPiece');
    if (!select) return;
    const current = select.value;
    const performanceId = $('practiceInstructionPerformance')?.value || '';
    const perf = appState.performances.find((item) => String(item.id || '') === String(performanceId));
    const pieces = perf ? normalizePerformancePieces(perf.pieces || []).map(performancePieceLabel).filter(Boolean) : [];
    select.innerHTML = '<option value="">曲を選択</option>' + pieces.map((piece) => `<option value="${escapeHtml(piece)}">${escapeHtml(piece)}</option>`).join('');
    if ([...select.options].some((option) => option.value === current)) select.value = current;
}

function selectPracticeInstructionAdmin(id) {
    const item = appState.practiceInstructions.find((instruction) => String(instruction.id || '') === String(id));
    if (!item) return;
    $('practiceInstructionId').value = item.id || '';
    $('practiceInstructionPerformance').value = String(item.performance_id || '');
    updatePracticeInstructionPieceOptions();
    $('practiceInstructionPiece').value = item.piece || '';
    $('practiceInstructionNotes').value = item.practice_notes || '';
}

function clearPracticeInstructionForm() {
    if ($('practiceInstructionId')) $('practiceInstructionId').value = '';
    if ($('practiceInstructionPerformance')) $('practiceInstructionPerformance').value = '';
    if ($('practiceInstructionPiece')) $('practiceInstructionPiece').value = '';
    if ($('practiceInstructionNotes')) $('practiceInstructionNotes').value = '';
    updatePracticeInstructionPieceOptions();
}

async function savePracticeInstructionAdmin() {
    const payload = {
        performance_id: $('practiceInstructionPerformance')?.value || '',
        piece: $('practiceInstructionPiece')?.value.trim() || '',
        practice_notes: $('practiceInstructionNotes')?.value.trim() || '',
        // 旧項目は常に空文字で保存してデータを単一項目へ統一する。
        performance_instruction: ''
    };
    if (!payload.performance_id || !payload.piece) {
        showAlert('演奏会と曲名を入力してください', 'warning');
        return;
    }
    if (!payload.practice_notes) {
        showAlert('練習時の指摘内容を入力してください', 'warning');
        return;
    }

    const id = $('practiceInstructionId')?.value || '';
    const duplicate = appState.practiceInstructions.find((item) => String(item.performance_id || '') === String(payload.performance_id) && String(item.piece || '') === payload.piece);
    const saveId = id || String(duplicate?.id || '');
    if (saveId) {
        await request(`/api/extra/practice_instructions/${encodeURIComponent(saveId)}`, jsonOptions('PUT', payload));
    } else {
        await saveExtra('practice_instructions', payload);
    }
    clearPracticeInstructionForm();
    await loadExtraData();
    showAlert('練習指示を保存しました', 'success');
}

async function deletePracticeInstructionAdmin() {
    const id = $('practiceInstructionId')?.value || '';
    if (!id) {
        showAlert('削除する練習指示を選択してください', 'warning');
        return;
    }
    if (!confirmDelete()) return;
    await request(`/api/extra/practice_instructions/${encodeURIComponent(id)}`, { method: 'DELETE' });
    clearPracticeInstructionForm();
    await loadExtraData();
    showAlert('練習指示を削除しました', 'success');
}

// 団員向け楽譜ビュー。
// 演奏会 -> 曲 -> ファイルの順で段階的に絞り込めるようにし、
// 大量の楽譜があっても目的のファイルへ辿り着きやすくしている。
function renderSheetLibraryView() {
    const c = $('memberSheetInfo');
    if (!c) return;
    if (!appState.sheetLibrary.length) {
        c.innerHTML = '<p class="text-muted mb-0">登録された楽譜はありません</p>';
        return;
    }

    const filters = appState.sheetFilters || { performanceId: '', piece: '', part: '' };
    const visibleSheets = appState.sheetLibrary.filter((sheet) => {
        return (!filters.performanceId || String(sheet.performance_id || '') === String(filters.performanceId))
            && (!filters.piece || String(sheet.piece || '') === filters.piece)
            && (!filters.part || String(sheet.part || '') === filters.part);
    });
    const performanceOptions = sheetFilterPerformanceOptions(filters.performanceId);
    const pieceOptions = sheetFilterPieceOptions(filters.piece, filters.performanceId);
    const partOptions = sheetFilterPartOptions(filters.part, filters.performanceId, filters.piece);
    const filterHtml = `
        <div class="row g-2 align-items-end mb-3">
            <div class="col-md-4">
                <label class="form-label" for="memberSheetPerformanceFilter">演奏会</label>
                <select class="form-select" id="memberSheetPerformanceFilter">${performanceOptions}</select>
            </div>
            <div class="col-md-4">
                <label class="form-label" for="memberSheetPieceFilter">曲名</label>
                <select class="form-select" id="memberSheetPieceFilter">${pieceOptions}</select>
            </div>
            <div class="col-md-3">
                <label class="form-label" for="memberSheetPartFilter">パート</label>
                <select class="form-select" id="memberSheetPartFilter">${partOptions}</select>
            </div>
            <div class="col-md-1">
                <button class="btn btn-outline-secondary w-100" id="memberSheetFilterClearBtn" type="button">解除</button>
            </div>
        </div>
    `;
    if (!visibleSheets.length) {
        c.innerHTML = filterHtml + '<p class="text-muted mb-0">条件に一致する楽譜はありません</p>';
        bindSheetLibraryFilters();
        return;
    }

    const performanceGroups = groupBy(visibleSheets, 'performance_id');
    c.innerHTML = filterHtml + Object.entries(performanceGroups).map(([performanceId, sheets]) => {
        const performance = appState.performances.find((perf) => String(perf.id) === String(performanceId));
        const performanceTitle = performance?.title || sheets[0]?.performance_title || '未設定の演奏会';
        const pieceGroups = groupBy(sheets, 'piece');
        return `
            <details class="mb-3 sheet-library-details sheet-performance-details" open>
                <summary class="d-flex flex-wrap justify-content-between align-items-center gap-2">
                    <strong>${escapeHtml(performanceTitle)}</strong>
                    <a class="btn btn-sm btn-primary" href="${escapeHtml(sheetZipUrl(performanceId, '', filters.part))}">演奏会一括DL</a>
                </summary>
                <div class="mt-2">
                    ${Object.entries(pieceGroups).map(([piece, pieceSheets]) => `
                        <details class="mb-2 ms-md-3 sheet-library-details sheet-piece-details">
                            <summary class="d-flex flex-wrap justify-content-between align-items-center gap-2">
                                <span>${escapeHtml(piece || '未設定の曲名')}</span>
                                <a class="btn btn-sm btn-outline-primary" href="${escapeHtml(sheetZipUrl(performanceId, piece, filters.part))}">曲一括DL</a>
                            </summary>
                            <div class="list-group mt-2">
                                ${pieceSheets.map((sheet) => `
                                    <div class="list-group-item d-flex flex-wrap justify-content-between align-items-center gap-2">
                                        <span>${escapeHtml(displayNameWithoutExtension(sheet.name || '楽譜'))}<span class="badge text-bg-secondary ms-2">${escapeHtml(sheet.part || 'パート未設定')}</span></span>
                                        <span class="d-flex gap-2">
                                            <button class="btn btn-sm btn-outline-primary" type="button" data-sheet-view="${escapeHtml(String(sheet.id || ''))}">表示</button>
                                            <a class="btn btn-sm btn-primary" href="${escapeHtml(sheet.download_url || sheet.url || '#')}" download>DL</a>
                                        </span>
                                    </div>
                                `).join('')}
                            </div>
                        </details>
                    `).join('')}
                </div>
            </details>
        `;
    }).join('');
    bindSheetLibraryFilters();
    c.querySelectorAll('[data-sheet-view]').forEach((button) => {
        button.addEventListener('click', () => showSheetViewer(button.dataset.sheetView || ''));
    });
}

function showSheetViewer(sheetId) {
    const sheet = appState.sheetLibrary.find((item) => String(item.id || '') === String(sheetId));
    if (!sheet) {
        showAlert('表示する楽譜が見つかりません', 'warning');
        return;
    }
    const viewUrl = sheet.view_url || sheet.url || '';
    if (!viewUrl) {
        showAlert('楽譜の表示URLが見つかりません', 'warning');
        return;
    }
    const title = $('sheetViewerTitle');
    const download = $('sheetViewerDownload');
    if (title) title.textContent = displayNameWithoutExtension(sheet.name || '楽譜表示');
    if (download) download.href = sheet.download_url || sheet.url || viewUrl;
    switchTab('memberPanel', 'member-sheet-viewer', false);
    renderPdfViewer(viewUrl);
}

function clearSheetViewer() {
    appState.sheetPdfUrl = '';
    appState.sheetPdfRendering = false;
    const pages = $('sheetViewerPages');
    const status = $('sheetViewerStatus');
    if (pages) pages.innerHTML = '';
    if (status) status.textContent = '';
}

// PDF.js は楽譜ビューを開くまで遅延ロードし、通常利用時の初期コストを避ける。
async function loadPdfJs() {
    if (window.pdfjsLib) return window.pdfjsLib;
    await new Promise((resolve, reject) => {
        const existing = document.querySelector('script[data-pdfjs]');
        if (existing) {
            existing.addEventListener('load', resolve, { once: true });
            existing.addEventListener('error', reject, { once: true });
            return;
        }
        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
        script.dataset.pdfjs = 'true';
        script.addEventListener('load', resolve, { once: true });
        script.addEventListener('error', reject, { once: true });
        document.head.appendChild(script);
    });
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    return window.pdfjsLib;
}

async function renderPdfViewer(url, scale = null) {
    const pages = $('sheetViewerPages');
    const status = $('sheetViewerStatus');
    if (!pages || !status) return;
    appState.sheetPdfUrl = url;
    appState.sheetPdfRendering = true;
    pages.innerHTML = '';
    status.textContent = '楽譜を読み込み中...';
    try {
        const pdfjsLib = await loadPdfJs();
        const data = await fetch(url, { cache: 'no-store' }).then((response) => {
            if (!response.ok) throw new Error(`PDFを取得できませんでした (${response.status})`);
            return response.arrayBuffer();
        });
        if (appState.sheetPdfUrl !== url) return;
        const pdf = await pdfjsLib.getDocument({ data }).promise;
        const firstPage = await pdf.getPage(1);
        appState.sheetPdfScale = scale || sheetViewerFitScale(firstPage);
        status.textContent = `${pdf.numPages}ページを表示中`;
        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
            if (appState.sheetPdfUrl !== url) return;
            const page = pageNumber === 1 ? firstPage : await pdf.getPage(pageNumber);
            await renderPdfPage(page, pageNumber, appState.sheetPdfScale, pages);
        }
        status.textContent = `${pdf.numPages}ページ`;
    } catch (error) {
        status.textContent = 'PDFを表示できませんでした';
        showAlert(error.message || 'PDFを表示できませんでした', 'danger');
    } finally {
        appState.sheetPdfRendering = false;
    }
}

function sheetViewerFitScale(page) {
    const body = $('sheetViewerPages');
    const viewport = page.getViewport({ scale: 1 });
    const availableWidth = Math.max((body?.clientWidth || window.innerWidth) - 24, 280);
    return Math.max(0.35, Math.min(2.5, availableWidth / viewport.width));
}

async function renderPdfPage(page, pageNumber, scale, container) {
    const viewport = page.getViewport({ scale });
    const wrapper = document.createElement('section');
    wrapper.className = 'sheet-viewer-page';
    wrapper.innerHTML = `<div class="sheet-viewer-page-label">${pageNumber}</div>`;
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    const outputScale = window.devicePixelRatio || 1;
    canvas.width = Math.floor(viewport.width * outputScale);
    canvas.height = Math.floor(viewport.height * outputScale);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    wrapper.appendChild(canvas);
    container.appendChild(wrapper);
    await page.render({
        canvasContext: context,
        viewport,
        transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null
    }).promise;
}

function zoomSheetViewer(delta) {
    if (!appState.sheetPdfUrl || appState.sheetPdfRendering) return;
    const nextScale = Math.max(0.35, Math.min(3, appState.sheetPdfScale + delta));
    renderPdfViewer(appState.sheetPdfUrl, nextScale);
}

async function fitSheetViewerWidth() {
    if (!appState.sheetPdfUrl || appState.sheetPdfRendering) return;
    renderPdfViewer(appState.sheetPdfUrl, null);
}

function sheetPieceOptions(performance) {
    return normalizePerformancePieces(performance?.pieces || []).map(performancePieceLabel).filter(Boolean);
}

function sheetFilterPerformanceOptions(selected = '') {
    const ids = [...new Set(appState.sheetLibrary.map((sheet) => String(sheet.performance_id || '')).filter(Boolean))];
    return ['<option value="">すべて</option>'].concat(ids.map((id) => {
        const performance = appState.performances.find((perf) => String(perf.id) === id);
        const fallback = appState.sheetLibrary.find((sheet) => String(sheet.performance_id || '') === id)?.performance_title || '未設定の演奏会';
        return `<option value="${escapeHtml(id)}" ${id === String(selected) ? 'selected' : ''}>${escapeHtml(performance?.title || fallback)}</option>`;
    })).join('');
}

function sheetFilterPieceOptions(selected = '', performanceId = '') {
    const performance = appState.performances.find((perf) => String(perf.id) === String(performanceId));
    const performancePieceOrder = performance ? (performance.pieces || []).map(performancePieceLabel) : [];
    
    const pieces = [...new Set(appState.sheetLibrary
        .filter((sheet) => !performanceId || String(sheet.performance_id || '') === String(performanceId))
        .map((sheet) => String(sheet.piece || ''))
        .filter(Boolean))];
    
    // Sort by performance piece order
    const sortedPieces = pieces.sort((a, b) => {
        const aIndex = performancePieceOrder.indexOf(a);
        const bIndex = performancePieceOrder.indexOf(b);
        if (aIndex >= 0 && bIndex >= 0) return aIndex - bIndex;
        if (aIndex >= 0) return -1;
        if (bIndex >= 0) return 1;
        return a.localeCompare(b, 'ja');
    });
    
    return ['<option value="">すべて</option>'].concat(sortedPieces.map((piece) => `<option value="${escapeHtml(piece)}" ${piece === selected ? 'selected' : ''}>${escapeHtml(piece)}</option>`)).join('');
}

function sheetFilterPartOptions(selected = '', performanceId = '', piece = '') {
    const parts = [...new Set(appState.sheetLibrary
        .filter((sheet) => !performanceId || String(sheet.performance_id || '') === String(performanceId))
        .filter((sheet) => !piece || String(sheet.piece || '') === piece)
        .map((sheet) => String(sheet.part || ''))
        .filter(Boolean))].sort((a, b) => partSortIndex(a) - partSortIndex(b) || a.localeCompare(b, 'ja'));
    return ['<option value="">すべて</option>'].concat(parts.map((part) => `<option value="${escapeHtml(part)}" ${part === selected ? 'selected' : ''}>${escapeHtml(part)}</option>`)).join('');
}

function bindSheetLibraryFilters() {
    const performance = $('memberSheetPerformanceFilter');
    const piece = $('memberSheetPieceFilter');
    const part = $('memberSheetPartFilter');
    if (performance) performance.addEventListener('change', () => {
        appState.sheetFilters.performanceId = performance.value;
        appState.sheetFilters.piece = '';
        appState.sheetFilters.part = '';
        renderSheetLibraryView();
    });
    if (piece) piece.addEventListener('change', () => {
        appState.sheetFilters.piece = piece.value;
        appState.sheetFilters.part = '';
        renderSheetLibraryView();
    });
    if (part) part.addEventListener('change', () => {
        appState.sheetFilters.part = part.value;
        renderSheetLibraryView();
    });
    if ($('memberSheetFilterClearBtn')) $('memberSheetFilterClearBtn').addEventListener('click', () => {
        appState.sheetFilters = { performanceId: '', piece: '', part: '' };
        renderSheetLibraryView();
    });
}

function sheetPartOptions() {
    return currentPartNames();
}

function partOptionHtml(selected = '') {
    return ['<option value="">選択してください</option>']
        .concat(sheetPartOptions().map((part) => `<option value="${escapeHtml(part)}" ${part === selected ? 'selected' : ''}>${escapeHtml(part)}</option>`))
        .join('');
}

function sheetZipUrl(performanceId, piece = '', part = '') {
    const params = new URLSearchParams({ performance_id: String(performanceId || '') });
    if (piece) params.set('piece', piece);
    if (part) params.set('part', part);
    return `/api/sheets/download-zip?${params.toString()}`;
}

// 楽譜管理画面の入口。
// 演奏会・曲目選択の状態を保ちながら一覧と操作部品を組み直す。
function renderSheetAdmin() {
    const performanceSelect = $('sheetPerformanceSelect');
    const list = $('sheetAdminList');
    if (!performanceSelect || !list) return;

    const selectedPerformance = performanceSelect.value;
    performanceSelect.innerHTML = ['<option value="">選択してください</option>'].concat(
        appState.performances.map((perf) => `<option value="${escapeHtml(String(perf.id))}" ${String(perf.id) === selectedPerformance ? 'selected' : ''}>${escapeHtml(perf.title || '')}</option>`)
    ).join('');
    if (selectedPerformance && !performanceSelect.value) performanceSelect.value = selectedPerformance;
    updateSheetPieceOptions();
    renderSheetAdminList();
}

function updateSheetPieceOptions() {
    const performanceSelect = $('sheetPerformanceSelect');
    const pieceSelect = $('sheetPieceSelect');
    if (!performanceSelect || !pieceSelect) return;
    const selectedPiece = pieceSelect.value;
    const performance = appState.performances.find((perf) => String(perf.id) === String(performanceSelect.value));
    const pieces = sheetPieceOptions(performance);
    pieceSelect.innerHTML = pieces.length
        ? ['<option value="">選択してください</option>'].concat(pieces.map((piece) => `<option value="${escapeHtml(piece)}" ${piece === selectedPiece ? 'selected' : ''}>${escapeHtml(piece)}</option>`)).join('')
        : '<option value="">曲目が登録されていません</option>';
}

async function uploadSheets() {
    const performanceId = $('sheetPerformanceSelect')?.value || '';
    const piece = $('sheetPieceSelect')?.value || '';
    const files = Array.from($('sheetFileInput')?.files || []);
    const performance = appState.performances.find((perf) => String(perf.id) === String(performanceId));
    if (!performanceId || !performance || !piece) {
        showAlert('演奏会と曲名を選択してください', 'warning');
        return;
    }
    if (!files.length) {
        showAlert('PDFファイルを選択してください', 'warning');
        return;
    }
    const pdfFiles = files.filter((file) => file.name.toLowerCase().endsWith('.pdf') || file.type === 'application/pdf');
    if (pdfFiles.length !== files.length) {
        showAlert('PDFファイルのみ登録できます', 'warning');
        return;
    }

    let completed = 0;
    setOperationStatus('sheetUploadProgress', `楽譜を登録しています。0 / ${pdfFiles.length} 件`);
    try {
        for (const file of pdfFiles) {
            const formData = new FormData();
            formData.append('file', file);
            formData.append('performance_id', performanceId);
            formData.append('performance_title', performance.title || '');
            formData.append('piece', piece);
            setOperationStatus('sheetUploadProgress', `登録中: ${file.name}（${completed + 1} / ${pdfFiles.length} 件）`);
            await request('/api/sheets/upload', { method: 'POST', body: formData });
            completed += 1;
            setOperationStatus('sheetUploadProgress', `登録完了: ${completed} / ${pdfFiles.length} 件`);
        }
        $('sheetFileInput').value = '';
        await loadSheets();
        setOperationStatus('sheetUploadProgress', `登録が完了しました。${completed} 件の楽譜を一覧に反映しました。`);
        showAlert(`${completed}件の楽譜を登録しました`, 'success');
    } catch (error) {
        setOperationStatus('sheetUploadProgress', `登録に失敗しました。${completed} / ${pdfFiles.length} 件まで完了しています。`, 'danger');
        throw error;
    }
}

// 楽譜管理一覧。
// 単票更新と一括更新を同じ一覧の中で扱えるよう、選択状態を appState に保持している。
function renderSheetAdminList() {
    const list = $('sheetAdminList');
    if (!list) return;
    if (!appState.sheetLibrary.length) {
        list.innerHTML = '<p class="text-muted mb-0">登録済みの楽譜はありません</p>';
        return;
    }

    const selectedCount = appState.selectedSheetIds.length;
    const selectedSheetIdSet = new Set(appState.selectedSheetIds.map(String));
    const selectionHtml = selectedCount > 0 ? `
        <div class="alert alert-info mb-3">
            <div class="d-flex flex-wrap justify-content-between align-items-center gap-2">
                <span><strong>${selectedCount} 件の楽譜を選択中</strong></span>
                <div class="d-flex flex-wrap gap-2">
                    <select class="form-select form-select-sm" id="bulkPartSelect" style="width: 12rem;">
                        ${partOptionHtml('')}
                    </select>
                    <button class="btn btn-sm btn-success" id="bulkPartSaveBtn" type="button">一括パート設定</button>
                    <button class="btn btn-sm btn-outline-secondary" id="clearSelectionBtn" type="button">選択解除</button>
                </div>
            </div>
        </div>
    ` : '';

    const performanceGroups = groupBy(appState.sheetLibrary, 'performance_id');
    list.innerHTML = selectionHtml + Object.entries(performanceGroups).map(([performanceId, sheets]) => {
        const performance = appState.performances.find((perf) => String(perf.id) === String(performanceId));
        const performanceTitle = performance?.title || sheets[0]?.performance_title || '未設定の演奏会';
        const pieceGroups = groupBy(sheets, 'piece');
        return `
            <section class="mb-4">
                <div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-2">
                    <h5 class="mb-0">${escapeHtml(performanceTitle)}</h5>
                    <button class="btn btn-sm btn-outline-danger sheet-delete-performance-btn" type="button" data-performance-id="${escapeHtml(performanceId)}">演奏会配下を削除</button>
                </div>
                ${Object.entries(pieceGroups).map(([piece, pieceSheets]) => `
                    <div class="list-group mb-3">
                        <div class="list-group-item d-flex flex-wrap justify-content-between align-items-center gap-2">
                            <strong>${escapeHtml(piece || '未設定の曲名')}</strong>
                            <button class="btn btn-sm btn-outline-danger sheet-delete-piece-btn" type="button" data-performance-id="${escapeHtml(performanceId)}" data-piece="${escapeHtml(piece)}">曲名配下を削除</button>
                        </div>
                        ${pieceSheets.map((sheet) => {
                            const isSelected = selectedSheetIdSet.has(String(sheet.id || ''));
                            return `
                            <div class="list-group-item d-flex flex-wrap justify-content-between align-items-center gap-2">
                                <div class="d-flex align-items-center gap-2">
                                    <input type="checkbox" class="form-check-input sheet-select-checkbox" data-sheet-id="${escapeHtml(String(sheet.id || ''))}" ${isSelected ? 'checked' : ''} style="cursor: pointer; margin: 0;">
                                    <span>${escapeHtml(displayNameWithoutExtension(sheet.name || '楽譜'))}<span class="badge text-bg-secondary ms-2">${escapeHtml(sheet.part || 'パート未設定')}</span></span>
                                </div>
                                <span class="d-flex flex-wrap gap-2 align-items-center">
                                    <select class="form-select form-select-sm sheet-part-assign-select" data-sheet-id="${escapeHtml(String(sheet.id || ''))}" style="width: 12rem;">
                                        ${partOptionHtml(sheet.part || '')}
                                    </select>
                                    <button class="btn btn-sm btn-outline-success sheet-part-save-btn" type="button" data-sheet-id="${escapeHtml(String(sheet.id || ''))}">パート保存</button>
                                    <a class="btn btn-sm btn-outline-primary" href="${escapeHtml(sheet.url || '#')}" target="_blank">閲覧</a>
                                    <a class="btn btn-sm btn-primary" href="${escapeHtml(sheet.download_url || sheet.url || '#')}" download>DL</a>
                                    <button class="btn btn-sm btn-outline-danger sheet-delete-file-btn" type="button" data-performance-id="${escapeHtml(performanceId)}" data-sheet-id="${escapeHtml(String(sheet.id || ''))}">削除</button>
                                </span>
                            </div>
                            `;
                        }).join('')}
                    </div>
                `).join('')}
            </section>
        `;
    }).join('');

    list.querySelectorAll('.sheet-select-checkbox').forEach((checkbox) => {
        checkbox.addEventListener('change', (event) => {
            const sheetId = event.currentTarget.dataset.sheetId || '';
            if (event.currentTarget.checked) {
                if (!appState.selectedSheetIds.includes(sheetId)) {
                    appState.selectedSheetIds.push(sheetId);
                }
            } else {
                appState.selectedSheetIds = appState.selectedSheetIds.filter((id) => id !== sheetId);
            }
            renderSheetAdminList();
        });
    });

    if ($('bulkPartSaveBtn')) {
        $('bulkPartSaveBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '保存中...', () => bulkSaveSheetParts()));
    }

    if ($('clearSelectionBtn')) {
        $('clearSelectionBtn').addEventListener('click', () => {
            appState.selectedSheetIds = [];
            renderSheetAdminList();
        });
    }

    list.querySelectorAll('.sheet-part-save-btn').forEach((button) => {
        button.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '保存中...', () => saveSheetPart(button.dataset.sheetId || '')));
    });
    list.querySelectorAll('.sheet-delete-file-btn').forEach((button) => {
        button.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', () => deleteSheets({
            performance_id: button.dataset.performanceId || '',
            sheet_id: Number(button.dataset.sheetId || 0)
        }, 'この楽譜を削除しますか？')));
    });
    list.querySelectorAll('.sheet-delete-piece-btn').forEach((button) => {
        button.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', () => deleteSheets({
            performance_id: button.dataset.performanceId || '',
            piece: button.dataset.piece || ''
        }, 'この曲名配下の楽譜を一括削除しますか？')));
    });
    list.querySelectorAll('.sheet-delete-performance-btn').forEach((button) => {
        button.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', () => deleteSheets({
            performance_id: button.dataset.performanceId || ''
        }, 'この演奏会配下の楽譜を一括削除しますか？')));
    });
}

async function deleteSheets(payload) {
    if (!confirmDelete()) return;
    await request('/api/sheets', jsonOptions('DELETE', payload));
    await loadSheets();
    showAlert('楽譜を削除しました', 'success');
}

async function saveSheetPart(sheetId) {
    if (!sheetId) return;
    const select = [...document.querySelectorAll('.sheet-part-assign-select')]
        .find((item) => String(item.dataset.sheetId || '') === String(sheetId));
    const part = select ? select.value : '';
    await request(`/api/sheets/${encodeURIComponent(sheetId)}/part`, jsonOptions('PUT', { part }));
    await loadSheets();
    showAlert('楽譜のパートを保存しました', 'success');
}

async function bulkSaveSheetParts() {
    const part = $('bulkPartSelect')?.value.trim() || '';
    if (!part) {
        showAlert('パートを選択してください', 'warning');
        return;
    }
    if (!appState.selectedSheetIds.length) {
        showAlert('楽譜を選択してください', 'warning');
        return;
    }
    const sheetIds = appState.selectedSheetIds.map((id) => Number(id) || 0).filter((id) => id > 0);
    await request('/api/sheets/parts', jsonOptions('PUT', { sheet_ids: sheetIds, part }));
    const count = sheetIds.length;
    appState.selectedSheetIds = [];
    await loadSheets();
    showAlert(`${count} 件の楽譜のパートを一括更新しました`, 'success');
}

function renderPaymentView() {
    const c = $('memberPaymentInfo');
    if (!c) return;
    c.innerHTML = memberPaymentStatusHtml();
}

function memberPaymentStatusHtml() {
    const org = currentOrgSetting();
    const membershipFee = Number(org.membership_fee_amount || 0);
    const membershipFeeLabel = membershipFee > 0 ? `${membershipFee.toLocaleString('ja-JP')}円/月` : '未登録';
    
    const performanceFees = appState.performances.map((perf) => {
        const amount = Number(perf.performance_fee_amount || 0);
        const amountLabel = amount > 0 ? `${amount.toLocaleString('ja-JP')}円` : '未設定';
        return `<div class="small">${escapeHtml(perf.title)} - ${amountLabel}</div>`;
    }).join('');
    
    return `
        <div class="info-block">
            <h6>団費</h6>
            <div>${membershipFeeLabel}</div>
            <h6 class="mt-3">演奏会費</h6>
            <div>${performanceFees || '<p class="text-muted mb-0">演奏会情報は未登録です</p>'}</div>
        </div>
    `;
}

function findPaymentForMember(memberId, name = '') {
    return appState.payments.find((payment) =>
        (memberId && String(payment.member_id || '') === String(memberId)) ||
        (name && payment.name === name)
    ) || null;
}

function performanceFeeMap(payment) {
    return payment?.performance_fees && typeof payment.performance_fees === 'object'
        ? payment.performance_fees
        : {};
}

function performanceFeeAmountMap(payment) {
    return payment?.performance_fee_amounts && typeof payment.performance_fee_amounts === 'object'
        ? payment.performance_fee_amounts
        : {};
}

function monthValue(monthText) {
    if (!monthText || !/^\d{4}-\d{2}$/.test(String(monthText))) return null;
    const [year, month] = String(monthText).split('-').map(Number);
    return year * 12 + month;
}

function currentMonthValue() {
    return monthValue(today().slice(0, 7));
}

function addMonths(dateText, months) {
    if (!dateText) return null;
    const date = new Date(`${dateText}T00:00:00`);
    if (Number.isNaN(date.getTime())) return null;
    date.setMonth(date.getMonth() + months);
    return date;
}

function paymentAlertInfo(payment = null) {
    const targetPayment = payment || findPaymentForMember(appState.currentUserMemberId, currentUserMemberName());
    const info = { duesOverdue: false, overduePerformanceIds: new Set(), hasAlert: false };
    if (!targetPayment) return info;
    const paidUntil = monthValue(targetPayment.paid_until_month || targetPayment.membership_fee || targetPayment.dues || '');
    const current = currentMonthValue();
    if (paidUntil !== null && current !== null && paidUntil <= current - 6) {
        info.duesOverdue = true;
    }
    const feeMap = performanceFeeMap(targetPayment);
    const now = new Date(`${today()}T00:00:00`);
    appState.performances.forEach((perf) => {
        const dueDate = addMonths(perf.date, 6);
        const paid = Boolean(feeMap[String(perf.id)]);
        if (dueDate && dueDate < now && !paid) {
            info.overduePerformanceIds.add(String(perf.id));
        }
    });
    info.hasAlert = info.duesOverdue || info.overduePerformanceIds.size > 0;
    return info;
}

function paymentStatusHtml(payment) {
    const feeMap = performanceFeeMap(payment);
    const feeAmountMap = performanceFeeAmountMap(payment);
    const alertInfo = paymentAlertInfo(payment);
    const membershipFeeAmount = Number(payment.membership_fee_amount || 0);
    const performanceFees = appState.performances.map((perf) => {
        const paid = Boolean(feeMap[String(perf.id)]);
        const overdue = alertInfo.overduePerformanceIds.has(String(perf.id));
        const amount = Number(feeAmountMap[String(perf.id)] || 0);
        const amountLabel = amount > 0 ? ` / 金額: ${amount.toLocaleString('ja-JP')}円` : '';
        return `<div><span class="${overdue ? 'payment-overdue' : ''}">${escapeHtml(perf.title)}</span>: <span class="badge ${paid ? 'text-bg-success' : 'text-bg-secondary'}">${paid ? '支払済み' : '未払い'}</span>${amountLabel}${overdue ? '<span class="payment-overdue ms-2">滞納</span>' : ''}</div>`;
    }).join('');
    return `
        <div class="info-block">
            <div class="${alertInfo.duesOverdue ? 'payment-overdue' : ''}">団費: ${escapeHtml(paymentPaymentRangeLabel(payment))}${alertInfo.duesOverdue ? '（滞納）' : ''}</div>
            <div>団員費用額: ${membershipFeeAmount > 0 ? `${membershipFeeAmount.toLocaleString('ja-JP')}円` : '未登録'}</div>
            <div>最新支払日: ${escapeHtml(payment.latest_payment_date || '未登録')}</div>
            <div class="mt-2"><strong>演奏会費</strong>${performanceFees || '<div class="text-muted">演奏会情報は未登録です</div>'}</div>
        </div>
    `;
}

function paymentMemberOptionsById(selected = '') {
    return ['<option value="">選択してください</option>'].concat(sortedMembersByPartAndKana(appState.members).map((member) => {
        const id = String(member.id || '');
        const part = member.part ? `（${member.part}）` : '';
        return `<option value="${escapeHtml(id)}" ${id === String(selected) ? 'selected' : ''}>${escapeHtml(memberDisplayName(member) + part)}</option>`;
    })).join('');
}

// 乗り番管理は「演奏会単位で 1 レコードを編集する」前提で組んでいる。
// 一覧表示と編集フォームは別管理せず、選択中の演奏会を appState に展開して同期する。
function renderCastingAdmin() {
    const performanceSelect = $('castingPerformanceSelect');
    if (!performanceSelect) return;

    const previousValue = performanceSelect.value;
    performanceSelect.innerHTML = appState.performances.map((perf) => 
        `<option value="${escapeHtml(String(perf.id || ''))}">${escapeHtml(perf.title || '未設定')}</option>`
    ).join('');

    const hasPrevious = appState.performances.some((perf) => String(perf.id || '') === String(previousValue));
    if (hasPrevious) {
        performanceSelect.value = previousValue;
    }

    performanceSelect.onchange = () => loadCastingById(Number(performanceSelect.value) || 0);

    if (!performanceSelect.value && appState.performances.length) {
        performanceSelect.value = String(appState.performances[0].id || '');
    }
    loadCastingById(Number(performanceSelect.value) || 0);
    renderCastingAdminList();
}

function loadCastingById(performanceId) {
    if (!performanceId) {
        appState.castingEditingId = null;
        appState.castingEditingPerformanceId = null;
        appState.castingEditingPiece = '';
        appState.castingEditingMembers = [];
        appState.castingEditingExtras = [];
        clearCastingForm();
        return;
    }
    
    // 保存済みデータを直接参照し続けると編集中に一覧側へ影響するため、
    // フォーム編集用には浅いコピーで別配列を持つ。
    const casting = appState.castings.find((c) => String(c.performance_id || '') === String(performanceId));
    if (casting) {
        appState.castingEditingId = casting.id || null;
        appState.castingEditingPerformanceId = casting.performance_id || null;
        appState.castingEditingPiece = casting.piece || '';
        appState.castingEditingMembers = Array.isArray(casting.members) ? casting.members.map(m => ({ ...m })) : [];
        appState.castingEditingExtras = Array.isArray(casting.extras) ? casting.extras.map(e => ({ ...e })) : [];
    } else {
        appState.castingEditingId = null;
        appState.castingEditingPerformanceId = performanceId;
        appState.castingEditingPiece = '';
        appState.castingEditingMembers = [];
        appState.castingEditingExtras = [];
    }
    
    clearCastingForm();
    $('castingPieceInput').value = appState.castingEditingPiece;
    renderCastingMembersList();
    renderCastingExtrasList();
}

function clearCastingForm() {
    $('castingPieceInput').value = '';
    appState.castingEditingMembers = [];
    appState.castingEditingExtras = [];
    renderCastingMembersList();
    renderCastingExtrasList();
}

function renderCastingMembersList() {
    const list = $('castingMembersList');
    if (!list) return;

    const selectedIds = new Set(
        (appState.castingEditingMembers || [])
            .map((member) => String(member.member_id || ''))
            .filter(Boolean)
    );
    const sortedMembers = sortedMembersByPartAndKana(appState.members || []);
    if (!sortedMembers.length) {
        list.innerHTML = '<p class="text-muted mb-0">団員データがありません</p>';
        return;
    }

    list.innerHTML = `<div class="row g-2">${sortedMembers.map((member) => {
        const memberId = String(member.id || '');
        const isChecked = selectedIds.has(memberId);
        const part = member.part ? `（${member.part}）` : '';
        return `
            <div class="col-md-6 col-lg-4">
                <label class="form-check border rounded p-2 h-100">
                    <input class="form-check-input casting-member-checkbox" type="checkbox" value="${escapeHtml(memberId)}" ${isChecked ? 'checked' : ''}>
                    <span class="form-check-label">${escapeHtml(memberDisplayName(member) + part)}</span>
                </label>
            </div>
        `;
    }).join('')}</div>`;

    list.querySelectorAll('.casting-member-checkbox').forEach((checkbox) => {
        checkbox.addEventListener('change', () => {
            const checkedIds = Array.from(list.querySelectorAll('.casting-member-checkbox:checked')).map((input) => String(input.value || ''));
            appState.castingEditingMembers = checkedIds.map((memberId) => {
                const member = appState.members.find((item) => String(item.id || '') === memberId);
                return {
                    member_id: Number(memberId) || 0,
                    part: member?.part || ''
                };
            });
        });
    });
}

function renderCastingExtrasList() {
    const list = $('castingExtrasList');
    if (!list) return;
    
    list.innerHTML = appState.castingEditingExtras.map((extra, index) => {
        return `
            <div class="mb-3 p-2 border rounded">
                <div class="mb-2">
                    <label class="form-label form-label-sm mb-1">名前</label>
                    <input type="text" class="form-control form-control-sm" placeholder="名前" value="${escapeHtml(extra.name || '')}" data-name-index="${index}">
                </div>
                <div class="mb-2">
                    <label class="form-label form-label-sm mb-1">フリガナ</label>
                    <input type="text" class="form-control form-control-sm" placeholder="フリガナ" value="${escapeHtml(extra.furigana || '')}" data-furigana-index="${index}">
                </div>
                <div class="mb-2">
                    <label class="form-label form-label-sm mb-1">パート</label>
                    <input type="text" class="form-control form-control-sm" placeholder="パート" value="${escapeHtml(extra.part || '')}" data-extra-part-index="${index}">
                </div>
                <button class="btn btn-sm btn-outline-danger casting-extra-delete-btn" data-index="${index}" type="button">削除</button>
            </div>
        `;
    }).join('');
    
    list.querySelectorAll('[data-name-index]').forEach((input) => {
        input.addEventListener('change', (e) => {
            const index = Number(e.target.dataset.nameIndex || 0);
            if (appState.castingEditingExtras[index]) {
                appState.castingEditingExtras[index].name = e.target.value.trim();
            }
        });
    });
    
    list.querySelectorAll('[data-furigana-index]').forEach((input) => {
        input.addEventListener('change', (e) => {
            const index = Number(e.target.dataset.furiganaIndex || 0);
            if (appState.castingEditingExtras[index]) {
                appState.castingEditingExtras[index].furigana = e.target.value.trim();
            }
        });
    });
    
    list.querySelectorAll('[data-extra-part-index]').forEach((input) => {
        input.addEventListener('change', (e) => {
            const index = Number(e.target.dataset.extraPartIndex || 0);
            if (appState.castingEditingExtras[index]) {
                appState.castingEditingExtras[index].part = e.target.value.trim();
            }
        });
    });
    
    list.querySelectorAll('.casting-extra-delete-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            const index = Number(e.target.dataset.index || 0);
            appState.castingEditingExtras.splice(index, 1);
            renderCastingExtrasList();
        });
    });
}

function renderCastingAdminList() {
    const list = $('castingAdminList');
    if (!list) return;
    
    const grouped = groupBy(appState.castings, 'performance_id');
    const performanceMap = new Map(appState.performances.map((performance) => [String(performance.id || ''), performance]));
    const memberNameMap = new Map(appState.members.map((member) => [String(member.id || ''), memberDisplayName(member)]));
    list.innerHTML = Object.entries(grouped).map(([perfId, castings]) => {
        const perf = performanceMap.get(String(perfId));
        const perfTitle = perf?.title || '未設定の演奏会';
        
        return `
            <section class="mb-4">
                <h6>${escapeHtml(perfTitle)}</h6>
                ${castings.map((c) => {
                    const members = Array.isArray(c.members) ? c.members.map((m) => {
                        const memberName = memberNameMap.get(String(m.member_id || '')) || m.name || '';
                        return `${memberName}${m.part ? `（${m.part}）` : ''}`;
                    }).join(', ') : '';
                    const extras = Array.isArray(c.extras) ? c.extras.map((e) => `${e.name || ''}${e.part ? `（${e.part}）` : ''}`).join(', ') : '';
                    const allCasting = [members, extras].filter(Boolean).join(' / ') || '(出演者未設定)';
                    
                    return `
                        <div class="p-2 border rounded mb-2">
                            <div class="d-flex justify-content-between align-items-start">
                                <div>
                                    <strong>${escapeHtml(c.piece || '全曲')}</strong><br>
                                    <small class="text-muted">${escapeHtml(allCasting)}</small>
                                </div>
                                <button class="btn btn-sm btn-outline-primary casting-edit-btn" data-performance-id="${escapeHtml(String(c.performance_id || ''))}" data-piece="${escapeHtml(c.piece || '')}" type="button">編集</button>
                            </div>
                        </div>
                    `;
                }).join('')}
            </section>
        `;
    }).join('') || '<p class="text-muted">乗り番データがありません</p>';
    
    list.querySelectorAll('.casting-edit-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            const perfId = e.target.dataset.performanceId || '';
            $('castingPerformanceSelect').value = perfId;
            loadCastingById(Number(perfId) || 0);
        });
    });
}

function bindCastingAdminEvents() {
    const addExtraBtn = $('castingAddExtraBtn');
    const saveBtn = $('castingSaveBtn');
    const deleteBtn = $('castingDeleteBtn');
    const clearBtn = $('castingClearBtn');
    
    if (addExtraBtn) {
        addExtraBtn.addEventListener('click', () => {
            appState.castingEditingExtras.push({ name: '', furigana: '', part: '' });
            renderCastingExtrasList();
        });
    }
    
    if (saveBtn) {
        saveBtn.addEventListener('click', () => saveCasting());
    }
    
    if (deleteBtn) {
        deleteBtn.addEventListener('click', () => deleteCasting());
    }
    
    if (clearBtn) {
        clearBtn.addEventListener('click', () => clearCastingForm());
    }
}

async function saveCasting() {
    const perfId = Number($('castingPerformanceSelect')?.value || 0);
    if (!perfId) {
        showAlert('演奏会を選択してください', 'warning');
        return;
    }
    
    const piece = $('castingPieceInput')?.value.trim() || '';
    const members = appState.castingEditingMembers.filter((m) => m.member_id);
    const extras = appState.castingEditingExtras.filter((e) => e.name);
    
    if (!members.length && !extras.length) {
        showAlert('団員またはエキストラを追加してください', 'warning');
        return;
    }
    
    const payload = {
        performance_id: perfId,
        piece,
        members,
        extras
    };
    
    try {
        setOperationStatus('castingOperationStatus', '保存中...');
        if (appState.castingEditingId) {
            await request(`/api/extra/castings/${appState.castingEditingId}`, jsonOptions('PUT', payload));
        } else {
            await request('/api/extra/castings', jsonOptions('POST', payload));
        }
        await loadExtraData();
        renderCastingAdmin();
        showAlert('乗り番を保存しました', 'success');
        setOperationStatus('castingOperationStatus', null);
    } catch (error) {
        setOperationStatus('castingOperationStatus', '保存に失敗しました', 'danger');
        console.error('Save casting failed', error);
    }
}

async function deleteCasting() {
    if (!appState.castingEditingId) {
        showAlert('削除対象が選択されていません', 'warning');
        return;
    }
    if (!confirmDelete()) return;
    
    try {
        setOperationStatus('castingOperationStatus', '削除中...');
        await request(`/api/extra/castings/${appState.castingEditingId}`, jsonOptions('DELETE'));
        await loadExtraData();
        renderCastingAdmin();
        clearCastingForm();
        showAlert('乗り番を削除しました', 'success');
        setOperationStatus('castingOperationStatus', null);
    } catch (error) {
        setOperationStatus('castingOperationStatus', '削除に失敗しました', 'danger');
        console.error('Delete casting failed', error);
    }
}

// 支払管理画面。
// 団費と演奏会費の両方を 1 レコードに集約し、団員単位で入力・参照できる形にしている。
function renderPaymentAdmin() {
    const memberSelect = $('paymentMemberId');
    const feeContainer = $('paymentPerformanceFees');
    const list = $('paymentAdminList');
    if (!memberSelect || !feeContainer || !list) return;

    const selected = memberSelect.value;
    memberSelect.innerHTML = paymentMemberOptionsById(selected);
    if ([...memberSelect.options].some((option) => option.value === selected)) {
        memberSelect.value = selected;
    }

    feeContainer.innerHTML = appState.performances.length
        ? appState.performances.map((perf) => `
            <div class="d-flex flex-wrap align-items-center gap-2 mb-2">
                <label class="form-check mb-0">
                    <input class="form-check-input payment-performance-checkbox" type="checkbox" value="${escapeHtml(String(perf.id))}">
                    <span class="form-check-label">${escapeHtml(perf.title)}</span>
                </label>
                <input class="form-control form-control-sm payment-performance-amount" type="number" min="0" step="1" value="" data-performance-id="${escapeHtml(String(perf.id))}" style="width: 12rem;" placeholder="演奏会費（円）">
            </div>
        `).join('')
        : '<p class="text-muted mb-0">演奏会情報はまだありません</p>';

    list.innerHTML = appState.payments.length
        ? `<div class="list-group">${appState.payments.map((payment) => {
            const member = appState.members.find((item) => String(item.id || '') === String(payment.member_id || ''));
            const name = member ? memberDisplayName(member) : (payment.name || '未設定');
            const membershipFeeAmount = Number(payment.membership_fee_amount || 0);
            const membershipFeeLabel = membershipFeeAmount > 0 ? `${membershipFeeAmount.toLocaleString('ja-JP')}円` : '未登録';
            return `
                <button class="list-group-item list-group-item-action payment-admin-item" type="button" data-payment-id="${escapeHtml(String(payment.id || ''))}">
                    <strong>${escapeHtml(name)}</strong>
                    <div class="small text-muted">団費: ${escapeHtml(paymentPaymentRangeLabel(payment))} / 団員費用額: ${escapeHtml(membershipFeeLabel)} / 最新支払日: ${escapeHtml(payment.latest_payment_date || '未登録')}</div>
                </button>
            `;
        }).join('')}</div>`
        : '<p class="text-muted mb-0">支払状況はまだ登録されていません</p>';

    list.querySelectorAll('.payment-admin-item').forEach((button) => {
        button.addEventListener('click', () => selectPaymentRecord(button.dataset.paymentId || ''));
    });

    renderPaymentFeeSettings();
}

function selectPaymentByMember(memberId) {
    const member = appState.members.find((item) => String(item.id || '') === String(memberId));
    const payment = findPaymentForMember(memberId, member ? memberDisplayName(member) : '');
    fillPaymentForm(payment, memberId);
}

function selectPaymentRecord(paymentId) {
    const payment = appState.payments.find((item) => String(item.id || '') === String(paymentId));
    if (!payment) return;
    fillPaymentForm(payment, payment.member_id || '');
}

function fillPaymentForm(payment, memberId = '') {
    if (!$('paymentId')) return;
    $('paymentId').value = payment?.id || '';
    $('paymentMemberId').value = memberId || payment?.member_id || '';
    if ($('paymentPaidFromMonth')) $('paymentPaidFromMonth').value = payment?.paid_from_month || '';
    $('paymentPaidUntilMonth').value = payment?.paid_until_month || '';
    $('paymentLatestDate').value = payment?.latest_payment_date || today();
    if ($('paymentMembershipFeeAmount')) $('paymentMembershipFeeAmount').value = Number(payment?.membership_fee_amount || 0) > 0 ? String(payment.membership_fee_amount) : '';
    const feeMap = performanceFeeMap(payment);
    const feeAmountMap = performanceFeeAmountMap(payment);
    document.querySelectorAll('.payment-performance-checkbox').forEach((checkbox) => {
        checkbox.checked = Boolean(feeMap[String(checkbox.value)]);
    });
    document.querySelectorAll('.payment-performance-amount').forEach((input) => {
        const performanceId = String(input.dataset.performanceId || '');
        const amount = Number(feeAmountMap[performanceId] || 0);
        input.value = amount > 0 ? String(amount) : '';
    });
}

function clearPaymentForm() {
    fillPaymentForm(null, '');
}

async function savePaymentStatus() {
    const memberId = $('paymentMemberId')?.value || '';
    const member = appState.members.find((item) => String(item.id || '') === String(memberId));
    if (!member) {
        showAlert('支払状況を登録する団員を選択してください', 'warning');
        return;
    }
    const performanceFees = {};
    const performanceFeeAmounts = {};
    document.querySelectorAll('.payment-performance-checkbox').forEach((checkbox) => {
        performanceFees[String(checkbox.value)] = checkbox.checked;
    });
    document.querySelectorAll('.payment-performance-amount').forEach((input) => {
        const performanceId = String(input.dataset.performanceId || '');
        const amount = Number(input.value || 0);
        performanceFeeAmounts[performanceId] = amount > 0 ? amount : 0;
    });
    const payload = {
        member_id: memberId,
        name: memberDisplayName(member),
        paid_until_month: $('paymentPaidUntilMonth')?.value || '',
        latest_payment_date: $('paymentLatestDate')?.value || '',
        membership_fee_amount: Number($('paymentMembershipFeeAmount')?.value || 0),
        performance_fees: performanceFees,
        performance_fee_amounts: performanceFeeAmounts
    };
    const id = $('paymentId')?.value || findPaymentForMember(memberId, payload.name)?.id || '';
    const saved = id
        ? await request(`/api/extra/payments/${encodeURIComponent(id)}`, jsonOptions('PUT', payload))
        : await saveExtra('payments', payload);
    await loadExtraData();
    renderPaymentView();
    fillPaymentForm(saved, memberId);
    showAlert('支払状況を保存しました', 'success');
}

function renderCastingView() {
    const c = $('memberCastingInfo'); if (!c) return;
    c.innerHTML = appState.performances.map((perf) => {
        const rows = appState.castings.filter((x) => String(x.performance_id || '') === String(perf.id));
        const castingContent = rows.length ? rows.map((r) => {
            // members配列をパートごとにグルーピング（part設定順でソート）
            const partMap = new Map();
            (r.members || []).forEach((m) => {
                const member = appState.members.find((item) => item.id === m.member_id);
                const name = member ? memberDisplayName(member) : `団員ID:${m.member_id}`;
                const part = m.part || member?.part || '（パート未設定）';
                if (!partMap.has(part)) partMap.set(part, []);
                partMap.get(part).push(name);
            });
            // エキストラはパートごとにグルーピング
            (r.extras || []).forEach((e) => {
                const name = e.name || '';
                if (!name) return;
                const part = e.part || '（エキストラ）';
                if (!partMap.has(part)) partMap.set(part, []);
                partMap.get(part).push(name);
            });

            // パート設定の順序でソート
            const sortedParts = [...partMap.entries()].sort(
                ([a], [b]) => partSortIndex(a) - partSortIndex(b) ||
                    String(a).localeCompare(String(b), 'ja')
            );

            if (!sortedParts.length) {
                return `<div class="info-block"><strong>${escapeHtml(r.piece || '全曲')}</strong><p class="text-muted mb-0">（未登録）</p></div>`;
            }

            const tableRows = sortedParts.map(([part, names]) => {
                const memberList = Array.isArray(names) && names.length
                    ? `<ul class="casting-member-vertical-list mb-0">${names.map((name) => `<li>${escapeHtml(name)}</li>`).join('')}</ul>`
                    : '<span class="text-muted">（未登録）</span>';
                return `<tr><td class="text-nowrap pe-3 text-muted small fw-bold">${escapeHtml(part)}</td><td>${memberList}</td></tr>`;
            }).join('');

            return `<div class="info-block mb-3"><strong class="d-block mb-2">${escapeHtml(r.piece || '全曲')}</strong><table class="table table-sm table-borderless mb-0"><tbody>${tableRows}</tbody></table></div>`;
        }).join('') : '<p class="text-muted">乗り番表は未登録です</p>';

        return `<section class="mb-3"><h5>${escapeHtml(perf.title)}</h5>${castingContent}</section>`;
    }).join('');
}

function sortedDateAdjustments(items) {
    return [...(items || [])].sort((a, b) =>
        String(a.deadline || '').localeCompare(String(b.deadline || '')) ||
        String(a.created_at || '').localeCompare(String(b.created_at || '')) ||
        String(a.title || '').localeCompare(String(b.title || ''), 'ja')
    );
}

function dateAdjustmentCandidates(adjustment) {
    return Array.isArray(adjustment?.candidates) ? adjustment.candidates : [];
}

function dateAdjustmentOwnerKey(item) {
    const memberId = String(item?.member_id || '').trim();
    if (memberId) return `member:${memberId}`;
    return `name:${String(item?.name || '').trim()}`;
}

function dateAdjustmentStatusLabel(status) {
    if (status === 'ok') return '○';
    if (status === 'maybe') return '△';
    if (status === 'ng') return '×';
    return '-';
}

function dateAdjustmentStatusText(status) {
    if (status === 'ok') return '参加可';
    if (status === 'maybe') return '調整可';
    if (status === 'ng') return '不可';
    return '未回答';
}

function dateAdjustmentKeywordTokens(text) {
    const normalized = String(text || '')
        .toLowerCase()
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/[\r\n\t]/g, ' ');
    try {
        const pattern = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{2,}|[a-z0-9]{2,}/gu;
        return normalized.match(pattern) || [];
    } catch {
        // Unicode property escapes 非対応ブラウザ向けフォールバック。
        const fallbackPattern = /[\u3040-\u30FF\u3400-\u9FFF]{2,}|[a-z0-9]{2,}/g;
        return normalized.match(fallbackPattern) || [];
    }
}

function dateAdjustmentFrequentKeywordsFromNotes(notes, maxCount = 6) {
    const stopWords = new Set([
        'です', 'ます', 'した', 'ので', 'ため', 'について', 'こと', 'それ', 'これ', 'こちら', 'あちら',
        '参加', '調整', '不可', '可能', '予定', '未定', '回答', 'コメント', '日程', '候補日'
    ]);
    const frequency = new Map();
    (notes || []).forEach((note) => {
        dateAdjustmentKeywordTokens(note).forEach((token) => {
            if (stopWords.has(token)) return;
            frequency.set(token, (frequency.get(token) || 0) + 1);
        });
    });
    return Array.from(frequency.entries())
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ja'))
        .slice(0, maxCount);
}

function currentUserMatchesDateAdjustmentResponse(response) {
    const currentMemberId = String(appState.currentUserMemberId || '');
    const currentName = String(currentUserMemberName() || '');
    return (currentMemberId && String(response?.member_id || '') === currentMemberId) || (currentName && String(response?.name || '') === currentName);
}

function dedupeDateAdjustmentResponses(responses) {
    const map = new Map();
    responses.forEach((response) => {
        const key = `${String(response.candidate_id || '')}|${dateAdjustmentOwnerKey(response)}`;
        if (!key.startsWith('|')) map.set(key, response);
    });
    return Array.from(map.values());
}

function dateAdjustmentCanDelete(adjustment) {
    if (canAccessAdmin()) return true;
    const currentMemberId = String(appState.currentUserMemberId || '');
    const currentName = String(currentUserMemberName() || '');
    return (currentMemberId && String(adjustment?.member_id || '') === currentMemberId)
        || (currentName && String(adjustment?.created_by || '') === currentName);
}

function dateAdjustmentCandidateLabel(candidate) {
    const date = candidate?.date ? formatDateWithWeekday(candidate.date, candidate.date) : '';
    const start = String(candidate?.start_time || '').trim();
    const end = String(candidate?.end_time || '').trim();
    const time = start && end ? `${start}-${end}` : (start || end);
    const note = String(candidate?.note || '').trim();
    const blocks = [date, time, note].filter(Boolean);
    return blocks.join(' / ') || '候補日未設定';
}

function dateAdjustmentCandidateRowHtml(candidate = {}, removable = true) {
    return `
        <div class="row g-2 align-items-end date-adjustment-candidate-row mb-2" data-candidate-id="${escapeHtml(String(candidate.id || ''))}">
            <div class="col-md-3"><label class="form-label">日付</label><input type="date" class="form-control date-adjustment-candidate-date" value="${escapeHtml(String(candidate.date || ''))}"></div>
            <div class="col-md-2"><label class="form-label">開始</label><input type="time" class="form-control date-adjustment-candidate-start" value="${escapeHtml(String(candidate.start_time || ''))}"></div>
            <div class="col-md-2"><label class="form-label">終了</label><input type="time" class="form-control date-adjustment-candidate-end" value="${escapeHtml(String(candidate.end_time || ''))}"></div>
            <div class="col-md-3"><label class="form-label">備考</label><input type="text" class="form-control date-adjustment-candidate-note" value="${escapeHtml(String(candidate.note || ''))}" placeholder="例: 合奏のみ"></div>
            <div class="col-md-2">
                <label class="form-label">並び</label>
                <div class="d-flex gap-1">
                    <button class="btn btn-outline-secondary w-100 date-adjustment-candidate-up" type="button">↑</button>
                    <button class="btn btn-outline-secondary w-100 date-adjustment-candidate-down" type="button">↓</button>
                    <button class="btn btn-outline-danger w-100 date-adjustment-candidate-remove" type="button" ${removable ? '' : 'disabled'}>削除</button>
                </div>
            </div>
        </div>
    `;
}

function refreshDateAdjustmentCandidateRowControls() {
    const rows = Array.from(document.querySelectorAll('#dateAdjustmentCandidateRows .date-adjustment-candidate-row'));
    rows.forEach((row, index) => {
        const up = row.querySelector('.date-adjustment-candidate-up');
        const down = row.querySelector('.date-adjustment-candidate-down');
        const remove = row.querySelector('.date-adjustment-candidate-remove');
        if (up) up.disabled = index === 0;
        if (down) down.disabled = index === rows.length - 1;
        if (remove) remove.disabled = rows.length <= 1;
    });
}

function collectDateAdjustmentCandidates() {
    const rows = Array.from(document.querySelectorAll('#dateAdjustmentCandidateRows .date-adjustment-candidate-row'));
    return rows
        .map((row, index) => ({
            id: row.dataset.candidateId || `cand-${Date.now()}-${index}`,
            date: row.querySelector('.date-adjustment-candidate-date')?.value || '',
            start_time: row.querySelector('.date-adjustment-candidate-start')?.value || '',
            end_time: row.querySelector('.date-adjustment-candidate-end')?.value || '',
            note: row.querySelector('.date-adjustment-candidate-note')?.value?.trim() || ''
        }))
        .filter((item) => item.date);
}

function renderDateAdjustmentList() {
    const list = $('memberDateAdjustmentList');
    if (!list) return;
    const adjustments = sortedDateAdjustments(appState.dateAdjustments);
    if (!adjustments.length) {
        list.innerHTML = '<p class="text-muted mb-0">日程調整はまだありません</p>';
        return;
    }

    list.innerHTML = '';
    adjustments.forEach((adjustment) => {
        const related = dedupeDateAdjustmentResponses(appState.dateAdjustmentResponses.filter((item) => String(item.adjustment_id || '') === String(adjustment.id || '')));
        const respondentCount = new Set(related.map((item) => dateAdjustmentOwnerKey(item))).size;
        const candidateCount = dateAdjustmentCandidates(adjustment).length;
        const element = document.createElement('button');
        element.type = 'button';
        element.className = 'list-group-item list-group-item-action text-start';
        element.innerHTML = `
            <strong>${escapeHtml(adjustment.title || '日程調整')}</strong>
            <div class="small text-muted">回答期限: ${escapeHtml(formatDateWithWeekday(adjustment.deadline, '未設定'))} / 候補日: ${candidateCount}件 / 回答者: ${respondentCount}名</div>
            ${adjustment.notes ? `<div class="small multiline-text mt-1">${escapeHtml(adjustment.notes)}</div>` : ''}
        `;
        element.addEventListener('click', () => renderDateAdjustmentDetail(adjustment.id));
        list.appendChild(element);
    });
}

function bindDateAdjustmentCandidateRows() {
    const rows = $('dateAdjustmentCandidateRows');
    if (!rows) return;
    rows.querySelectorAll('.date-adjustment-candidate-up').forEach((button) => {
        button.addEventListener('click', () => {
            const row = button.closest('.date-adjustment-candidate-row');
            if (!row) return;
            const previous = row.previousElementSibling;
            if (!previous) return;
            rows.insertBefore(row, previous);
            refreshDateAdjustmentCandidateRowControls();
        });
    });
    rows.querySelectorAll('.date-adjustment-candidate-down').forEach((button) => {
        button.addEventListener('click', () => {
            const row = button.closest('.date-adjustment-candidate-row');
            if (!row) return;
            const next = row.nextElementSibling;
            if (!next) return;
            rows.insertBefore(next, row);
            refreshDateAdjustmentCandidateRowControls();
        });
    });
    rows.querySelectorAll('.date-adjustment-candidate-remove').forEach((button) => {
        button.addEventListener('click', () => {
            const allRows = rows.querySelectorAll('.date-adjustment-candidate-row');
            if (allRows.length <= 1) {
                showAlert('候補日は1件以上必要です', 'warning');
                return;
            }
            button.closest('.date-adjustment-candidate-row')?.remove();
            refreshDateAdjustmentCandidateRowControls();
        });
    });
    refreshDateAdjustmentCandidateRowControls();
}

function renderDateAdjustmentView() {
    const container = $('memberDateAdjustmentInfo');
    if (!container) return;

    container.innerHTML = `
        <div id="memberDateAdjustmentListView">
            <h6>日程調整一覧</h6>
            <div class="list-group mb-3" id="memberDateAdjustmentList"></div>
            <h6>日程調整を作成</h6>
            <div class="row g-2 mb-2">
                <div class="col-md-5"><label class="form-label">タイトル</label><input id="dateAdjustmentTitle" class="form-control" placeholder="例: 夏合宿の日程調整"></div>
                <div class="col-md-3"><label class="form-label">回答期限</label><input id="dateAdjustmentDeadline" type="date" class="form-control"></div>
                <div class="col-md-4"><label class="form-label">削除時の合言葉（任意）</label><input id="dateAdjustmentDeletePhrase" class="form-control" placeholder="任意"></div>
                <div class="col-12"><label class="form-label">説明</label><textarea id="dateAdjustmentNotes" class="form-control" rows="2" placeholder="用途や集合条件など"></textarea></div>
            </div>
            <div class="mb-2"><strong>候補日</strong></div>
            <div id="dateAdjustmentCandidateRows"></div>
            <div class="d-flex flex-wrap gap-2 mb-3">
                <button id="dateAdjustmentAddCandidateBtn" class="btn btn-outline-secondary" type="button">候補日を追加</button>
                <button id="dateAdjustmentCreateBtn" class="btn btn-primary" type="button">日程調整を作成</button>
            </div>
        </div>
        <div id="memberDateAdjustmentDetailView" hidden></div>
    `;

    const candidateRows = $('dateAdjustmentCandidateRows');
    if (candidateRows) {
        candidateRows.innerHTML = dateAdjustmentCandidateRowHtml({ date: today() }, false);
    }
    if ($('dateAdjustmentDeadline')) $('dateAdjustmentDeadline').value = today();

    $('dateAdjustmentAddCandidateBtn')?.addEventListener('click', () => {
        const rows = $('dateAdjustmentCandidateRows');
        if (!rows) return;
        rows.insertAdjacentHTML('beforeend', dateAdjustmentCandidateRowHtml({ date: today() }, true));
        bindDateAdjustmentCandidateRows();
    });
    bindDateAdjustmentCandidateRows();

    $('dateAdjustmentCreateBtn')?.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '作成中...', async () => {
        const title = $('dateAdjustmentTitle')?.value.trim() || '';
        const candidates = collectDateAdjustmentCandidates();
        if (!title) {
            showAlert('タイトルを入力してください', 'warning');
            return;
        }
        if (!candidates.length) {
            showAlert('候補日を1件以上入力してください', 'warning');
            return;
        }

        const payload = {
            title,
            deadline: $('dateAdjustmentDeadline')?.value || '',
            notes: $('dateAdjustmentNotes')?.value.trim() || '',
            delete_phrase: $('dateAdjustmentDeletePhrase')?.value.trim() || '',
            created_by: currentUserMemberName(),
            member_id: appState.currentUserMemberId,
            candidates
        };
        await saveExtra('date_adjustments', payload);
        await loadExtraData();
        showAlert('日程調整を作成しました', 'success');
    }));

    renderDateAdjustmentList();
}

function renderDateAdjustmentDetail(adjustmentId) {
    const listView = $('memberDateAdjustmentListView');
    const detailView = $('memberDateAdjustmentDetailView');
    const adjustment = appState.dateAdjustments.find((item) => String(item.id || '') === String(adjustmentId));
    if (!listView || !detailView || !adjustment) return;

    listView.hidden = true;
    detailView.hidden = false;

    const candidates = dateAdjustmentCandidates(adjustment);
    const related = dedupeDateAdjustmentResponses(appState.dateAdjustmentResponses.filter((item) => String(item.adjustment_id || '') === String(adjustment.id || '')));
    const myResponses = related.filter((item) => currentUserMatchesDateAdjustmentResponse(item));

    const candidateStats = candidates.map((candidate, index) => {
        const candidateResponses = related.filter((item) => String(item.candidate_id || '') === String(candidate.id || ''));
        const ok = candidateResponses.filter((item) => item.status === 'ok').length;
        const maybe = candidateResponses.filter((item) => item.status === 'maybe').length;
        const ng = candidateResponses.filter((item) => item.status === 'ng').length;
        const commentCount = candidateResponses.filter((item) => String(item.note || '').trim()).length;
        const score = (ok * 2) + maybe;
        return { candidate, candidateResponses, ok, maybe, ng, commentCount, score, index };
    });
    const rankedCandidates = [...candidateStats].sort((a, b) =>
        b.score - a.score
        || b.ok - a.ok
        || a.ng - b.ng
        || a.index - b.index
    );
    const rankByCandidateId = new Map(rankedCandidates.map((item, idx) => [String(item.candidate.id || ''), idx + 1]));
    const bestCandidateId = String(rankedCandidates[0]?.candidate?.id || '');

    const rows = candidateStats.map((item) => {
        const rank = rankByCandidateId.get(String(item.candidate.id || '')) || '-';
        return `<tr><td>${escapeHtml(dateAdjustmentCandidateLabel(item.candidate))}</td><td>${rank}</td><td>${item.score}</td><td>${item.ok}</td><td>${item.maybe}</td><td>${item.ng}</td><td>${item.commentCount}</td></tr>`;
    }).join('');

    const commentSections = candidateStats.map((item) => {
        const candidate = item.candidate;
        const candidateResponses = item.candidateResponses;
        const commented = candidateResponses.filter((item) => String(item.note || '').trim());
        const keywords = dateAdjustmentFrequentKeywordsFromNotes(commented.map((item) => String(item.note || '').trim()));
        const keywordBadges = keywords.length
            ? `<div class="small text-muted mb-2">頻出キーワード: ${keywords.map(([word, count]) => `<span class="badge text-bg-light me-1">${escapeHtml(word)} (${count})</span>`).join('')}</div>`
            : '<div class="small text-muted mb-2">頻出キーワード: なし</div>';
        const lines = commented.map((item) => `<li>${escapeHtml(item.name || '不明')}（${escapeHtml(dateAdjustmentStatusText(item.status || ''))}）: ${escapeHtml(String(item.note || '').trim())}</li>`).join('');
        return `
            <section class="info-block">
                <h6 class="mb-2">${escapeHtml(dateAdjustmentCandidateLabel(candidate))}</h6>
                ${keywordBadges}
                ${lines ? `<ul class="mb-0">${lines}</ul>` : '<p class="text-muted mb-0">コメントはまだありません</p>'}
            </section>
        `;
    }).join('');

    const respondentMap = new Map();
    related.forEach((item) => {
        const key = dateAdjustmentOwnerKey(item);
        if (!respondentMap.has(key)) respondentMap.set(key, { name: item.name || '不明', statuses: {}, hasComment: false });
        respondentMap.get(key).statuses[String(item.candidate_id || '')] = item.status || '';
        if (String(item.note || '').trim()) respondentMap.get(key).hasComment = true;
    });
    const respondentRowsData = Array.from(respondentMap.values());
    const answeredOwners = new Set(Array.from(respondentMap.keys()));
    const unansweredMembers = (appState.members || []).filter((member) => {
        const key = String(member.id || '').trim() ? `member:${String(member.id || '').trim()}` : `name:${memberDisplayName(member).trim()}`;
        return key && !answeredOwners.has(key);
    });
    const reminderMessage = `日程調整「${adjustment.title || '日程調整'}」が未回答です。回答期限: ${formatDateWithWeekday(adjustment.deadline, '未設定')}。ご都合の入力をお願いします。`;
    const respondentRowsHtml = (commentOnly = false) => {
        const rows = commentOnly ? respondentRowsData.filter((row) => row.hasComment) : respondentRowsData;
        if (!rows.length) {
            return `<tr><td colspan="${candidates.length + 1}" class="text-muted">${commentOnly ? 'コメント付き回答はまだありません' : '回答はまだありません'}</td></tr>`;
        }
        return rows.map((row) => `
            <tr>
                <td>${escapeHtml(row.name || '')}</td>
                ${candidates.map((candidate) => `<td>${escapeHtml(dateAdjustmentStatusLabel(row.statuses[String(candidate.id || '')] || ''))}</td>`).join('')}
            </tr>
        `).join('');
    };

    detailView.innerHTML = `
        <button class="btn btn-sm btn-outline-secondary mb-3" id="dateAdjustmentBackBtn" type="button">日程調整一覧に戻る</button>
        <section class="info-block pt-0">
            <h5>${escapeHtml(adjustment.title || '日程調整')}</h5>
            <div>回答期限: ${escapeHtml(formatDateWithWeekday(adjustment.deadline, '未設定'))}</div>
            <div>作成者: ${escapeHtml(adjustment.created_by || '未設定')}</div>
            ${adjustment.notes ? `<div class="multiline-text mt-2">${escapeHtml(adjustment.notes)}</div>` : ''}
        </section>
        <h6>候補日ごとの集計</h6>
        <div class="table-responsive mb-3">
            <table class="table table-sm table-bordered align-middle">
                <thead><tr><th>候補日</th><th>順位</th><th>スコア</th><th>○</th><th>△</th><th>×</th><th>コメント数</th></tr></thead>
                <tbody>${rows || '<tr><td colspan="7" class="text-muted">候補日がありません</td></tr>'}</tbody>
            </table>
        </div>
        ${bestCandidateId ? `<div class="alert alert-info py-2">第1候補: ${escapeHtml(dateAdjustmentCandidateLabel(candidates.find((item) => String(item.id || '') === bestCandidateId) || {}))}</div>` : ''}
        <h6>回答コメントの集計</h6>
        <div class="mb-3">${commentSections || '<p class="text-muted mb-0">コメントはまだありません</p>'}</div>
        <h6>自分の回答</h6>
        <div class="row g-2 mb-3">
            ${candidates.map((candidate) => {
                const current = myResponses.find((item) => String(item.candidate_id || '') === String(candidate.id || ''));
                return `
                    <div class="col-12">
                        <label class="form-label">${escapeHtml(dateAdjustmentCandidateLabel(candidate))}</label>
                        <div class="row g-2 align-items-center">
                            <div class="col-md-3">
                                <select class="form-select date-adjustment-my-status" data-candidate-id="${escapeHtml(String(candidate.id || ''))}">
                                    <option value="">未回答</option>
                                    <option value="ok" ${current?.status === 'ok' ? 'selected' : ''}>○ 参加可</option>
                                    <option value="maybe" ${current?.status === 'maybe' ? 'selected' : ''}>△ 調整可</option>
                                    <option value="ng" ${current?.status === 'ng' ? 'selected' : ''}>× 不可</option>
                                </select>
                            </div>
                            <div class="col-md-9">
                                <input class="form-control date-adjustment-my-note" data-candidate-id="${escapeHtml(String(candidate.id || ''))}" value="${escapeHtml(String(current?.note || ''))}" placeholder="メモ（任意）">
                            </div>
                        </div>
                    </div>
                `;
            }).join('')}
            <div class="col-12 d-flex flex-wrap gap-2">
                <button class="btn btn-primary" id="dateAdjustmentSaveResponseBtn" type="button">回答を保存</button>
                ${dateAdjustmentCanDelete(adjustment) ? '<button class="btn btn-outline-danger" id="dateAdjustmentDeleteBtn" type="button">この日程調整を削除</button>' : ''}
            </div>
        </div>
        <h6>団員の回答一覧</h6>
        <div class="form-check mb-2">
            <input class="form-check-input" type="checkbox" id="dateAdjustmentCommentOnlyToggle">
            <label class="form-check-label" for="dateAdjustmentCommentOnlyToggle">コメントあり回答のみ抽出</label>
        </div>
        <div class="table-responsive">
            <table class="table table-sm table-bordered align-middle">
                <thead><tr><th>名前</th>${candidates.map((candidate) => `<th>${escapeHtml(dateAdjustmentCandidateLabel(candidate))}</th>`).join('')}</tr></thead>
                <tbody id="dateAdjustmentRespondentBody">${respondentRowsHtml(false)}</tbody>
            </table>
        </div>
        <h6 class="mt-3">未回答者とリマインド</h6>
        <div class="info-block">
            <div class="small mb-2">未回答者: ${unansweredMembers.length}名</div>
            ${unansweredMembers.length
                ? `<ul class="mb-2">${unansweredMembers.map((member) => `<li>${escapeHtml(memberDisplayName(member) || '不明')}</li>`).join('')}</ul>`
                : '<p class="text-muted mb-2">未回答者はいません</p>'}
            <div class="d-flex flex-wrap gap-2">
                <button class="btn btn-sm btn-outline-primary" id="dateAdjustmentCopyReminderBtn" type="button" ${unansweredMembers.length ? '' : 'disabled'}>リマインド文面をコピー</button>
            </div>
        </div>
    `;

    $('dateAdjustmentBackBtn')?.addEventListener('click', () => {
        detailView.hidden = true;
        listView.hidden = false;
        renderDateAdjustmentList();
    });

    $('dateAdjustmentCommentOnlyToggle')?.addEventListener('change', (event) => {
        const checked = Boolean(event.currentTarget?.checked);
        const body = $('dateAdjustmentRespondentBody');
        if (body) body.innerHTML = respondentRowsHtml(checked);
    });

    $('dateAdjustmentCopyReminderBtn')?.addEventListener('click', async () => {
        if (!unansweredMembers.length) {
            showAlert('未回答者はいません', 'info');
            return;
        }
        try {
            await navigator.clipboard.writeText(reminderMessage);
            showAlert('リマインド文面をコピーしました', 'success');
        } catch {
            showAlert(`コピーに失敗しました。文面: ${reminderMessage}`, 'warning');
        }
    });

    $('dateAdjustmentSaveResponseBtn')?.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '保存中...', async () => {
        const name = currentUserMemberName();
        if (!name) {
            showAlert('ログイン中の団員情報が見つかりません', 'warning');
            return;
        }

        const allExisting = appState.dateAdjustmentResponses.filter((item) => String(item.adjustment_id || '') === String(adjustment.id || '') && currentUserMatchesDateAdjustmentResponse(item));
        const existingByCandidate = new Map();
        allExisting.forEach((item) => {
            const key = String(item.candidate_id || '');
            const list = existingByCandidate.get(key) || [];
            list.push(item);
            existingByCandidate.set(key, list);
        });

        for (const candidate of candidates) {
            const candidateId = String(candidate.id || '');
            const status = detailView.querySelector(`.date-adjustment-my-status[data-candidate-id="${CSS.escape(candidateId)}"]`)?.value || '';
            const note = detailView.querySelector(`.date-adjustment-my-note[data-candidate-id="${CSS.escape(candidateId)}"]`)?.value?.trim() || '';
            const existing = existingByCandidate.get(candidateId) || [];
            const primary = existing[0];
            const duplicates = existing.slice(1);

            if (status) {
                const payload = {
                    adjustment_id: adjustment.id,
                    candidate_id: candidate.id,
                    name,
                    member_id: appState.currentUserMemberId,
                    status,
                    note
                };
                if (primary?.id) {
                    await request(`/api/extra/date_adjustment_responses/${encodeURIComponent(primary.id)}`, jsonOptions('PUT', payload));
                } else {
                    await saveExtra('date_adjustment_responses', payload);
                }
            } else if (primary?.id) {
                await request(`/api/extra/date_adjustment_responses/${encodeURIComponent(primary.id)}`, { method: 'DELETE' });
            }

            for (const duplicate of duplicates) {
                if (duplicate?.id) {
                    await request(`/api/extra/date_adjustment_responses/${encodeURIComponent(duplicate.id)}`, { method: 'DELETE' });
                }
            }
        }

        await loadExtraData();
        renderDateAdjustmentDetail(adjustment.id);
        showAlert('回答を保存しました', 'success');
    }));

    $('dateAdjustmentDeleteBtn')?.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', async () => {
        if (!dateAdjustmentCanDelete(adjustment)) {
            showAlert('削除権限がありません', 'warning');
            return;
        }
        if (adjustment.delete_phrase) {
            const phrase = prompt('削除時の合言葉を入力してください');
            if (phrase === null) return;
            if (phrase !== adjustment.delete_phrase) {
                showAlert('削除時の合言葉が違います', 'danger');
                return;
            }
        }
        if (!confirmDelete()) return;

        const relatedResponses = appState.dateAdjustmentResponses.filter((item) => String(item.adjustment_id || '') === String(adjustment.id || ''));
        await Promise.all(relatedResponses.filter((item) => item.id).map((item) => request(`/api/extra/date_adjustment_responses/${encodeURIComponent(item.id)}`, { method: 'DELETE' })));
        await request(`/api/extra/date_adjustments/${encodeURIComponent(adjustment.id)}`, { method: 'DELETE' });
        await loadExtraData();
        renderDateAdjustmentView();
        showAlert('日程調整を削除しました', 'success');
    }));
}

function renderMemberEventView() {
    const c = $('memberEventInfo'); if (!c) return;
    c.innerHTML = `
        <div id="memberEventListView">
            <h6>イベント一覧</h6>
            <div class="list-group mb-3" id="memberEventList"></div>
            <h6>イベント登録</h6>
            <div class="row g-2 mb-3">
                <div class="col-md-4"><label class="form-label">イベント名</label><input id="memberEventTitle" class="form-control"></div>
                <div class="col-md-3"><label class="form-label">開催日</label><input id="memberEventDate" type="date" class="form-control"></div>
                <div class="col-md-2"><label class="form-label">開始時刻</label><input id="memberEventStartTime" type="time" class="form-control"></div>
                <div class="col-md-3"><label class="form-label">回答期限</label><input id="memberEventDeadline" type="date" class="form-control"></div>
                <div class="col-md-6"><label class="form-label">会費</label><input id="memberEventFee" class="form-control" placeholder="例: 4,000円"></div>
                <div class="col-12"><label class="form-label">イベント概要/備考</label><textarea id="memberEventNotes" class="form-control" rows="3"></textarea></div>
                <div class="col-md-6"><label class="form-label">削除時の合言葉</label><input id="memberEventDeletePhrase" class="form-control"></div>
                <div class="col-md-3 d-flex align-items-end"><button id="memberEventCreateBtn" class="btn btn-primary w-100" type="button">イベント登録</button></div>
            </div>
        </div>
        <div id="memberEventDetailView" hidden></div>`;
    $('memberEventDate').value = today();
    $('memberEventDeadline').value = today();
    $('memberEventCreateBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '作成中...', async () => {
        const payload = {
            title: $('memberEventTitle').value.trim(),
            date: $('memberEventDate').value,
            start_time: $('memberEventStartTime').value,
            deadline: $('memberEventDeadline').value,
            notes: $('memberEventNotes').value.trim(),
            delete_phrase: $('memberEventDeletePhrase').value.trim(),
            fee: $('memberEventFee') ? $('memberEventFee').value.trim() : '',
            url: ''
        };
        if (!payload.title || !payload.date || !payload.start_time || !payload.deadline || !payload.delete_phrase) {
            showAlert('イベント名、開催日、開始時刻、回答期限、削除時の合言葉を入力してください', 'warning');
            return;
        }
        await request('/api/events', jsonOptions('POST', payload));
        showAlert('イベントを作成しました', 'success');
        await loadEvents(); await loadExtraData();
    }));
    renderMemberEventList();
}

function renderMemberEventList() {
    const list = $('memberEventList');
    if (!list) return;
    const events = sortedEvents(appState.events);
    list.innerHTML = events.length ? '' : '<p class="text-muted mb-0">イベントはまだありません</p>';
    events.forEach((event) => {
        const item = document.createElement('button');
        item.className = 'list-group-item list-group-item-action text-start';
        item.type = 'button';
        const responseCount = uniqueEventResponses(appState.eventResponses.filter((r) => String(r.event_id) === String(event.id))).length;
        item.innerHTML = `
            <strong>${escapeHtml(event.title)}</strong>
            <div class="small text-muted">開催: ${escapeHtml(eventDateTimeLabel(event))} / 回答期限: ${escapeHtml(formatDateWithWeekday(event.deadline))}${event.fee ? ` / 会費: ${escapeHtml(event.fee)}` : ''}</div>
            ${event.notes ? `<div class="small multiline-text mt-1">${escapeHtml(event.notes)}</div>` : ''}
            <div class="small text-muted mt-1">回答数: ${responseCount}</div>
        `;
        item.addEventListener('click', () => renderMemberEventDetail(event.id));
        list.appendChild(item);
    });
}

function renderMemberEventDetail(id) {
    const listView = $('memberEventListView');
    const detailView = $('memberEventDetailView');
    const event = appState.events.find((item) => String(item.id) === String(id));
    if (!listView || !detailView || !event) return;
    listView.hidden = true;
    detailView.hidden = false;
    const responses = appState.eventResponses.filter((r) => String(r.event_id) === String(id));
    const groupedResponsesHtml = renderGroupedEventResponses(responses);
    detailView.innerHTML = `
        <button class="btn btn-sm btn-outline-secondary mb-3" id="memberEventBackBtn" type="button">イベント一覧に戻る</button>
        <section class="info-block pt-0">
            <h5>${escapeHtml(event.title)}</h5>
            <div>開催: ${escapeHtml(eventDateTimeLabel(event))}</div>
            <div>回答期限: ${escapeHtml(formatDateWithWeekday(event.deadline))}${event.fee ? ` / 会費: ${escapeHtml(event.fee)}` : ''}</div>
            ${event.notes ? `<div class="multiline-text mt-2">${escapeHtml(event.notes)}</div>` : ''}
        </section>
        <div class="row g-2 align-items-end mb-3">
            <div class="col-md-7"><label class="form-label">参加/不参加</label><select id="eventResponseStatus" class="form-select"><option>参加</option><option>不参加</option></select></div>
            <div class="col-md-3"><button id="eventResponseSaveBtn" class="btn btn-primary w-100" type="button">登録</button></div>
        </div>
        <div class="d-flex flex-wrap gap-2 mb-3">
            <button class="btn btn-outline-danger" id="memberEventDeleteBtn" type="button">イベント削除</button>
        </div>
        <h6>回答状況</h6>
        ${groupedResponsesHtml}
    `;
    $('memberEventBackBtn').addEventListener('click', () => {
        detailView.hidden = true;
        listView.hidden = false;
        renderMemberEventList();
    });
    $('eventResponseSaveBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '登録中...', async () => {
        const name = currentUserMemberName(); const status = $('eventResponseStatus').value;
        if (!name) { showAlert('ログイン中の団員情報が見つかりません', 'warning'); return; }
        const existingResponses = appState.eventResponses.filter((r) => String(r.event_id) === String(id) && String(r.name || '') === String(name));
        const existing = existingResponses[0];
        const payload = { event_id: id, name, status };
        if (existing?.id) {
            await request(`/api/extra/event_responses/${existing.id}`, jsonOptions('PUT', payload));
            await Promise.all(existingResponses.slice(1).filter((r) => r.id).map((r) => request(`/api/extra/event_responses/${r.id}`, { method: 'DELETE' })));
            showAlert('イベント出欠を上書きしました', 'success');
        } else {
            await saveExtra('event_responses', payload);
            showAlert('イベント出欠を登録しました', 'success');
        }
        await loadExtraData();
        renderMemberEventDetail(id);
    }));
    $('memberEventDeleteBtn').addEventListener('click', (clickEvent) => withButtonStatus(clickEvent.currentTarget, '削除中...', async () => {
        const phrase = prompt('削除時の合言葉を入力してください');
        if (phrase === null) return;
        if (phrase !== (event.delete_phrase || '')) {
            showAlert('削除時の合言葉が違います', 'danger');
            return;
        }
        if (!confirmDelete()) return;
        await deleteEventById(id, false);
        renderMemberEventView();
    }));
}

function uniqueEventResponses(responses) {
    const byName = new Map();
    responses.forEach((response) => {
        const key = String(response.name || '');
        if (!key) return;
        byName.set(key, response);
    });
    return Array.from(byName.values());
}

function renderGroupedEventResponses(responses) {
    const uniqueResponses = uniqueEventResponses(responses);
    if (!uniqueResponses.length) return '<p class="text-muted">回答はまだありません</p>';
    const groups = ['参加', '不参加'];
    return groups.map((status) => {
        const rows = uniqueResponses.filter((r) => String(r.status || '') === status);
        const body = rows.length
            ? `<div class="list-group">${rows.map((r) => `<div class="list-group-item d-flex justify-content-between align-items-center"><span>${escapeHtml(r.name || '')}</span><span class="badge text-bg-secondary">${escapeHtml(status)}</span></div>`).join('')}</div>`
            : '<p class="text-muted small mb-0">該当者はいません</p>';
        return `<section class="mb-3"><h6>${status}（${rows.length}名）</h6>${body}</section>`;
    }).join('');
}

// 楽曲情報は一覧表示と詳細表示を同じ領域で切り替える。
// 選択中の ID を appState に持たせ、戻る操作でも余計な再取得をしない。
function renderPieceInfoView() {
    const c = $('memberPieceInfo'); if (!c) return;
    const selectedPieceInfo = appState.pieceInfos.find((info) => String(info.id || '') === String(appState.selectedPieceInfoId || ''));
    
    if (selectedPieceInfo) {
        // Detail view: show selected piece info with all details and URL button
        const performance = appState.performances.find((perf) => String(perf.id || '') === String(selectedPieceInfo.performance_id || ''));
        c.innerHTML = `
            <button class="btn btn-sm btn-outline-secondary mb-3" id="pieceInfoBackBtn" type="button">曲リストに戻る</button>
            <section class="info-block">
                <div class="small text-muted">${escapeHtml(performance?.title || '演奏会未設定')}</div>
                <h5 class="mb-2">${escapeHtml(selectedPieceInfo.piece || selectedPieceInfo.title || '')}</h5>
                ${selectedPieceInfo.description || selectedPieceInfo.notes ? `<div class="multiline-text mb-3">${convertUrlsToLinks(selectedPieceInfo.description || selectedPieceInfo.notes)}</div>` : ''}
                ${selectedPieceInfo.url ? `<button class="btn btn-primary btn-sm" id="pieceInfoUrlBtn" type="button">楽曲情報を表示</button>` : ''}
            </section>
        `;
        $('pieceInfoBackBtn')?.addEventListener('click', () => {
            appState.selectedPieceInfoId = null;
            renderPieceInfoView();
        });
        $('pieceInfoUrlBtn')?.addEventListener('click', () => {
            if (selectedPieceInfo.url) window.open(selectedPieceInfo.url, '_blank', 'noopener');
        });
    } else {
        // List view: show all performances and their pieces (without descriptions)
        c.innerHTML = appState.performances.map((perf) => {
            const rows = appState.pieceInfos.filter((x) => String(x.performance_id || '') === String(perf.id));
            const fallback = (perf.pieces || []).map((p) => ({ title: performancePieceLabel(p), description: '', id: null }));
            let list = rows.length ? rows : fallback;
            
            // Sort by performance piece order
            const performancePieceOrder = (perf.pieces || []).map(p => performancePieceLabel(p));
            list = list.sort((a, b) => {
                const aLabel = a.piece || a.title || '';
                const bLabel = b.piece || b.title || '';
                const aIndex = performancePieceOrder.indexOf(aLabel);
                const bIndex = performancePieceOrder.indexOf(bLabel);
                return (aIndex >= 0 ? aIndex : 999) - (bIndex >= 0 ? bIndex : 999);
            });
            
            return `<section class="mb-3"><h5>${escapeHtml(perf.title)}</h5><div class="list-group">${list.map((r) => `
                <button class="list-group-item list-group-item-action text-start" type="button" ${r.id ? `data-piece-info-id="${escapeHtml(String(r.id))}"` : ''}>
                    ${escapeHtml(r.piece || r.title || '')}
                </button>
            `).join('')}</div></section>`;
        }).join('');
        c.querySelectorAll('[data-piece-info-id]').forEach((button) => {
            button.addEventListener('click', () => {
                appState.selectedPieceInfoId = button.dataset.pieceInfoId || null;
                renderPieceInfoView();
            });
        });
    }
}

function renderPracticeInstructionView() {
    const container = $('memberPracticeInstructionInfo');
    if (!container) return;

    const upcomingPerformances = [...(appState.performances || [])]
        .filter((perf) => perf.date && perf.date >= today())
        .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')) || String(a.title || '').localeCompare(String(b.title || ''), 'ja'));

    const rows = upcomingPerformances.map((perf) => ({
        performanceId: String(perf.id || ''),
        title: String(perf.title || ''),
        date: String(perf.date || ''),
        pieces: normalizePerformancePieces(perf.pieces || []).map(performancePieceLabel).filter(Boolean)
    }));

    if (!rows.length) {
        appState.selectedPracticeInstructionContext = null;
        container.innerHTML = '<p class="text-muted mb-0">未開催の演奏会はありません</p>';
        return;
    }

    const hasPiece = (performanceId, piece) => rows.some((row) => row.performanceId === String(performanceId || '') && row.pieces.includes(piece));
    const selectedContext = appState.selectedPracticeInstructionContext;
    if (!selectedContext || !hasPiece(selectedContext.performanceId, selectedContext.piece)) {
        appState.selectedPracticeInstructionContext = null;
    }

    if (!appState.selectedPracticeInstructionContext) {
        container.innerHTML = `
            <section class="info-block mb-3">
                <h5 class="mb-2">未開催演奏会の曲一覧</h5>
                <p class="text-muted small mb-0">曲を選択すると、曲ごとの練習指示登録・編集画面に遷移します。<span class="badge text-bg-success ms-1">指示あり</span> が登録済みの目印です。</p>
            </section>
            ${rows.map((row) => {
                const heading = `${formatDateWithWeekday(row.date, row.date)} ${row.title}`.trim();
                if (!row.pieces.length) {
                    return `
                        <section class="mb-3">
                            <h6 class="mb-2">${escapeHtml(heading)}</h6>
                            <p class="text-muted small mb-0">曲がまだ登録されていません</p>
                        </section>
                    `;
                }
                return `
                    <section class="mb-3">
                        <h6 class="mb-2">${escapeHtml(heading)}</h6>
                        <div class="list-group">
                            ${row.pieces.map((piece) => {
                                const existing = appState.practiceInstructions.find((item) => String(item.performance_id || '') === row.performanceId && String(item.piece || '') === piece);
                                return `
                                    <button class="list-group-item list-group-item-action d-flex justify-content-between align-items-center gap-2 text-start" type="button" data-practice-performance-id="${escapeHtml(row.performanceId)}" data-practice-piece="${escapeHtml(encodeURIComponent(piece))}">
                                        <span>${escapeHtml(piece)}</span>
                                        ${existing && String(existing.practice_notes || '').trim() ? '<span class="badge text-bg-success">指示あり</span>' : ''}
                                    </button>
                                `;
                            }).join('')}
                        </div>
                    </section>
                `;
            }).join('')}
        `;

        container.querySelectorAll('[data-practice-performance-id][data-practice-piece]').forEach((button) => {
            button.addEventListener('click', () => {
                const performanceId = button.dataset.practicePerformanceId || '';
                const piece = decodeURIComponent(button.dataset.practicePiece || '');
                appState.selectedPracticeInstructionContext = { performanceId, piece };
                renderPracticeInstructionView();
            });
        });
        return;
    }

    const performanceId = String(appState.selectedPracticeInstructionContext.performanceId || '');
    const piece = String(appState.selectedPracticeInstructionContext.piece || '');
    const performance = appState.performances.find((perf) => String(perf.id || '') === performanceId);
    const existing = appState.practiceInstructions.find((item) => String(item.performance_id || '') === performanceId && String(item.piece || '') === piece);
    const initialNotes = String(existing?.practice_notes || '');

    container.innerHTML = `
        <section class="info-block mb-3">
            <button class="btn btn-sm btn-outline-secondary mb-3" id="practiceInstructionBackBtn" type="button">曲一覧に戻る</button>
            <h5 class="mb-1">${escapeHtml(performance?.title || '演奏会未設定')}</h5>
            <div class="small text-muted mb-2">${escapeHtml(formatDateWithWeekday(performance?.date || '', '開催日未設定'))}</div>
            <h6 class="mb-0">${escapeHtml(piece)}</h6>
        </section>
        <section class="info-block">
            <div class="mb-3">
                <label class="form-label" for="memberPracticeInstructionNotes">練習指示内容</label>
                <textarea class="form-control" id="memberPracticeInstructionNotes" rows="8">${escapeHtml(initialNotes)}</textarea>
                <div class="form-text">URLを記載するとリンクとして表示されます。</div>
            </div>
            <div class="d-flex flex-wrap gap-2">
                <button class="btn btn-success" id="memberPracticeInstructionSaveBtn" type="button">保存</button>
                <button class="btn btn-danger" id="memberPracticeInstructionDeleteBtn" type="button" ${existing ? '' : 'disabled'}>削除</button>
            </div>
        </section>
    `;

    $('practiceInstructionBackBtn')?.addEventListener('click', () => {
        appState.selectedPracticeInstructionContext = null;
        renderPracticeInstructionView();
    });

    $('memberPracticeInstructionSaveBtn')?.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '保存中...', async () => {
        const notes = String($('memberPracticeInstructionNotes')?.value || '').trim();
        if (!notes) {
            showAlert('練習指示内容を入力してください', 'warning');
            return;
        }
        const payload = {
            performance_id: performanceId,
            piece,
            practice_notes: notes,
            performance_instruction: ''
        };
        if (existing?.id) {
            await request(`/api/extra/practice_instructions/${encodeURIComponent(existing.id)}`, jsonOptions('PUT', payload));
        } else {
            await saveExtra('practice_instructions', payload);
        }
        await loadExtraData();
        showAlert('練習指示を保存しました', 'success');
    }));

    $('memberPracticeInstructionDeleteBtn')?.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', async () => {
        if (!existing?.id) {
            showAlert('削除対象の練習指示がありません', 'warning');
            return;
        }
        if (!confirmDelete()) return;
        await request(`/api/extra/practice_instructions/${encodeURIComponent(existing.id)}`, { method: 'DELETE' });
        await loadExtraData();
        showAlert('練習指示を削除しました', 'success');
    }));
}


function desiredPieceCurrentVoterKey() {
    return String(appState.currentUserMemberId || currentUserMemberName() || '');
}

function desiredPieceVotes(item) {
    return Array.isArray(item.votes) ? item.votes : [];
}

function desiredPieceHasVoted(item) {
    const key = desiredPieceCurrentVoterKey();
    const name = currentUserMemberName();
    return desiredPieceVotes(item).some((vote) => String(vote.member_id || vote.name || vote) === key || (name && String(vote.name || vote) === name));
}

function desiredPieceIsOwner(item) {
    const memberId = String(appState.currentUserMemberId || '');
    const name = currentUserMemberName();
    return (memberId && String(item.member_id || '') === memberId) || (name && String(item.registered_by || item.name || '') === name);
}

function clearDesiredPieceForm() {
    ['desiredPieceId', 'desiredPieceTitle', 'desiredPieceComposer', 'desiredPieceDuration', 'desiredPieceFormation', 'desiredPieceNotes'].forEach((id) => { if ($(id)) $(id).value = ''; });
    if ($('desiredPieceGenre')) $('desiredPieceGenre').value = 'クラシック';
}

function fillDesiredPieceForm(id) {
    const item = appState.desiredPieces.find((piece) => String(piece.id || '') === String(id));
    if (!item) return;
    $('desiredPieceId').value = item.id || '';
    $('desiredPieceTitle').value = item.title || item.piece || '';
    $('desiredPieceComposer').value = item.composer || '';
    $('desiredPieceDuration').value = item.duration || '';
    $('desiredPieceGenre').value = item.genre || 'クラシック';
    $('desiredPieceFormation').value = item.formation || '';
    $('desiredPieceNotes').value = item.notes || '';
    $('desiredPieceTitle').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// 演奏希望曲は「登録」と「投票」が混在するため、
// 所有者だけ編集/削除、自分は 1 票だけ投票、というルールを UI 側でも明示する。
function renderDesiredPieceView() {
    const c = $('memberDesiredPieceInfo');
    if (!c) return;

    const currentMember = currentUserMember();
    const canSubmit = Boolean(currentMember || appState.currentUserName);
    const sorted = [...(appState.desiredPieces || [])].sort((a, b) => {
        const voteDelta = desiredPieceVotes(b).length - desiredPieceVotes(a).length;
        if (voteDelta !== 0) return voteDelta;
        return String(a.title || a.piece || '').localeCompare(String(b.title || b.piece || ''), 'ja');
    });

    c.innerHTML = `
        <section class="info-block mb-3">
            <h5 class="mb-3">演奏希望曲を登録</h5>
            <input type="hidden" id="desiredPieceId">
            <div class="row g-2">
                <div class="col-md-6"><input id="desiredPieceTitle" class="form-control" placeholder="曲名"></div>
                <div class="col-md-6"><input id="desiredPieceComposer" class="form-control" placeholder="作曲者"></div>
                <div class="col-md-4"><input id="desiredPieceDuration" class="form-control" placeholder="演奏時間（例: 7:30）"></div>
                <div class="col-md-4">
                    <select id="desiredPieceGenre" class="form-select">
                        <option value="クラシック">クラシック</option>
                        <option value="ポップス">ポップス</option>
                        <option value="映画音楽">映画音楽</option>
                        <option value="その他">その他</option>
                    </select>
                </div>
                <div class="col-md-4"><input id="desiredPieceFormation" class="form-control" placeholder="編成"></div>
                <div class="col-12"><textarea id="desiredPieceNotes" class="form-control" rows="2" placeholder="補足・理由"></textarea></div>
            </div>
            <div class="mt-3 d-flex gap-2">
                <button id="desiredPieceSaveBtn" class="btn btn-primary" type="button" ${canSubmit ? '' : 'disabled'}>保存</button>
                <button id="desiredPieceClearBtn" class="btn btn-outline-secondary" type="button">クリア</button>
            </div>
            ${canSubmit ? '' : '<p class="text-muted small mt-2 mb-0">投票・登録には団員としてログインしてください。</p>'}
        </section>
        <section>
            <h5 class="mb-3">希望曲一覧</h5>
            ${sorted.length ? `<div class="list-group">${sorted.map((item) => {
                const id = String(item.id || '');
                const title = item.title || item.piece || '（無題）';
                const votes = desiredPieceVotes(item).length;
                const voted = desiredPieceHasVoted(item);
                const owner = desiredPieceIsOwner(item);
                const canVote = canSubmit;
                return `
                    <article class="list-group-item">
                        <div class="d-flex justify-content-between align-items-start gap-3">
                            <div class="flex-grow-1">
                                <h6 class="mb-1">${escapeHtml(title)}</h6>
                                <div class="small text-muted mb-1">${escapeHtml(item.composer || '作曲者未設定')} / ${escapeHtml(item.genre || 'ジャンル未設定')} / ${escapeHtml(item.duration || '時間未設定')}</div>
                                ${item.formation ? `<div class="small text-muted mb-1">編成: ${escapeHtml(item.formation)}</div>` : ''}
                                ${item.notes ? `<div class="small">${escapeHtml(item.notes)}</div>` : ''}
                                <div class="small text-muted mt-1">登録者: ${escapeHtml(item.registered_by || item.name || '未設定')}</div>
                            </div>
                            <span class="badge text-bg-secondary">${votes} 票</span>
                        </div>
                        <div class="mt-2 d-flex gap-2 flex-wrap">
                            <button class="btn btn-sm ${voted ? 'btn-success' : 'btn-outline-success'} desired-piece-vote-btn" type="button" data-desired-piece-id="${escapeHtml(id)}" ${canVote ? '' : 'disabled'}>${voted ? '投票済み' : '投票する'}</button>
                            ${owner ? `<button class="btn btn-sm btn-outline-primary desired-piece-edit-btn" type="button" data-desired-piece-id="${escapeHtml(id)}">編集</button><button class="btn btn-sm btn-outline-danger desired-piece-delete-btn" type="button" data-desired-piece-id="${escapeHtml(id)}">削除</button>` : ''}
                        </div>
                    </article>
                `;
            }).join('')}</div>` : '<p class="text-muted mb-0">演奏希望曲はまだありません</p>'}
        </section>
    `;

    $('desiredPieceSaveBtn')?.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '保存中...', () => saveDesiredPiece()));
    $('desiredPieceClearBtn')?.addEventListener('click', clearDesiredPieceForm);
    c.querySelectorAll('.desired-piece-vote-btn').forEach((button) => button.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '投票中...', () => toggleDesiredPieceVote(button.dataset.desiredPieceId || ''))));
    c.querySelectorAll('.desired-piece-edit-btn').forEach((button) => button.addEventListener('click', () => fillDesiredPieceForm(button.dataset.desiredPieceId || '')));
    c.querySelectorAll('.desired-piece-delete-btn').forEach((button) => button.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', () => deleteDesiredPiece(button.dataset.desiredPieceId || ''))));
}

function renderPaymentFeeSettings() {
    const orgMembershipFee = $('orgMembershipFee');
    const perfFeeSettings = $('performanceFeeSettings');
    if (!orgMembershipFee || !perfFeeSettings) return;
    
    // 団費設定の読み込み
    const org = currentOrgSetting();
    const membershipFee = org.membership_fee_amount || 0;
    orgMembershipFee.value = membershipFee > 0 ? String(membershipFee) : '';
    
    // 演奏会費設定の表示
    perfFeeSettings.innerHTML = appState.performances.length
        ? `<div class="list-group">${appState.performances.map((perf) => `
            <div class="list-group-item">
                <div class="row g-3 align-items-end">
                    <div class="col-md-6">
                        <strong>${escapeHtml(perf.title)}</strong>
                        <div class="small text-muted">${escapeHtml(formatDateWithWeekday(perf.date))}</div>
                    </div>
                    <div class="col-md-4">
                        <label class="form-label">演奏会費（円）</label>
                        <input type="number" min="0" step="1" class="form-control performance-fee-amount" data-performance-id="${escapeHtml(String(perf.id))}" value="${Number(perf.performance_fee_amount || 0) > 0 ? perf.performance_fee_amount : ''}" placeholder="例: 5000">
                    </div>
                    <div class="col-md-2">
                        <button class="btn btn-sm btn-outline-primary save-perf-fee-btn" type="button" data-performance-id="${escapeHtml(String(perf.id))}">保存</button>
                    </div>
                </div>
            </div>
        `).join('')}</div>`
        : '<p class="text-muted mb-0">演奏会情報はまだありません</p>';
    
    // イベントリスナー設定
    $('saveOrgMembershipFeeBtn')?.addEventListener('click', saveOrgMembershipFee);
    perfFeeSettings.querySelectorAll('.save-perf-fee-btn').forEach((btn) => {
        btn.addEventListener('click', () => savePerformanceFee(btn.dataset.performanceId));
    });
}

async function saveOrgMembershipFee() {
    const amount = Number($('orgMembershipFee')?.value || 0);
    const current = currentOrgSetting();
    const payload = {
        name: current.name || '',
        short_name: current.short_name || current.shortName || '',
        icon_url: current.icon_url || current.iconUrl || '',
        membership_fee_amount: amount
    };
    if (current.id) {
        await request(`/api/extra/org_settings/${encodeURIComponent(current.id)}`, jsonOptions('PUT', payload));
    } else {
        await saveExtra('org_settings', payload);
    }
    await loadExtraData();
    showAlert('団費を保存しました', 'success');
    renderPaymentAdmin();
}

async function savePerformanceFee(performanceId) {
    const amount = Number($(`input[data-performance-id="${performanceId}"]`)?.value || 0);
    const perf = appState.performances.find((p) => String(p.id || '') === String(performanceId));
    if (!perf) {
        showAlert('演奏会が見つかりません', 'warning');
        return;
    }
    const payload = { ...perf, performance_fee_amount: amount };
    await request(`/api/performances/${encodeURIComponent(perf.id)}`, jsonOptions('PUT', payload));
    await loadEssentialData();
    showAlert('演奏会費を保存しました', 'success');
    renderPaymentAdmin();
}

async function saveDesiredPiece() {
    const title = $('desiredPieceTitle')?.value.trim() || '';
    if (!title) { showAlert('曲名を入力してください', 'warning'); return; }
    const member = currentUserMember();
    const id = $('desiredPieceId')?.value || '';
    const current = appState.desiredPieces.find((item) => String(item.id || '') === String(id));
    const payload = {
        title,
        composer: $('desiredPieceComposer')?.value.trim() || '',
        duration: $('desiredPieceDuration')?.value.trim() || '',
        genre: $('desiredPieceGenre')?.value || 'クラシック',
        formation: $('desiredPieceFormation')?.value.trim() || '',
        notes: $('desiredPieceNotes')?.value.trim() || '',
        member_id: current?.member_id || member?.id || appState.currentUserMemberId || '',
        registered_by: current?.registered_by || currentUserMemberName(),
        votes: desiredPieceVotes(current || [])
    };
    if (id) await request(`/api/extra/desired_pieces/${encodeURIComponent(id)}`, jsonOptions('PUT', payload));
    else await saveExtra('desired_pieces', payload);
    clearDesiredPieceForm();
    await loadExtraData();
    showAlert('演奏希望曲を保存しました', 'success');
}

async function toggleDesiredPieceVote(id) {
    const item = appState.desiredPieces.find((piece) => String(piece.id || '') === String(id));
    if (!item) return;
    const key = desiredPieceCurrentVoterKey();
    const name = currentUserMemberName();
    let votes = desiredPieceVotes(item).filter((vote) => String(vote.member_id || vote.name || vote) !== key && (!name || String(vote.name || vote) !== name));
    if (!desiredPieceHasVoted(item)) {
        votes.push({ member_id: appState.currentUserMemberId || '', name });
    }
    await request(`/api/extra/desired_pieces/${encodeURIComponent(id)}`, jsonOptions('PUT', { ...item, votes }));
    await loadExtraData();
}

async function deleteDesiredPiece(id) {
    if (!id || !confirmDelete()) return;
    await request(`/api/extra/desired_pieces/${encodeURIComponent(id)}`, { method: 'DELETE' });
    clearDesiredPieceForm();
    await loadExtraData();
    showAlert('演奏希望曲を削除しました', 'success');
}

function promotionIsOwner(item) {
    const currentId = String(appState.currentUserMemberId || '');
    const currentName = currentUserMemberName();
    return (currentId && String(item?.member_id || '') === currentId)
        || (currentName && String(item?.registered_by || '') === currentName);
}

function fillPromotionForm(id) {
    const item = appState.promotions.find((promotion) => String(promotion.id || '') === String(id));
    if (!item) return;
    if ($('promotionId')) $('promotionId').value = item.id || '';
    if ($('promotionTitle')) $('promotionTitle').value = item.title || '';
    if ($('promotionSummary')) $('promotionSummary').value = item.summary || item.description || '';
    if ($('promotionImageFile')) $('promotionImageFile').value = '';
    if ($('promotionImagePreview')) $('promotionImagePreview').innerHTML = item.image_url ? `<img src="${escapeHtml(item.image_url)}" class="img-fluid rounded border" alt="宣伝画像">` : '';
}

function clearPromotionForm() {
    if ($('promotionId')) $('promotionId').value = '';
    if ($('promotionTitle')) $('promotionTitle').value = '';
    if ($('promotionSummary')) $('promotionSummary').value = '';
    if ($('promotionImageFile')) $('promotionImageFile').value = '';
    if ($('promotionImagePreview')) $('promotionImagePreview').innerHTML = '';
}

async function previewPromotionImage(event) {
    const file = event?.target?.files?.[0];
    if (!file || !$('promotionImagePreview')) return;
    const dataUrl = await fileToDataUrl(file);
    $('promotionImagePreview').innerHTML = `<img src="${escapeHtml(dataUrl)}" class="img-fluid rounded border" alt="宣伝画像プレビュー">`;
}

// 宣伝機能は画像付き投稿のため、一覧描画時は本文よりも
// 投稿者・登録日・所有権判定が追いやすい構造を優先している。
function renderPromotionView() {
    const c = $('memberPromotionInfo');
    if (!c) return;
    const items = [...(appState.promotions || [])].sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    c.innerHTML = `
        <div class="info-block">
            <input type="hidden" id="promotionId">
            <div class="row g-3">
                <div class="col-md-6"><label class="form-label">タイトル</label><input class="form-control" id="promotionTitle"></div>
                <div class="col-12"><label class="form-label">概要</label><textarea class="form-control" id="promotionSummary" rows="3"></textarea></div>
                <div class="col-md-6"><label class="form-label">画像登録</label><input class="form-control" id="promotionImageFile" type="file" accept="image/*"></div>
                <div class="col-md-6"><div id="promotionImagePreview"></div></div>
                <div class="col-12 d-flex flex-wrap gap-2">
                    <button class="btn btn-success" id="promotionSaveBtn" type="button">登録</button>
                    <button class="btn btn-outline-secondary" id="promotionClearBtn" type="button">クリア</button>
                </div>
            </div>
        </div>
        <div class="mt-3">${items.length ? items.map((item) => {
            const own = promotionIsOwner(item);
            const registeredAt = item.created_at || item.updated_at || '';
            return `<article class="info-block desired-piece-card">
                <div class="d-flex flex-wrap justify-content-between gap-3 align-items-start">
                    <div class="flex-grow-1">
                        <h5 class="mb-1">${escapeHtml(item.title || '')}</h5>
                        ${item.summary ? `<div class="small multiline-text mt-2">${escapeHtml(item.summary)}</div>` : ''}
                        <div class="small text-muted mt-2">登録者: ${escapeHtml(item.registered_by || '未登録')}</div>
                        <div class="small text-muted">登録日: ${escapeHtml(registeredAt ? formatDateTimeLabel(registeredAt) : '未登録')}</div>
                    </div>
                    ${item.image_url ? `<div style="max-width: 240px;"><img src="${escapeHtml(item.image_url)}" class="img-fluid rounded border" alt="宣伝画像"></div>` : ''}
                </div>
                ${own ? `<div class="d-flex flex-wrap gap-2 mt-3"><button class="btn btn-sm btn-outline-primary promotion-edit-btn" type="button" data-promotion-id="${escapeHtml(String(item.id || ''))}">編集</button><button class="btn btn-sm btn-outline-danger promotion-delete-btn" type="button" data-promotion-id="${escapeHtml(String(item.id || ''))}">削除</button></div>` : ''}
            </article>`;
        }).join('') : '<p class="text-muted mb-0">宣伝はまだ登録されていません</p>'}</div>
    `;
    $('promotionSaveBtn')?.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '保存中...', () => savePromotion()));
    $('promotionClearBtn')?.addEventListener('click', clearPromotionForm);
    $('promotionImageFile')?.addEventListener('change', previewPromotionImage);
    c.querySelectorAll('.promotion-edit-btn').forEach((button) => button.addEventListener('click', () => fillPromotionForm(button.dataset.promotionId || '')));
    c.querySelectorAll('.promotion-delete-btn').forEach((button) => button.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', () => deletePromotion(button.dataset.promotionId || ''))));
}

async function savePromotion() {
    const title = $('promotionTitle')?.value.trim() || '';
    if (!title) {
        showAlert('タイトルを入力してください', 'warning');
        return;
    }
    const id = $('promotionId')?.value || '';
    const current = appState.promotions.find((item) => String(item.id || '') === String(id));
    const imageFile = $('promotionImageFile')?.files?.[0];
    const imageUrl = imageFile ? await fileToDataUrl(imageFile) : (current?.image_url || '');
    const payload = {
        title,
        summary: $('promotionSummary')?.value.trim() || '',
        image_url: imageUrl,
        member_id: current?.member_id || appState.currentUserMemberId || '',
        registered_by: current?.registered_by || currentUserMemberName()
    };
    if (id) await request(`/api/extra/promotions/${encodeURIComponent(id)}`, jsonOptions('PUT', payload));
    else await saveExtra('promotions', payload);
    clearPromotionForm();
    await loadExtraData();
    showAlert('宣伝を保存しました', 'success');
}

async function deletePromotion(id) {
    if (!id || !confirmDelete()) return;
    await request(`/api/extra/promotions/${encodeURIComponent(id)}`, { method: 'DELETE' });
    clearPromotionForm();
    await loadExtraData();
    showAlert('宣伝を削除しました', 'success');
}

function renderAlbumView() {
    const c = $('memberAlbumInfo');
    if (!c) return;

    // アルバム一覧を作成日の新しい順にソート
    const albums = [...(appState.albums || [])].sort((a, b) =>
        String(b.created_at || '').localeCompare(String(a.created_at || ''))
    );

    const isAdmin = isAdmin_Portal();
    const currentUserId = appState.currentUserMemberId;
    const currentUserName = currentUserMemberName();

    // アルバムイベント一覧HTML を構築
    let albumsHTML = '';
    if (albums.length) {
        albumsHTML = albums.map((album) => {
            const photos = album.photos || [];
            const canDeleteEvent = isAdmin || String(album.created_by_member_id || '') === String(currentUserId);
            
            // 写真ギャラリーHTML を構築
            let photosHTML = '';
            if (photos.length) {
                photosHTML = `<div class="row g-3">${photos.map((photo) => {
                    const photoUrl = (photo.id && album.id)
                        ? `/api/albums/${encodeURIComponent(String(album.id || ''))}/photos/${encodeURIComponent(String(photo.id || ''))}`
                        : String(photo.url || '#');
                    const deleteBtn = isAdmin ? `<button class="btn btn-sm btn-outline-danger album-delete-photo-btn mt-1" type="button" data-album-id="${escapeHtml(String(album.id || ''))}" data-photo-id="${escapeHtml(String(photo.id || ''))}">削除</button>` : '';
                    return `<div class="col-6 col-md-4 col-lg-3 position-relative">
                        <a href="${escapeHtml(photoUrl)}" target="_blank">
                            <img src="${escapeHtml(photoUrl)}" class="album-photo" alt="${escapeHtml(photo.filename || '写真')}" loading="lazy">
                        </a>
                        <div class="small mt-1 text-muted">${escapeHtml(photo.filename || '写真')}</div>
                        <div class="small text-muted">
                            <div>${escapeHtml(photo.uploaded_by_member_name || '不明')}</div>
                            <div>${escapeHtml(formatDateTimeLabel(photo.uploaded_at || ''))}</div>
                        </div>
                        ${deleteBtn}
                    </div>`;
                }).join('')}</div>`;
            } else {
                photosHTML = '<p class="text-muted">写真はまだアップロードされていません</p>';
            }

            const deleteEventBtn = canDeleteEvent ? `<button class="btn btn-sm btn-outline-danger album-delete-event-btn" type="button" data-album-id="${escapeHtml(String(album.id || ''))}">イベント削除</button>` : '';
            
            return `<section class="mb-4">
                <div class="d-flex justify-content-between align-items-center mb-3">
                    <h6 class="mb-0">${escapeHtml(album.event_name || 'イベント')}</h6>
                    ${deleteEventBtn}
                </div>
                <div class="small text-muted mb-3">
                    <div>作成者: ${escapeHtml(album.created_by_member_name || '不明')}</div>
                    <div>作成日: ${escapeHtml(formatDateTimeLabel(album.created_at || ''))}</div>
                </div>

                <!-- 写真アップロード -->
                <div class="mb-3 p-2 border rounded bg-light">
                    <label class="form-label small mb-2">写真をアップロード</label>
                    <div class="d-flex gap-2">
                        <input type="file" class="form-control album-photo-file" data-album-id="${escapeHtml(String(album.id || ''))}" accept="image/*" multiple>
                        <button class="btn btn-outline-primary album-upload-photo-btn" type="button" data-album-id="${escapeHtml(String(album.id || ''))}">アップロード</button>
                    </div>
                </div>

                <!-- 写真ギャラリー -->
                <div class="mb-3">
                    ${photosHTML}
                </div>
            </section>`;
        }).join('');
    } else {
        albumsHTML = '<p class="text-muted">アルバムイベントが登録されていません</p>';
    }

    c.innerHTML = `
        <!-- アルバムイベント作成フォーム -->
        <div class="info-block mb-4">
            <h6>アルバムイベントを作成</h6>
            <div class="row g-2 align-items-end">
                <div class="col-md-8">
                    <label class="form-label" for="albumEventName">イベント名</label>
                    <input type="text" id="albumEventName" class="form-control" placeholder="例: 2026年夏合宿">
                </div>
                <div class="col-md-4">
                    <button class="btn btn-primary w-100" id="albumCreateEventBtn" type="button">イベントを作成</button>
                </div>
            </div>
        </div>

        <!-- アルバムイベント一覧 -->
        <div id="memberAlbumEventList">
            ${albumsHTML}
        </div>
    `;

    // イベント作成ボタン
    const createBtn = $('albumCreateEventBtn');
    if (createBtn) {
        createBtn.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '作成中...', () => createAlbumEvent()));
    }

    // イベント削除ボタン
    c.querySelectorAll('.album-delete-event-btn').forEach((button) => {
        button.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', () => deleteAlbumEvent(button.dataset.albumId || '')));
    });

    // 写真アップロードボタン
    c.querySelectorAll('.album-upload-photo-btn').forEach((button) => {
        button.addEventListener('click', (event) => withButtonStatus(event.currentTarget, 'アップロード中...', () => uploadAlbumPhotos(button.dataset.albumId || '')));
    });

    // 写真削除ボタン
    c.querySelectorAll('.album-delete-photo-btn').forEach((button) => {
        button.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', () => deleteAlbumPhoto(button.dataset.albumId || '', button.dataset.photoId || '')));
    });
}

async function createAlbumEvent() {
    const eventName = $('albumEventName')?.value.trim() || '';
    if (!eventName) {
        showAlert('イベント名を入力してください', 'warning');
        return;
    }

    const payload = {
        event_name: eventName,
        created_by_member_id: appState.currentUserMemberId || '',
        created_by_member_name: currentUserMemberName(),
        photos: []
    };

    await saveExtra('albums', payload);
    $('albumEventName').value = '';
    await loadExtraData();
    showAlert('アルバムイベントを作成しました', 'success');
}

async function deleteAlbumEvent(albumId) {
    if (!albumId) return;
    if (!confirmDelete()) return;

    await request(`/api/extra/albums/${encodeURIComponent(albumId)}`, { method: 'DELETE' });
    await loadExtraData();
    showAlert('アルバムイベントを削除しました', 'success');
}

async function uploadAlbumPhotos(albumId) {
    if (!albumId) return;

    const fileInput = document.querySelector(`.album-photo-file[data-album-id="${CSS.escape(albumId)}"]`);
    if (!fileInput || !fileInput.files.length) {
        showAlert('アップロードするファイルを選択してください', 'warning');
        return;
    }

    const files = Array.from(fileInput.files);
    const albumIdNum = Number(albumId) || 0;

    let uploadedCount = 0;
    for (const file of files) {
        try {
            const formData = new FormData();
            formData.append('file', file);

            await request(`/api/extra/albums/${encodeURIComponent(albumIdNum)}/photos`, {
                method: 'POST',
                body: formData
            });
            uploadedCount += 1;
        } catch (error) {
            console.error(`Upload failed for ${file.name}:`, error);
        }
    }

    fileInput.value = '';
    await loadExtraData();
    showAlert(`${uploadedCount}件の写真をアップロードしました`, 'success');
}

async function deleteAlbumPhoto(albumId, photoId) {
    if (!albumId || !photoId) return;
    if (!confirmDelete()) return;

    const albumIdNum = Number(albumId) || 0;
    const photoIdNum = Number(photoId) || 0;

    await request(`/api/extra/albums/${encodeURIComponent(albumIdNum)}/photos/${encodeURIComponent(photoIdNum)}`, {
        method: 'DELETE'
    });
    await loadExtraData();
    showAlert('写真を削除しました', 'success');
}

function isAdmin_Portal() {
    const permission = String(appState.currentUserPermission || '');
    return permission === '管理者' || permission === 'システム管理者';
}


// すべての API 通信の共通窓口。
// GET は ETag + IndexedDB キャッシュ + in-flight dedupe を使い、
// 更新系は成功後にキャッシュを破棄して次回取得時の不整合を防ぐ。
async function request(url, options = {}) {
    const method = options.method || 'GET';
    const cacheKey = url;
    const deviceId = localStorage.getItem(PORTAL_DEVICE_ID_KEY) || '';
    const baseHeaders = {
        ...(options.headers || {}),
        ...(deviceId ? { 'X-Device-Id': deviceId } : {})
    };
    
    // GETリクエストはキャッシュを確認
    if (method === 'GET') {
        if (inFlightGetRequests.has(cacheKey)) {
            return inFlightGetRequests.get(cacheKey);
        }

        const pending = (async () => {
            const cached = await dbCache.get(cacheKey);
            const etag = dbCache.getETag(cacheKey);

            const headers = { ...baseHeaders };
            if (etag) {
                headers['If-None-Match'] = etag;
            }

            const response = await fetch(url, { ...options, method, headers });

            // 304 Not Modifiedの場合はキャッシュを使用
            if (response.status === 304 && cached) {
                return cached;
            }

            if (!response.ok) {
                const contentType = response.headers.get('content-type') || '';
                const data = contentType.includes('application/json') ? await response.json() : await response.text();
                const message = typeof data === 'object' && data.detail ? data.detail : '通信に失敗しました';
                showAlert(message, 'danger');
                throw new Error(message);
            }

            const contentType = response.headers.get('content-type') || '';
            const data = contentType.includes('application/json') ? await response.json() : await response.text();
            const newETag = response.headers.get('ETag');
            if (newETag) {
                await dbCache.set(cacheKey, data, newETag);
            }
            return data;
        })();

        inFlightGetRequests.set(cacheKey, pending);
        try {
            return await pending;
        } finally {
            inFlightGetRequests.delete(cacheKey);
        }
    }
    
    // POSTやPUT、DELETEの場合は通常のリクエスト
    const response = await fetch(url, { ...options, headers: baseHeaders });
    const contentType = response.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await response.json() : await response.text();
    if (!response.ok) {
        const message = typeof data === 'object' && data.detail ? data.detail : '通信に失敗しました';
        showAlert(message, 'danger');
        throw new Error(message);
    }
    
    // 更新系のリクエスト後は関連キャッシュだけ無効化する。
    await invalidateCacheForMutation(url);
    return data;
}

function mutationRelatedCacheKeys(url) {
    const keys = new Set(['/api/bootstrap-lite', '/api/bootstrap-core', '/api/bootstrap']);
    if (url.startsWith('/api/extra/')) {
        keys.add(url.split('?')[0]);
        if (url.includes('/sheet_library') || url.includes('/date_adjust') || url.includes('/practice_instruction')) {
            keys.add('/api/sheets');
        }
        return [...keys];
    }
    if (url.startsWith('/api/sheets')) {
        keys.add('/api/sheets');
        keys.add('/api/extra/sheet_library');
        return [...keys];
    }
    if (url.startsWith('/api/recordings') || url.startsWith('/api/convert') || url.startsWith('/api/drive/')) {
        keys.add('/api/recordings');
        keys.add('/api/drive/files');
        return [...keys];
    }
    const firstPath = url.split('?')[0].replace(/\/[0-9]+$/, '');
    keys.add(firstPath);
    return [...keys];
}

async function invalidateCacheForMutation(url) {
    const keys = mutationRelatedCacheKeys(url);
    await Promise.all(keys.map((key) => dbCache.delete(key)));
}

function jsonOptions(method, payload) {
    return {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    };
}

function emptyText(items, message) {
    return items.length ? '' : `<li class="list-group-item text-muted">${message}</li>`;
}

// 一覧描画で多用する単純なグループ化ヘルパー。
function groupBy(items, key) {
    return items.reduce((groups, item) => {
        const value = item[key] || '未分類';
        groups[value] = groups[value] || [];
        groups[value].push(item);
        return groups;
    }, {});
}

function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / Math.pow(1024, index)).toFixed(index ? 1 : 0)} ${units[index]}`;
}

// API 由来の文字列をそのまま innerHTML に差し込む箇所が多いため、
// 画面生成前に必ずこの関数でエスケープする。
function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    }[char]));
}

// テキスト内のURLを検出してクリック可能なリンクに変換
function convertUrlsToLinks(text) {
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    return escapeHtml(text).replace(urlRegex, (url) => {
        try {
            new URL(url);
            return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="text-decoration-underline">${escapeHtml(url)}</a>`;
        } catch {
            return escapeHtml(url);
        }
    });
}

function showAlert(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `alert alert-${type} shadow-sm`;
    toast.textContent = message;
    $('toastArea').appendChild(toast);
    setTimeout(() => toast.remove(), 4200);
}

// ローディングバー表示・非表示
function setLoadingBar(label = '') {
    const bar = $('portalLoadingBar');
    const lbl = $('portalLoadingLabel');
    if (!bar) return;
    if (lbl) lbl.textContent = label;
    bar.hidden = false;
}
function clearLoadingBar() {
    const bar = $('portalLoadingBar');
    if (bar) bar.hidden = true;
}
