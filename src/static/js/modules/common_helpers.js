// Frontend split: extracted from main.js.
// Loaded after main.js; functions intentionally remain global for legacy handlers.

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

// 団員表示名を統一形式（姓 + 旧姓 + 名）で作る。
// memberDisplayName moved to feature module.

function canAccessAdmin() {
    return ['管理者', 'システム管理者'].includes(appState.currentUserPermission);
}

// システム管理メニューへ入れるか判定する。

function canAccessSystemAdmin() {
    return appState.currentUserPermission === 'システム管理者';
}

// 録音管理権限の判定（管理者または録音担当）。
// canManageRecordings moved to feature module.

function formatClockTime(value) {
    const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?/);
    return match ? `${match[1].padStart(2, '0')}:${match[2]}` : String(value || '').trim();
}

function formatTimeRange(start, end) {
    const formattedStart = formatClockTime(start);
    const formattedEnd = formatClockTime(end);
    return formattedStart && formattedEnd ? `${formattedStart} - ${formattedEnd}` : formattedStart || formattedEnd || '';
}

function splitTimeRange(value) {
    const match = String(value || '').match(/(\d{1,2}:\d{2}(?::\d{2})?)\s*(?:-|〜|~|～)\s*(\d{1,2}:\d{2}(?::\d{2})?)/);
    return match ? { start: formatClockTime(match[1]), end: formatClockTime(match[2]) } : { start: '', end: '' };
}

// scheduleTimeLabel moved to feature module.

// scheduleAvailableLabel moved to feature module.

// scheduleCalendarTitle moved to feature module.

// scheduleCalendarDetails moved to feature module.

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

// googleCalendarUrlForSchedule moved to feature module.

// openGoogleCalendarForSchedule moved to feature module.

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

// scheduleToIcsEvent moved to feature module.

// saveMember moved to feature module.

// selectMember moved to feature module.

// deleteMember moved to feature module.

// clearMemberForm moved to feature module.

// syncMemberPermissionFields moved to feature module.

function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.addEventListener('load', () => resolve(String(reader.result || '')));
        reader.addEventListener('error', () => reject(reader.error || new Error('画像を読み込めませんでした')));
        reader.readAsDataURL(file);
    });
}

// memberKanaName moved to feature module.

// sortedMembersByPartAndKana moved to feature module.

function partSortIndex(partName) {
    const index = currentPartNames().indexOf(String(partName || ''));
    return index === -1 ? 9999 : index;
}

// renderMembers moved to feature module.

function cssSafeId(value) {
    return encodeURIComponent(String(value || 'none')).replace(/%/g, '');
}

function paymentPaymentRangeLabel(payment) {
    const until = payment.paid_until_month || payment.membership_fee || payment.dues || '';
    return until ? `${until}まで支払い済み` : '未登録';
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

// schedulePerformanceLabel moved to feature module.

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
// renderMemberExtraViews moved to feature module.

function normalizeClockText(value) {
    const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return '';
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (Number.isNaN(hour) || Number.isNaN(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return '';
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function addMinutesToClockText(start, minutes) {
    const normalizedStart = normalizeClockText(start);
    const add = Number(minutes);
    if (!normalizedStart || Number.isNaN(add)) return '';
    const [h, m] = normalizedStart.split(':').map((part) => Number(part));
    const total = h * 60 + m + add;
    if (total < 0) return '';
    const normalized = ((total % (24 * 60)) + (24 * 60)) % (24 * 60);
    const endH = Math.floor(normalized / 60);
    const endM = normalized % 60;
    return `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`;
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
