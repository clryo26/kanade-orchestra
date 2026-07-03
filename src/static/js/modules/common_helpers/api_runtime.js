// Request/cache helpers split from common_helpers.js.
// Keep global names for compatibility with legacy non-module loading.

var appState = window.portalRuntimeContext.appState;

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
            org_settings: '団体設定',
            sns_settings: 'SNS設定',
            connection_settings: '接続設定',
            desired_pieces: '希望曲',
            promotions: '宣伝情報',
            albums: 'アルバム',
            flyer_places: 'チラシ配布管理',
            flyer_distributions: 'チラシ配布予定',
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
    appState.essentialDataLoaded = false;
    appState.dataLoaded = false;
    appState.currentUserMemberId = null;
    appState.currentUserName = '';
    appState.currentUserPermission = '';
    appState.currentUserPart = '';
    appState.currentUserIsRecordingManager = false;
    appState.currentUserIsSheetManager = false;
}

function applyPortalAuthDevice(device) {
    if (!device || typeof device !== 'object') return;
    appState.portalAuthVerified = true;
    appState.currentUserMemberId = device.member_id ?? null;
    appState.currentUserName = device.member_name || '';
    appState.currentUserPermission = device.permission || '';
    appState.currentUserPart = device.member_part || '';
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

async function tryRecoverPortalSession(deviceId) {
    if (!deviceId) {
        clearPortalAuthState();
        return false;
    }
    try {
        const response = await fetch(`/api/auth/devices/${encodeURIComponent(deviceId)}`, {
            method: 'GET',
            headers: { 'X-Device-Id': deviceId },
        });
        if (!response.ok) {
            clearPortalAuthState();
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
        return false;
    }
}

function mutationRelatedCacheKeys(url) {
    const keys = new Set(['/api/bootstrap-lite', '/api/bootstrap-core', '/api/bootstrap']);
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

async function request(url, options = {}) {
    const method = options.method || 'GET';
    const cacheKey = url;
    const deviceId = localStorage.getItem(window.portalRuntimeContext.PORTAL_DEVICE_ID_KEY) || '';
    const baseHeaders = { ...(options.headers || {}), ...(deviceId ? { 'X-Device-Id': deviceId } : {}) };
    if (method === 'GET') {
        if (window.portalRuntimeContext.inFlightGetRequests.has(cacheKey)) return window.portalRuntimeContext.inFlightGetRequests.get(cacheKey);
        const pending = (async () => {
            const cached = await window.portalRuntimeContext.dbCache.get(cacheKey);
            const etag = window.portalRuntimeContext.dbCache.getETag(cacheKey);
            const headers = { ...baseHeaders };
            if (etag) headers['If-None-Match'] = etag;
            let response;
            try {
                response = await fetch(url, { ...options, method, headers });
            } catch (networkError) {
                if (cached) {
                    showAlert('通信が不安定なため、保存済みデータを表示しています。', 'warning');
                    return cached;
                }
                const message = buildApiFailureMessage(url, method, 0, networkError instanceof Error ? networkError.message : 'network error');
                showAlert(message, 'danger');
                throw new Error(message);
            }
            if (response.status === 401 && !options._skipAuthRecovery) {
                const recovered = await tryRecoverPortalSession(deviceId);
                if (recovered) {
                    response = await fetch(url, { ...options, method, headers, _skipAuthRecovery: true });
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
        response = await fetch(url, { ...options, headers: baseHeaders });
    } catch (networkError) {
        const message = buildApiFailureMessage(url, method, 0, networkError instanceof Error ? networkError.message : 'network error');
        showAlert(message, 'danger');
        throw new Error(message);
    }
    if (response.status === 401 && !options._skipAuthRecovery) {
        const recovered = await tryRecoverPortalSession(deviceId);
        if (recovered) {
            response = await fetch(url, { ...options, headers: baseHeaders, _skipAuthRecovery: true });
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