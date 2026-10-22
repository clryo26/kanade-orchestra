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
        _structuredResult: _omitStructured,
        _retryContext: _omitRetryContext,
        _requestOrigin: _omitRequestOrigin,
        _skipRetryWait: _omitSkipRetryWait,
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
    advancePortalAuthTransition();
    window.portalResponseEpoch = (window.portalResponseEpoch || 0) + 1;
    // Authentication ended: the tuner must not keep the microphone open.
    if (typeof window.portalTunerLeave === 'function') window.portalTunerLeave('auth-cleared');
    // The sheet library must not apply a response of the previous account.
    if (typeof window.resetSheetLibrarySync === 'function') window.resetSheetLibrarySync('auth-cleared');
    if (typeof window.closeSheetSave === 'function') window.closeSheetSave();
    localStorage.removeItem(window.portalRuntimeContext.PORTAL_AUTH_KEY);
    appState.portalAuthVerified = false;
    appState.lastPortalSessionVerifiedAt = 0;
    appState.lastEssentialDataLoadedAt = 0;
    appState.essentialDataLoaded = false;
    appState.dataLoaded = false;
    appState.currentUserMemberId = null;
    appState.portalAuthGeneration = '';
    appState.currentUserName = '';
    appState.currentUserPermission = '';
    appState.currentUserPart = '';
    appState.currentUserHiddenUser = false;
    appState.currentUserIsRecordingManager = false;
    appState.currentUserIsSheetManager = false;
    appState.memberDetailRecords = {};
    appState.memberDetailLoadStates = {};
    appState.memberDetailLoadPromises = {};
    if (typeof clearMemberIntroCache === 'function') clearMemberIntroCache();
}

