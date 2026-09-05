// Request/cache helpers split from common_helpers.js.
// Keep global names for compatibility with legacy non-module loading.

var appState = window.portalRuntimeContext.appState;

// 通信タイムアウト定数（ミリ秒）
var PORTAL_TIMEOUT_AUTH = 10000;
var PORTAL_TIMEOUT_BOOTSTRAP_LITE = 12000;
var PORTAL_TIMEOUT_BOOTSTRAP_CORE = 20000;
var PORTAL_TIMEOUT_GET = 15000;
var PORTAL_TIMEOUT_MUTATION = 20000;
var FRESH_CACHE_TTL_MS = 10000;
var PORTAL_TRANSIENT_NETWORK_NOTICE_COOLDOWN_MS = 30000;
var portalLastTransientNetworkNoticeAt = 0;

// タイムアウトエラーを他のネットワークエラーと区別するクラス
class PortalTimeoutError extends Error {
    constructor(message, timeoutMs) {
        super(message);
        this.name = 'PortalTimeoutError';
        this.timeoutMs = timeoutMs;
    }
}

// URLとメソッドからタイムアウト値を決定する
function _resolveTimeoutMs(url, method) {
    if (method !== 'GET') return PORTAL_TIMEOUT_MUTATION;
    const path = String(url || '').split('?')[0];
    if (path.startsWith('/api/auth/devices/')) return PORTAL_TIMEOUT_AUTH;
    if (path === '/api/bootstrap-lite') return PORTAL_TIMEOUT_BOOTSTRAP_LITE;
    if (path === '/api/bootstrap-core') return PORTAL_TIMEOUT_BOOTSTRAP_CORE;
    return PORTAL_TIMEOUT_GET;
}

// AbortControllerで外部signalとタイムアウトを統合したfetch
// _skipAuthRecovery等の内部専用プロパティはfetch()へ渡さない
async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const externalSignal = options && options.signal;

    // 外部signalが既にabort済みの場合は即時停止
    if (externalSignal && externalSignal.aborted) {
        controller.abort(externalSignal.reason);
    }

    // 外部signalのabortを内部controllerへ伝播
    let externalAbortHandler = null;
    if (externalSignal && !externalSignal.aborted) {
        externalAbortHandler = function () {
            controller.abort(externalSignal.reason);
        };
        externalSignal.addEventListener('abort', externalAbortHandler, { once: true });
    }

    // タイムアウト後にPortalTimeoutErrorでabortする
    const timer = setTimeout(function () {
        controller.abort(new PortalTimeoutError('Request timed out after ' + timeoutMs + 'ms', timeoutMs));
    }, timeoutMs);

    // 内部専用プロパティを除外してfetchOptionsを構築
    const {
        _skipAuthRecovery: _omit1,
        _allowCacheFallback: _omit2,
        _forceRevalidate: _omit3,
        signal: _omit4,
        ...fetchOptions
    } = Object(options || {});
    fetchOptions.signal = controller.signal;

    try {
        return await fetch(url, fetchOptions);
    } catch (e) {
        if (controller.signal.aborted) {
            const reason = controller.signal.reason;
            if (reason instanceof PortalTimeoutError) throw reason;
        }
        throw e;
    } finally {
        clearTimeout(timer);
        if (externalSignal && externalAbortHandler) {
            externalSignal.removeEventListener('abort', externalAbortHandler);
        }
    }
}

function apiActionLabel(method) {
    const upper = String(method || 'GET').toUpperCase();
    if (upper === 'POST') return '登録';
    if (upper === 'PUT' || upper === 'PATCH') return '更新';
    if (upper === 'DELETE') return '削除';
    return '取得';
}

function apiTargetLabel(url) {
    const path = String(url || '').split('?')[0];
    const extra = path.match(/^\/api\/extra\/([^\/]+)/);
    if (extra) {
        const labels = {
            performance_day_infos: '本番情報',
            piece_infos: '曲別情報',
            practice_instructions: '練習指示',
            part_settings: 'パート設定',
            venue_settings: '会場設定',
            flyer_distributions: 'チラシ配布管理',
            flyer_distribution_assignments: 'チラシ配布情報',
            org_settings: '団体設定',
            sns_settings: 'SNS設定',
            connection_settings: '接続設定',
            desired_pieces: '希望曲',
            promotions: '宣伝情報',
            albums: 'アルバム',
            concert_record_videos: '記録動画',
        };
        return labels[extra[1]] || extra[1];
    }
    if (path.startsWith('/api/auth/')) return '認証情報';
    if (path.startsWith('/api/bootstrap')) return '初期データ';
    if (path.startsWith('/api/performances')) return '本番一覧';
    if (path.startsWith('/api/schedules')) return '練習予定';
    return 'データ';
}

