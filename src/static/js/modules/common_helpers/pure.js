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
// Clock arithmetic on minutes (wraps at 24h like before); no Date, so a DST
// change on the device can never shift the result.
function addHoursToTime(time, hours) { const match = String(time || '').match(/^(\d{1,2}):(\d{2})$/); if (!match) return ''; const total = Number(match[1]) * 60 + Number(match[2]) + Math.trunc(Number(hours) || 0) * 60; const wrapped = ((total % 1440) + 1440) % 1440; return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`; }
function compactCalendarDate(date, time = '') { const ymd = String(date || '').replaceAll('-', ''); if (!ymd) return ''; const normalizedTime = formatClockTime(time); if (!normalizedTime) return ymd; return `${ymd}T${normalizedTime.replaceAll(':', '')}00`; }
function nextAllDayDate(date) { if (!date) return ''; const days = portalCalendarDayNumber(date); if (days === null) return ''; return portalCalendarDateFromDayNumber(days + 1); }
function icsEscape(value) { return String(value || '').replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll(',', '\\,').replaceAll(';', '\\;'); }
function icsDateTime(date, time = '') { const compact = compactCalendarDate(date, time); return time ? compact : compact; }
function partSortIndex(partName) { const index = currentPartNames().indexOf(String(partName || '')); return index === -1 ? 9999 : index; }
function cssSafeId(value) { return encodeURIComponent(String(value || 'none')).replace(/%/g, ''); }
function paymentMonthValue(monthText) { if (!monthText || !/^\d{4}-\d{2}$/.test(String(monthText))) return null; const [year, month] = String(monthText).split('-').map(Number); return year * 12 + month; }
function paymentCurrentMonthValue() { return paymentMonthValue(window.portalRuntimeContext.today().slice(0, 7)); }
function paymentMonthLabel(monthText) {
    const match = String(monthText || '').trim().match(/^(\d{4})-(\d{2})$/);
    if (!match) return '';
    return `${match[1]}年${match[2]}月`;
}
function paymentRemainingMonthCount(payment) {
    const targetPayment = payment || null;
    const paidUntil = paymentMonthValue(targetPayment?.paid_until_month || targetPayment?.membership_fee || targetPayment?.dues || '');
    const current = paymentCurrentMonthValue();
    if (paidUntil === null || current === null) return null;
    return Math.max(0, current - paidUntil);
}
function paymentPaymentRangeLabel(payment) {
    const targetPayment = payment || null;
    const paidUntil = targetPayment?.paid_until_month || targetPayment?.membership_fee || targetPayment?.dues || '';
    if (!paidUntil) return '未登録';
    const paidUntilLabel = paymentMonthLabel(paidUntil);
    if (!paidUntilLabel) return '未登録';
    const remaining = paymentRemainingMonthCount(targetPayment);
    if (remaining === null || remaining <= 0) return `${paidUntilLabel}まで支払済み`;
    return `${paidUntilLabel}まで支払済み（${remaining}ヶ月分未納）`;
}
function integerAmountNumber(value) { const amount = Number(value || 0); return Number.isFinite(amount) && amount > 0 ? Math.round(amount) : 0; }
function integerAmountInputValue(value) { const amount = integerAmountNumber(value); return amount > 0 ? String(amount) : ''; }
function yenAmountLabel(value, fallback = '未設定') { const amount = integerAmountNumber(value); return amount > 0 ? `${amount.toLocaleString('ja-JP', { maximumFractionDigits: 0 })}円` : fallback; }
// ---- JST date/time contract (JST spec R03/R04) -----------------------------
// Calendar dates are pure calendar arithmetic (UTC day numbers, never the
// device timezone). Instants must carry an explicit offset; values without
// one are not guessed and display as 日時不明.
var PORTAL_WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
var PORTAL_INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|z|[+-]\d{2}:\d{2})$/;
function portalCalendarDayNumber(dateText) { const match = String(dateText || '').match(/^(\d{4})-(\d{2})-(\d{2})$/); if (!match) return null; const y = Number(match[1]); const m = Number(match[2]); const d = Number(match[3]); const ms = Date.UTC(y, m - 1, d); const check = new Date(ms); if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null; return Math.round(ms / 86400000); }
function portalCalendarDateFromDayNumber(days) { const value = new Date(days * 86400000); return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`; }
// Display only: milliseconds are enough to render; the original string stays
// the version token (never compare/identify with this number).
function parsePortalInstantMs(value) {
    const match = String(value ?? '').trim().match(PORTAL_INSTANT_RE);
    if (!match) return NaN;
    const [, y, mo, d, h, mi, sec = '0', fraction = '', offset] = match;
    const date = new Date(0);
    date.setUTCFullYear(Number(y), Number(mo) - 1, Number(d));
    date.setUTCHours(Number(h), Number(mi), Number(sec), Number(fraction.slice(0, 3).padEnd(3, '0')));
    if (Number(y) < 1 || date.getUTCFullYear() !== Number(y) || date.getUTCMonth() !== Number(mo) - 1
        || date.getUTCDate() !== Number(d) || Number(h) > 23 || Number(mi) > 59 || Number(sec) > 59) return NaN;
    if (offset === 'Z' || offset === 'z') return date.getTime();
    const hours = Number(offset.slice(1, 3)); const minutes = Number(offset.slice(4, 6));
    if (hours > 23 || minutes > 59) return NaN;
    return date.getTime() - (offset[0] === '-' ? -1 : 1) * (hours * 60 + minutes) * 60000;
}
// Fixed +09:00 (same rule as runtime_context.jst and the backend).
function portalJstParts(ms) { const shifted = new Date(Number(ms) + 9 * 3600000); return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate(), hour: shifted.getUTCHours(), minute: shifted.getUTCMinutes(), second: shifted.getUTCSeconds(), weekday: shifted.getUTCDay() }; }
function formatPortalJstTime(value, withSeconds = false) { const ms = typeof value === 'number' ? value : parsePortalInstantMs(value); if (!Number.isFinite(ms)) return ''; const p = portalJstParts(ms); const hm = `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`; return withSeconds ? `${hm}:${String(p.second).padStart(2, '0')}` : hm; }
function formatPortalJstDate(value) { const ms = typeof value === 'number' ? value : parsePortalInstantMs(value); if (!Number.isFinite(ms)) return ''; const p = portalJstParts(ms); return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`; }
// Start (00:00+09:00) of a JST day; with exclusiveEnd the start of the next day.
function portalJstDateBoundaryIso(dateText, exclusiveEnd = false) { const days = portalCalendarDayNumber(String(dateText || '').trim()); if (days === null) return ''; return `${portalCalendarDateFromDayNumber(exclusiveEnd ? days + 1 : days)}T00:00:00+09:00`; }
// Newest first by instant; unknown values last; ties by id (newest first).
function portalInstantOrder(value) {
    const ms = parsePortalInstantMs(value);
    if (!Number.isFinite(ms)) return null;
    const fraction = String(value).trim().match(PORTAL_INSTANT_RE)[7] || '';
    return BigInt(ms) * 1000000n + BigInt(fraction.padEnd(9, '0').slice(3));
}
function comparePortalInstantDesc(a, b, field = 'created_at') {
    const left = portalInstantOrder(a?.[field]); const right = portalInstantOrder(b?.[field]);
    if ((left === null) !== (right === null)) return left === null ? 1 : -1;
    if (left !== null && left !== right) return left > right ? -1 : 1;
    return Number(b?.id || 0) - Number(a?.id || 0);
}
function comparePortalInstantAsc(a, b, field = 'created_at') {
    const left = portalInstantOrder(a?.[field]); const right = portalInstantOrder(b?.[field]);
    if ((left === null) !== (right === null)) return left === null ? 1 : -1;
    return left === right ? 0 : left < right ? -1 : 1;
}
function formatDateWithWeekday(dateText, fallback = '未定') { if (!dateText) return fallback; const days = portalCalendarDayNumber(dateText); if (days === null) return '日付不明'; const weekday = new Date(days * 86400000).getUTCDay(); return `${String(dateText).replace(/-/g, '/')}（${PORTAL_WEEKDAYS[weekday]}）`; }
function formatDateTimeLabel(value) { if (!value) return '未記録'; const ms = parsePortalInstantMs(value); if (!Number.isFinite(ms)) return '日時不明'; return `${formatDateWithWeekday(formatPortalJstDate(ms))} ${formatPortalJstTime(ms)}`; }
function daysUntil(dateText) { const target = portalCalendarDayNumber(dateText); const base = portalCalendarDayNumber(window.portalRuntimeContext.today()); if (target === null || base === null) return null; return target - base; }
// YYYY-MM-DD 形式かつ実在する日付かを判定する
function isValidPerformanceDate(dateStr) { return portalCalendarDayNumber(dateStr) !== null; }
// YYYY-MM-DD 形式かつ実在する日付で、today()以降であるか判定する
function isUpcomingPerformanceDate(dateStr) { return isValidPerformanceDate(dateStr) && dateStr >= window.portalRuntimeContext.today(); }
function formatDurationLabel(file) { if (file.duration) return file.duration; if (file.duration_seconds || file.duration_seconds === 0) { const total = Math.round(Number(file.duration_seconds)); const minutes = Math.floor(total / 60); const seconds = total % 60; return `${minutes}:${String(seconds).padStart(2, '0')}`; } return '長さ未取得'; }
function normalizeClockText(value) { const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/); if (!match) return ''; const hour = Number(match[1]); const minute = Number(match[2]); if (Number.isNaN(hour) || Number.isNaN(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return ''; return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`; }
function addMinutesToClockText(start, minutes) { const normalizedStart = normalizeClockText(start); const add = Number(minutes); if (!normalizedStart || Number.isNaN(add)) return ''; const [h, m] = normalizedStart.split(':').map((part) => Number(part)); const total = h * 60 + m + add; if (total < 0) return ''; const normalized = ((total % (24 * 60)) + (24 * 60)) % (24 * 60); const endH = Math.floor(normalized / 60); const endM = normalized % 60; return `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`; }
function normalizePerformancePieces(pieces) {
    return (pieces || []).map((piece) => {
        if (typeof piece === 'string') {
            return { composer: '', title: piece, part: '' };
        }
        return {
            composer: piece.composer || '',
            title: piece.title || piece.name || '',
            alias: piece.alias || piece.short_name || '',
            part: piece.part || piece.section || '',
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
    return (piece.is_encore || piece.encore) ? `${label}(アンコール)` : label;
}
function performancePieceFormalLabel(piece) {
    if (typeof piece === 'string') return piece;
    const label = piece.composer ? `${piece.composer}: ${piece.title}` : piece.title;
    return (piece.is_encore || piece.encore) ? `${label}(アンコール)` : label;
}
function performancePieceLookupLabels(piece) {
    if (typeof piece === 'string') return [piece].filter(Boolean);
    const partPrefix = String(piece.part || piece.section || '').trim();
    return [
        performancePieceLabel(piece),
        performancePieceFormalLabel(piece),
        // 旧表示名で登録された曲紹介・練習指示との照合を保つ。
        (piece.is_encore || piece.encore) ? `(${piece.alias || piece.short_name || (piece.composer ? `${piece.composer}: ${piece.title}` : piece.title)})` : '',
        (piece.is_encore || piece.encore) ? `(${piece.composer ? `${piece.composer}: ${piece.title}` : piece.title})` : '',
        partPrefix,
        partPrefix && piece.title ? `${partPrefix} ${piece.title}` : '',
        partPrefix && piece.alias ? `${partPrefix} ${piece.alias}` : '',
        partPrefix && piece.composer && piece.title ? `${partPrefix} ${piece.composer}: ${piece.title}` : '',
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
function uploadPieceOptions(performance, concertPerformanceLabel, wholePracticeLabel) {
    if (!performance) return [];

    const options = normalizePerformancePieces(performance.pieces || [])
        .map((piece) => ({
            value: performancePieceLabel(piece),
            label: performancePieceFormalLabel(piece)
        }))
        .filter((option) => option.value);

    options.push({
        value: concertPerformanceLabel,
        label: concertPerformanceLabel
    });

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