function applyPortalAuthDevice(device) {
    if (!device || typeof device !== 'object') return;
    const previousIdentity = typeof portalCacheIdentity === 'function' ? portalCacheIdentity() : '';
    appState.portalAuthGeneration = device.authenticated_at || device.created_at || '';
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
    if (typeof window.resetPortalRequestWaits === 'function' && typeof portalCacheIdentity === 'function'
        && previousIdentity !== portalCacheIdentity()) window.resetPortalRequestWaits();
    if (typeof window.portalFileOperationsResume === 'function') void window.portalFileOperationsResume();
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

var portalAuthCheckInFlight = null;

// Authentication transitions are independent of response-cache invalidation:
// saving data must not invalidate a concurrent session confirmation.
function advancePortalAuthTransition() {
    appState.portalAuthTransition = (appState.portalAuthTransition || 0) + 1;
    portalAuthCheckInFlight = null;
    if (typeof window.resetPortalRequestWaits === 'function') window.resetPortalRequestWaits();
}

if (typeof window.addEventListener === 'function') {
    window.addEventListener('storage', (event) => {
        if (event.key === null || event.key === window.portalRuntimeContext.PORTAL_DEVICE_ID_KEY
            || event.key === window.portalRuntimeContext.PORTAL_AUTH_KEY) advancePortalAuthTransition();
    });
}

function portalAuthCheckIsCurrent(check) {
    return check.context.deviceId === localStorage.getItem(window.portalRuntimeContext.PORTAL_DEVICE_ID_KEY)
        && check.context.transition === (appState.portalAuthTransition || 0)
        && check.context.generation === (appState.portalAuthGeneration || '');
}

function notePortalAuthCheckApplied(check) {
    // A second caller sharing this response may apply the same valid generation.
    // Side effects remain with each caller, rather than moving into this helper.
    check.context.generation = appState.portalAuthGeneration || '';
}

function notePortalAuthCheckCleared(check) {
    // A clear caused by this shared response is legitimate for its other
    // callers, just like an apply. External logout/login/storage transitions
    // still invalidate it. Keep each caller's existing clear side effects.
    check.context.transition = appState.portalAuthTransition || 0;
    check.context.generation = appState.portalAuthGeneration || '';
}

function fetchPortalSessionCheck(deviceId, options = {}) {
    const context = { deviceId, generation: appState.portalAuthGeneration || '', transition: appState.portalAuthTransition || 0 };
    const key = JSON.stringify(context);
    if (portalAuthCheckInFlight && portalAuthCheckInFlight.key === key) return portalAuthCheckInFlight.promise;
    const pending = { key, promise: null };
    pending.promise = (async () => {
        const response = await fetchWithTimeout(`/api/auth/devices/${encodeURIComponent(deviceId)}`,
            { method: 'GET', headers: { 'X-Device-Id': deviceId }, cache: 'no-store',
                _requestOrigin: options._requestOrigin,
                _retryContext: { transientRetries: 0, unknown503Retries: 0 } }, PORTAL_TIMEOUT_AUTH);
        const payload = response.ok ? await response.json().catch(() => ({})) : null;
        return { status: response.status, ok: response.ok, payload, context, portalRetryWait: response.portalRetryWait };
    })().finally(() => {
        if (portalAuthCheckInFlight === pending) portalAuthCheckInFlight = null;
    });
    portalAuthCheckInFlight = pending;
    return pending.promise;
}

async function tryRecoverPortalSession(deviceId, options = {}) {
    if (!deviceId) {
        clearPortalAuthState();
        return false;
    }
    try {
        const response = await fetchPortalSessionCheck(deviceId, options);
        if (!portalAuthCheckIsCurrent(response)) return false;
        if (!response.ok) {
            // 明確な未認証(401/403/404)のみ認証状態をクリア
            if (response.status === 401 || response.status === 403 || response.status === 404) {
                clearPortalAuthState();
                notePortalAuthCheckCleared(response);
            }
            return false;
        }
        const payload = response.payload;
        if (!payload || !payload.authenticated || !payload.device) {
            clearPortalAuthState();
            notePortalAuthCheckCleared(response);
            return false;
        }
        applyPortalAuthDevice(payload.device);
        notePortalAuthCheckApplied(response);
        return true;
    } catch {
        // タイムアウトやネットワークエラー: 認証状態を保持して失敗扱い
        return false;
    }
}

function mutationRelatedCacheKeys(url) {
    const keys = new Set(['/api/bootstrap-lite', '/api/bootstrap-core', '/api/bootstrap']);
    if (url === '/api/members' || url.startsWith('/api/members/')) {
        keys.add('/api/member-introductions');
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
        const collection = url.split('?')[0].match(/^\/api\/extra\/[^/]+/);
        if (collection) keys.add(collection[0]);
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
    // An older GET must not repopulate the cache after a successful mutation.
    window.portalResponseEpoch = (window.portalResponseEpoch || 0) + 1;
    const keys = mutationRelatedCacheKeys(url);
    if (typeof window.clearPortalRequestWaitsForKeys === 'function') window.clearPortalRequestWaitsForKeys(keys);
    // Disk cache cleanup is auxiliary to an already confirmed business write.
    // delete() blocks reuse in memory before IO, even if the transaction fails.
    // Attempt every target; cache errors must not replace the HTTP save result.
    await Promise.allSettled(keys.map(async (key) => window.portalRuntimeContext.dbCache.delete(key)));
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
    const timestamp = Number(cacheEntry?.validatedAt ?? cacheEntry?.timestamp);
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

function isLivePromotionRequest(url) {
    const path = String(url || '').split('?')[0];
    return path === '/api/bootstrap' || path === '/api/extra/promotions'
        || path.startsWith('/api/extra/promotions/') || path.startsWith('/api/promotions/operations/');
}

function portalRequestHeaderEntries(headers) {
    if (headers && typeof headers.entries === 'function' && !Array.isArray(headers)) return Array.from(headers.entries());
    return Array.isArray(headers) ? headers : Object.entries(headers || {});
}

function portalNoStoreRequest(url) {
    const path = String(url || '').split('?')[0];
    return isLivePromotionRequest(url) || path.startsWith('/api/auth/')
        || path === '/api/portal-file-actor' || path.startsWith('/api/portal-file-operations/');
}

function portalRetryWaitError(response) {
    const error = new Error(response.portalRetryWait.message);
    error.status = 503;
    error.portalRetryWait = response.portalRetryWait;
    return error;
}

async function purgePromotionCache() {
    const cache = window.portalRuntimeContext.dbCache;
    if (!cache?.db || cache.promotionPurge) return cache?.promotionPurge;
    cache.promotionPurge = new Promise((resolve, reject) => {
        const transaction = cache.db.transaction(['bootstrap_cache'], 'readwrite');
        const cursor = transaction.objectStore('bootstrap_cache').openCursor();
        cursor.onsuccess = () => {
            const entry = cursor.result;
            if (!entry) return;
            if (isLivePromotionRequest(entry.key)) {
                entry.delete();
                cache.etags?.delete(entry.key);
            }
            entry.continue();
        };
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
    }).catch(() => { /* Excluded requests never read these entries, even if deletion fails. */ });
    return cache.promotionPurge;
}

async function request(url, options = {}) {
    if (options._portalFileOperation) {
        const { _portalFileOperation, ...fileOptions } = options;
        return window.portalFileRequest(url, fileOptions);
    }
    const method = String(options.method || 'GET').toUpperCase();
    // This object survives the separate 401 resend; authentication has its own budget.
    // A caller continuing the same logical load (the extra loader's one retry
    // after a save) passes its used budget; it must not be reset here.
    options = { ...options, _retryContext: options._retryContext || { transientRetries: 0, unknown503Retries: 0 } };
    const cacheKey = url;
    const contextKey = () => `${typeof portalCacheIdentity === 'function' ? portalCacheIdentity() : ''}:${window.portalResponseEpoch || 0}`;
    const startedContext = contextKey();
    const flightKey = `${startedContext}:${cacheKey}:${Boolean(options._forceRevalidate)}`;
    const requireCurrentContext = () => {
        // Marked so callers can tell a save/auth context change from a real failure.
        if (startedContext !== contextKey()) throw Object.assign(new Error('表示情報が更新されました。もう一度読み込んでください'), { portalContextChanged: true });
    };
    const deviceId = localStorage.getItem(window.portalRuntimeContext.PORTAL_DEVICE_ID_KEY) || '';
    const headerEntries = portalRequestHeaderEntries(options.headers);
    const explicitTenant = headerEntries.some(([key]) => ['x-organization-id', 'x-tenant-id'].includes(String(key).toLowerCase()));
    const useResponseCache = !explicitTenant && !portalNoStoreRequest(url);
    const baseHeaders = Object.fromEntries(headerEntries.filter(([key]) => !deviceId || String(key).toLowerCase() !== 'x-device-id'));
    if (deviceId) baseHeaders['X-Device-Id'] = deviceId;
    if (!useResponseCache) options = { ...options, cache: 'no-store' };
    const skipAuthRecovery = Boolean(options._skipAuthRecovery);
    const allowCacheFallback = options._allowCacheFallback !== false;
    const forceRevalidate = Boolean(options._forceRevalidate);
    const timeoutMs = _resolveTimeoutMs(url, method);
    if (isLivePromotionRequest(url)) {
        await purgePromotionCache();
        // IndexedDB fallback would hide failed refreshes and stale operation results.
        const identity = `${deviceId}:${appState.currentUserMemberId}:${appState.currentUserPermission}`;
        let response = await fetchWithTimeout(url, { ...options, headers: baseHeaders, cache: 'no-store' }, timeoutMs);
        if (response.status === 401 && !skipAuthRecovery && await tryRecoverPortalSession(deviceId, options)) {
            response = await fetchWithTimeout(url, { ...options, headers: baseHeaders, cache: 'no-store' }, timeoutMs);
        }
        const currentDevice = localStorage.getItem(window.portalRuntimeContext.PORTAL_DEVICE_ID_KEY) || '';
        if (identity !== `${currentDevice}:${appState.currentUserMemberId}:${appState.currentUserPermission}`) {
            throw new Error('認証情報が変わりました。再読み込みしてください');
        }
        if (response.portalRetryWait?.suppressed && !options._structuredResult) throw portalRetryWaitError(response);
        const data = await response.json().catch((error) => { if (response.status < 500) throw error; return null; });
        // Promotion writes return through this dedicated path, before the
        // generic mutation handler. Only a confirmed save releases list waits;
        // 202/5xx must remain result-unknown with their operation key intact.
        if (method !== 'GET' && response.status === 200) await invalidateCacheForMutation(url);
        if (options._structuredResult) return { status: response.status, data, retryAfter: response.headers.get('Retry-After') };
        if (!response.ok) {
            throw new Error(data?.detail?.message || data?.detail || '宣伝の読み込みに失敗しました');
        }
        return data;
    }
    if (method === 'GET') {
        if (!explicitTenant && window.portalRuntimeContext.inFlightGetRequests.has(flightKey)) {
            const shared = window.portalRuntimeContext.inFlightGetRequests.get(flightKey);
            // The joined GET spends the first caller's budget. Link it so a caller
            // continuing this logical load (the loader's retry after a save)
            // inherits what was really used, not its own untouched budget.
            if (shared.portalRetryContext && shared.portalRetryContext !== options._retryContext) {
                options._retryContext.sharedBudget = shared.portalRetryContext;
            }
            return shared;
        }
        const pending = (async () => {
            const cacheEntry = useResponseCache ? await window.portalRuntimeContext.dbCache.getEntry(cacheKey) : null;
            requireCurrentContext();
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
                requireCurrentContext();
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
            let recoveredOnce = false;
            if (response.status === 401 && !skipAuthRecovery) {
                recoveredOnce = true;
                const recovered = await tryRecoverPortalSession(deviceId, options);
                if (recovered) {
                    response = await fetchWithTimeout(url, { ...options, method, headers }, timeoutMs);
                }
            }
            requireCurrentContext();
            if (response.portalRetryWait?.suppressed) throw portalRetryWaitError(response);
            if (response.status === 304 && cached != null) {
                // Validation success advances freshness, independently of cache reads.
                if (useResponseCache && freshCacheTtlMs(url) > 0
                    && !/\bno-store\b/i.test(response.headers.get('Cache-Control') || '')) {
                    await window.portalRuntimeContext.dbCache.set(cacheKey, cached, response.headers.get('ETag') || etag);
                }
                requireCurrentContext();
                return cached;
            }
            if (response.status === 304 && cached == null && options._retryContext.transientRetries < 2) {
                // A validator without a body is unusable: one unconditional send,
                // within this request's existing budget, never an infinite 304 loop.
                options._retryContext.transientRetries += 1;
                const unconditional = Object.fromEntries(Object.entries(headers).filter(([key]) => key.toLowerCase() !== 'if-none-match'));
                response = await fetchWithTimeout(url, { ...options, method, headers: unconditional }, timeoutMs);
                if (response.status === 401 && !skipAuthRecovery && !recoveredOnce && await tryRecoverPortalSession(deviceId, options)) {
                    response = await fetchWithTimeout(url, { ...options, method, headers: unconditional }, timeoutMs);
                }
                requireCurrentContext();
            }
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
            requireCurrentContext();
            if (newETag && useResponseCache && !/\bno-store\b/i.test(response.headers.get('Cache-Control') || '')) {
                await window.portalRuntimeContext.dbCache.set(cacheKey, data, newETag);
            }
            requireCurrentContext(); // A mutation may finish while the cache transaction commits.
            return data;
        })();
        pending.portalRetryContext = options._retryContext;
        if (!explicitTenant) window.portalRuntimeContext.inFlightGetRequests.set(flightKey, pending);
        try { return await pending; } finally { if (!explicitTenant) window.portalRuntimeContext.inFlightGetRequests.delete(flightKey); }
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
        const recovered = await tryRecoverPortalSession(deviceId, options);
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