function clearPortalAuthState() {
    localStorage.removeItem(window.portalRuntimeContext.PORTAL_AUTH_KEY);
    appState.portalAuthVerified = false;
    appState.lastPortalSessionVerifiedAt = 0;
    appState.lastEssentialDataLoadedAt = 0;
    appState.essentialDataLoaded = false;
    appState.dataLoaded = false;
    appState.currentUserMemberId = null;
    appState.currentUserName = '';
    appState.currentUserPermission = '';
    appState.currentUserPart = '';
    appState.currentUserHiddenUser = false;
    appState.currentUserIsRecordingManager = false;
    appState.currentUserIsSheetManager = false;
    appState.memberDetailRecords = {};
    appState.memberDetailLoadStates = {};
    appState.memberDetailLoadPromises = {};
}

function applyPortalAuthDevice(device) {
    if (!device || typeof device !== 'object') return;
    appState.portalAuthVerified = true;
    appState.lastPortalSessionVerifiedAt = Date.now();
    appState.currentUserMemberId = device.member_id ?? null;
    appState.currentUserName = device.member_name || '';
    appState.currentUserPermission = device.permission || '';
    appState.currentUserPart = device.member_part || '';
    appState.currentUserHiddenUser = Boolean(device.hidden_user);
    appState.currentUserIsRecordingManager = Boolean(device.is_recording_manager);
    appState.currentUserIsSheetManager = Boolean(device.is_sheet_manager);
    localStorage.setItem(window.portalRuntimeContext.PORTAL_AUTH_KEY, 'true');
}

function buildApiFailureMessage(url, method, status, detail) {
    if (status === 401) {
        return 'ログイン期限が切れました。再ログインしてください。';
    }
    if (status === 0) {
        return '通信が切断されました。再接続しています... [再試行]';
    }
    const action = apiActionLabel(method);
    const target = apiTargetLabel(url);
    const reason = String(detail || '').trim();
    if (reason) {
        return `${target}の${action}に失敗しました。原因: ${reason}`;
    }
    return `${target}の${action}に失敗しました。時間をおいて再試行してください。`;
}

function showTransientNetworkNotice() {
    const now = Date.now();
    if (now - portalLastTransientNetworkNoticeAt < PORTAL_TRANSIENT_NETWORK_NOTICE_COOLDOWN_MS) return;
    portalLastTransientNetworkNoticeAt = now;
    showAlert('通信が一時的に不安定なため、保存済みデータを表示しています。', 'warning');
}

async function tryRecoverPortalSession(deviceId) {
    if (!deviceId) {
        clearPortalAuthState();
        return false;
    }
    try {
        const response = await fetchWithTimeout(
            `/api/auth/devices/${encodeURIComponent(deviceId)}`,
            { method: 'GET', headers: { 'X-Device-Id': deviceId } },
            PORTAL_TIMEOUT_AUTH
        );
        if (!response.ok) {
            // 明確な未認証(401/403/404)のみ認証状態をクリア
            if (response.status === 401 || response.status === 403 || response.status === 404) {
                clearPortalAuthState();
            }
            return false;
        }
        const payload = await response.json().catch(() => ({}));
        if (!payload || !payload.authenticated || !payload.device) {
            clearPortalAuthState();
            return false;
        }
        applyPortalAuthDevice(payload.device);
        return true;
    } catch {
        // タイムアウトやネットワークエラー: 認証状態を保持して失敗扱い
        return false;
    }
}

