// Pure/common helper functions split from common_helpers.js.
// Keep global names for compatibility with legacy non-module loading.

var appState = window.portalRuntimeContext.appState;
var $ = window.portalRuntimeContext.getById;

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

function displayNameWithoutExtension(name = '') { return String(name || '').replace(/\.[^.\\/]+$/, ''); }
function confirmDelete() { return confirm('本当に削除しますか？'); }
function portalDeviceId() {
    let deviceId = localStorage.getItem(window.portalRuntimeContext.PORTAL_DEVICE_ID_KEY);
    if (!deviceId) {
        deviceId = window.crypto?.randomUUID ? window.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        localStorage.setItem(window.portalRuntimeContext.PORTAL_DEVICE_ID_KEY, deviceId);
    }
    return deviceId;
}
function canAccessAdmin() { return ['管理者', 'システム管理者'].includes(appState.currentUserPermission); }
function canAccessSystemAdmin() { return appState.currentUserPermission === 'システム管理者'; }
function formatClockTime(value) { const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?/); return match ? `${match[1].padStart(2, '0')}:${match[2]}` : String(value || '').trim(); }
function formatTimeRange(start, end) { const formattedStart = formatClockTime(start); const formattedEnd = formatClockTime(end); return formattedStart && formattedEnd ? `${formattedStart} - ${formattedEnd}` : formattedStart || formattedEnd || ''; }
function splitTimeRange(value) { const match = String(value || '').match(/(\d{1,2}:\d{2}(?::\d{2})?)\s*(?:-|〜|~|～)\s*(\d{1,2}:\d{2}(?::\d{2})?)/); return match ? { start: formatClockTime(match[1]), end: formatClockTime(match[2]) } : { start: '', end: '' }; }
function addHoursToTime(time, hours) { const match = String(time || '').match(/^(\d{1,2}):(\d{2})$/); if (!match) return ''; const date = new Date(2000, 0, 1, Number(match[1]), Number(match[2])); date.setHours(date.getHours() + hours); return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`; }
function compactCalendarDate(date, time = '') { const ymd = String(date || '').replaceAll('-', ''); if (!ymd) return ''; const normalizedTime = formatClockTime(time); if (!normalizedTime) return ymd; return `${ymd}T${normalizedTime.replaceAll(':', '')}00`; }
function nextAllDayDate(date) { if (!date) return ''; const value = new Date(`${date}T00:00:00`); value.setDate(value.getDate() + 1); const y = value.getFullYear(); const m = String(value.getMonth() + 1).padStart(2, '0'); const d = String(value.getDate()).padStart(2, '0'); return `${y}-${m}-${d}`; }
function icsEscape(value) { return String(value || '').replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll(',', '\\,').replaceAll(';', '\\;'); }
function icsDateTime(date, time = '') { const compact = compactCalendarDate(date, time); return time ? compact : compact; }
function fileToDataUrl(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.addEventListener('load', () => resolve(String(reader.result || ''))); reader.addEventListener('error', () => reject(reader.error || new Error('画像を読み込めませんでした'))); reader.readAsDataURL(file); }); }
function partSortIndex(partName) { const index = currentPartNames().indexOf(String(partName || '')); return index === -1 ? 9999 : index; }
function cssSafeId(value) { return encodeURIComponent(String(value || 'none')).replace(/%/g, ''); }
function paymentPaymentRangeLabel(payment) { const until = payment.paid_until_month || payment.membership_fee || payment.dues || ''; return until ? `${until}まで支払い済み` : '未登録'; }
function integerAmountNumber(value) { const amount = Number(value || 0); return Number.isFinite(amount) && amount > 0 ? Math.round(amount) : 0; }
function integerAmountInputValue(value) { const amount = integerAmountNumber(value); return amount > 0 ? String(amount) : ''; }
function yenAmountLabel(value, fallback = '未設定') { const amount = integerAmountNumber(value); return amount > 0 ? `${amount.toLocaleString('ja-JP', { maximumFractionDigits: 0 })}円` : fallback; }
function formatDateWithWeekday(dateText, fallback = '未定') { if (!dateText) return fallback; const date = new Date(`${dateText}T00:00:00`); if (Number.isNaN(date.getTime())) return dateText; const weekdays = ['日', '月', '火', '水', '木', '金', '土']; const formattedDate = dateText.replace(/-/g, '/'); return `${formattedDate}（${weekdays[date.getDay()]}）`; }
function formatDateTimeLabel(value) { if (!value) return '未記録'; const date = new Date(value); if (Number.isNaN(date.getTime())) return value; const dateText = date.toISOString().slice(0, 10); const timeText = date.toTimeString().slice(0, 5); return `${formatDateWithWeekday(dateText)} ${timeText}`; }
function daysUntil(dateText) { const target = new Date(`${dateText}T00:00:00`); const base = new Date(`${window.portalRuntimeContext.today()}T00:00:00`); if (Number.isNaN(target.getTime())) return null; return Math.ceil((target - base) / 86400000); }
function formatDurationLabel(file) { if (file.duration) return file.duration; if (file.duration_seconds || file.duration_seconds === 0) { const total = Math.round(Number(file.duration_seconds)); const minutes = Math.floor(total / 60); const seconds = total % 60; return `${minutes}:${String(seconds).padStart(2, '0')}`; } return '長さ未取得'; }
function normalizeClockText(value) { const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/); if (!match) return ''; const hour = Number(match[1]); const minute = Number(match[2]); if (Number.isNaN(hour) || Number.isNaN(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return ''; return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`; }
function addMinutesToClockText(start, minutes) { const normalizedStart = normalizeClockText(start); const add = Number(minutes); if (!normalizedStart || Number.isNaN(add)) return ''; const [h, m] = normalizedStart.split(':').map((part) => Number(part)); const total = h * 60 + m + add; if (total < 0) return ''; const normalized = ((total % (24 * 60)) + (24 * 60)) % (24 * 60); const endH = Math.floor(normalized / 60); const endM = normalized % 60; return `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`; }
function normalizePerformancePieces(pieces) {
    return (pieces || []).map((piece) => {
        if (typeof piece === 'string') {
            return { composer: '', title: piece };
        }
        return {
            composer: piece.composer || '',
            title: piece.title || piece.name || '',
            alias: piece.alias || piece.short_name || '',
            duration: piece.duration || '',
            is_encore: Boolean(piece.is_encore || piece.encore)
        };
    }).filter((piece) => piece.title);
}
function performancePieceDurationText(piece) {
    const value = String(piece?.duration || '').trim();
    return value ? `演奏時間: ${value}分` : '';
}
function performancePieceLabel(piece) {
    if (typeof piece === 'string') return piece;
    const label = piece.alias || piece.short_name || (piece.composer ? `${piece.composer}: ${piece.title}` : piece.title);
    return (piece.is_encore || piece.encore) ? `(${label})` : label;
}
function performancePieceFormalLabel(piece) {
    if (typeof piece === 'string') return piece;
    const label = piece.composer ? `${piece.composer}: ${piece.title}` : piece.title;
    return (piece.is_encore || piece.encore) ? `(${label})` : label;
}
function performancePieceLookupLabels(piece) {
    if (typeof piece === 'string') return [piece].filter(Boolean);
    return [
        performancePieceLabel(piece),
        performancePieceFormalLabel(piece),
        piece.title,
        piece.alias,
        piece.short_name,
        piece.composer && piece.title ? `${piece.composer}: ${piece.title}` : ''
    ].map((value) => String(value || '').trim()).filter((value, index, array) => value && array.indexOf(value) === index);
}
function findPieceScopedItem(items, performanceId, piece) {
    const labels = performancePieceLookupLabels(piece);
    return (items || []).find((item) =>
        String(item.performance_id || '') === String(performanceId || '')
        && labels.includes(String(item.piece || item.title || '').trim())
    );
}
function pieceScopedRows(performances, scopedItems) {
    return (performances || []).map((perf) => {
        const normalizedPieces = normalizePerformancePieces(perf.pieces || []);
        const labels = new Set(normalizedPieces.flatMap(performancePieceLookupLabels));
        (scopedItems || []).forEach((item) => {
            if (String(item.performance_id || '') !== String(perf.id || '')) return;
            const itemPiece = String(item.piece || item.title || '').trim();
            if (!itemPiece || labels.has(itemPiece)) return;
            normalizedPieces.push({ composer: '', title: itemPiece, alias: '' });
            labels.add(itemPiece);
        });
        return {
            performanceId: String(perf.id || ''),
            title: String(perf.title || ''),
            date: String(perf.date || ''),
            pieces: normalizedPieces
        };
    });
}
function uploadPieceOptions(performance, wholePracticeLabel) {
    if (!performance) return [];

    const options = normalizePerformancePieces(performance.pieces || [])
        .map((piece) => ({
            value: performancePieceLabel(piece),
            label: performancePieceFormalLabel(piece)
        }))
        .filter((option) => option.value);

    options.push({
        value: wholePracticeLabel,
        label: wholePracticeLabel
    });

    const seen = new Set();
    return options.filter((option) => {
        if (seen.has(option.value)) return false;
        seen.add(option.value);
        return true;
    });
}
function isAdmin_Portal() { const permission = String(appState.currentUserPermission || ''); return permission === '管理者' || permission === 'システム管理者'; }
function jsonOptions(method, payload) { return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }; }
function emptyText(items, message) { return items.length ? '' : `<li class="list-group-item text-muted">${message}</li>`; }
function groupBy(items, key) { return items.reduce((groups, item) => { const value = item[key] || '未分類'; groups[value] = groups[value] || []; groups[value].push(item); return groups; }, {}); }
function formatBytes(bytes) { if (!bytes) return '0 B'; const units = ['B', 'KB', 'MB', 'GB']; const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1); return `${(bytes / Math.pow(1024, index)).toFixed(index ? 1 : 0)} ${units[index]}`; }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char])); }
function convertUrlsToLinks(text) {
    const source = String(text ?? '');
    const urlRegex = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/g;
    let cursor = 0;
    let html = '';
    source.replace(urlRegex, (url, offset) => {
        html += escapeHtml(source.slice(cursor, offset));
        const trailingMatch = url.match(/[.,;:!?。、，．）)\]}」』]+$/);
        const trailingText = trailingMatch ? trailingMatch[0] : '';
        const linkUrl = trailingText ? url.slice(0, -trailingText.length) : url;
        try {
            new URL(linkUrl);
            html += `<a href="${escapeHtml(linkUrl)}" target="_blank" rel="noopener noreferrer" class="text-decoration-underline">${escapeHtml(linkUrl)}</a>${escapeHtml(trailingText)}`;
        } catch {
            html += escapeHtml(url);
        }
        cursor = offset + url.length;
        return url;
    });
    html += escapeHtml(source.slice(cursor));
    return html;
}