function mutationRelatedCacheKeys(url) {
    const keys = new Set(['/api/bootstrap-lite', '/api/bootstrap-core', '/api/bootstrap']);
    if (url.startsWith('/api/members/')) {
        const path = url.split('?')[0];
        keys.add('/api/members');
        keys.add(path);
        const memberMatch = path.match(/^\/api\/members\/(\d+)(?:\/.*)?$/);
        if (memberMatch) {
            keys.add(`/api/members/${memberMatch[1]}`);
        }
        return [...keys];
    }
    if (url.startsWith('/api/extra/')) {
        keys.add(url.split('?')[0]);
        if (url.includes('/sheet_library') || url.includes('/date_adjust') || url.includes('/practice_instruction')) keys.add('/api/sheets');
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
    await Promise.all(keys.map((key) => window.portalRuntimeContext.dbCache.delete(key)));
}

// Only stable member-facing list endpoints can briefly use cache-first.
// Authentication, management, bootstrap, revision, and file endpoints always revalidate.
function freshCacheTtlMs(url) {
    const path = String(url || '').split('?')[0];
    if ([
        '/api/performances',
        '/api/schedules',
        '/api/announcements',
        '/api/events',
    ].includes(path)) {
        return FRESH_CACHE_TTL_MS;
    }
    return 0;
}

function hasFreshCacheEntry(cacheEntry, url, forceRevalidate) {
    const ttlMs = freshCacheTtlMs(url);
    const timestamp = Number(cacheEntry?.timestamp);
    if (
        forceRevalidate ||
        !ttlMs ||
        cacheEntry?.data == null ||
        !Number.isFinite(timestamp) ||
        timestamp <= 0
    ) {
        return false;
    }
    const ageMs = Date.now() - timestamp;
    return ageMs >= 0 && ageMs < ttlMs;
}

async function request(url, options = {}) {
    const method = options.method || 'GET';
    const cacheKey = url;
    const deviceId = localStorage.getItem(window.portalRuntimeContext.PORTAL_DEVICE_ID_KEY) || '';
    const baseHeaders = { ...(options.headers || {}), ...(deviceId ? { 'X-Device-Id': deviceId } : {}) };
    const skipAuthRecovery = Boolean(options._skipAuthRecovery);
    const allowCacheFallback = options._allowCacheFallback !== false;
    const forceRevalidate = Boolean(options._forceRevalidate);
    const timeoutMs = _resolveTimeoutMs(url, method);
    if (method === 'GET') {
        if (window.portalRuntimeContext.inFlightGetRequests.has(cacheKey)) return window.portalRuntimeContext.inFlightGetRequests.get(cacheKey);
        const pending = (async () => {
            const cacheEntry = await window.portalRuntimeContext.dbCache.getEntry(cacheKey);
            const cached = cacheEntry?.data ?? null;
            const etag = cacheEntry?.etag ?? null;
            if (hasFreshCacheEntry(cacheEntry, url, forceRevalidate)) {
                return cached;
            }
            const headers = { ...baseHeaders };
            if (etag) headers['If-None-Match'] = etag;
            let response;
            try {
                response = await fetchWithTimeout(url, { ...options, method, headers }, timeoutMs);
            } catch (networkError) {
                if (networkError instanceof PortalTimeoutError) {
                    if (allowCacheFallback && cached) {
                        showTransientNetworkNotice();
                        return cached;
                    }
                    const message = `${apiTargetLabel(url)}の取得がタイムアウトしました。再試行してください。`;
                    showAlert(message, 'danger');
                    throw networkError;
                }
                if (allowCacheFallback && cached) {
                    showTransientNetworkNotice();
                    return cached;
                }
                const message = buildApiFailureMessage(url, method, 0, networkError instanceof Error ? networkError.message : 'network error');
                showAlert(message, 'danger');
                throw new Error(message);
            }
            if (response.status === 401 && !skipAuthRecovery) {
                const recovered = await tryRecoverPortalSession(deviceId);
                if (recovered) {
                    response = await fetchWithTimeout(url, { ...options, method, headers }, timeoutMs);
                }
            }
            if (response.status === 304 && cached) return cached;
            if (!response.ok) {
                const contentType = response.headers.get('content-type') || '';
                const data = contentType.includes('application/json') ? await response.json() : await response.text();
                const detail = typeof data === 'object' && data.detail ? data.detail : data;
                const message = buildApiFailureMessage(url, method, response.status, detail);
                if (response.status === 401 && typeof showPortalLogin === 'function') {
                    showPortalLogin();
                }
                showAlert(message, 'danger');
                throw new Error(message);
            }
            const contentType = response.headers.get('content-type') || '';
            const data = contentType.includes('application/json') ? await response.json() : await response.text();
            const newETag = response.headers.get('ETag');
            if (newETag) await window.portalRuntimeContext.dbCache.set(cacheKey, data, newETag);
            return data;
        })();
        window.portalRuntimeContext.inFlightGetRequests.set(cacheKey, pending);
        try { return await pending; } finally { window.portalRuntimeContext.inFlightGetRequests.delete(cacheKey); }
    }
    let response;
    try {
        response = await fetchWithTimeout(url, { ...options, headers: baseHeaders }, timeoutMs);
    } catch (networkError) {
        if (networkError instanceof PortalTimeoutError) {
            const message = `${apiTargetLabel(url)}の${apiActionLabel(method)}がタイムアウトしました。再試行してください。`;
            showAlert(message, 'danger');
            throw networkError;
        }
        const message = buildApiFailureMessage(url, method, 0, networkError instanceof Error ? networkError.message : 'network error');
        showAlert(message, 'danger');
        throw new Error(message);
    }
    if (response.status === 401 && !skipAuthRecovery) {
        const recovered = await tryRecoverPortalSession(deviceId);
        if (recovered) {
            response = await fetchWithTimeout(url, { ...options, headers: baseHeaders }, timeoutMs);
        }
    }
    const contentType = response.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await response.json() : await response.text();
    if (!response.ok) {
        const detail = typeof data === 'object' && data.detail ? data.detail : data;
        const message = buildApiFailureMessage(url, method, response.status, detail);
        if (response.status === 401 && typeof showPortalLogin === 'function') {
            showPortalLogin();
        }
        showAlert(message, 'danger');
        throw new Error(message);
    }
    await invalidateCacheForMutation(url);
    return data;
}
