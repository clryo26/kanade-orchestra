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
function compactCalendarDate(date, time = '') { const ymd = String(date || '').replaceAll('-', ''); if (!ymd) return ''; if (!time) return ymd; return `${ymd}T${String(time).replace(':', '')}00`; }
function nextAllDayDate(date) { if (!date) return ''; const value = new Date(`${date}T00:00:00`); value.setDate(value.getDate() + 1); const y = value.getFullYear(); const m = String(value.getMonth() + 1).padStart(2, '0'); const d = String(value.getDate()).padStart(2, '0'); return `${y}-${m}-${d}`; }
function icsEscape(value) { return String(value || '').replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll(',', '\\,').replaceAll(';', '\\;'); }
function icsDateTime(date, time = '') { const compact = compactCalendarDate(date, time); return time ? compact : compact; }
function fileToDataUrl(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.addEventListener('load', () => resolve(String(reader.result || ''))); reader.addEventListener('error', () => reject(reader.error || new Error('画像を読み込めませんでした'))); reader.readAsDataURL(file); }); }
function partSortIndex(partName) { const index = currentPartNames().indexOf(String(partName || '')); return index === -1 ? 9999 : index; }
function cssSafeId(value) { return encodeURIComponent(String(value || 'none')).replace(/%/g, ''); }
function paymentPaymentRangeLabel(payment) { const until = payment.paid_until_month || payment.membership_fee || payment.dues || ''; return until ? `${until}まで支払い済み` : '未登録'; }
function formatDateWithWeekday(dateText, fallback = '未定') { if (!dateText) return fallback; const date = new Date(`${dateText}T00:00:00`); if (Number.isNaN(date.getTime())) return dateText; const weekdays = ['日', '月', '火', '水', '木', '金', '土']; const formattedDate = dateText.replace(/-/g, '/'); return `${formattedDate}（${weekdays[date.getDay()]}）`; }
function formatDateTimeLabel(value) { if (!value) return '未記録'; const date = new Date(value); if (Number.isNaN(date.getTime())) return value; const dateText = date.toISOString().slice(0, 10); const timeText = date.toTimeString().slice(0, 5); return `${formatDateWithWeekday(dateText)} ${timeText}`; }
function daysUntil(dateText) { const target = new Date(`${dateText}T00:00:00`); const base = new Date(`${window.portalRuntimeContext.today()}T00:00:00`); if (Number.isNaN(target.getTime())) return null; return Math.ceil((target - base) / 86400000); }
function formatDurationLabel(file) { if (file.duration) return file.duration; if (file.duration_seconds || file.duration_seconds === 0) { const total = Math.round(Number(file.duration_seconds)); const minutes = Math.floor(total / 60); const seconds = total % 60; return `${minutes}:${String(seconds).padStart(2, '0')}`; } return '長さ未取得'; }
function normalizeClockText(value) { const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/); if (!match) return ''; const hour = Number(match[1]); const minute = Number(match[2]); if (Number.isNaN(hour) || Number.isNaN(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return ''; return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`; }
function addMinutesToClockText(start, minutes) { const normalizedStart = normalizeClockText(start); const add = Number(minutes); if (!normalizedStart || Number.isNaN(add)) return ''; const [h, m] = normalizedStart.split(':').map((part) => Number(part)); const total = h * 60 + m + add; if (total < 0) return ''; const normalized = ((total % (24 * 60)) + (24 * 60)) % (24 * 60); const endH = Math.floor(normalized / 60); const endM = normalized % 60; return `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`; }
function isAdmin_Portal() { const permission = String(appState.currentUserPermission || ''); return permission === '管理者' || permission === 'システム管理者'; }
function jsonOptions(method, payload) { return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }; }
function emptyText(items, message) { return items.length ? '' : `<li class="list-group-item text-muted">${message}</li>`; }
function groupBy(items, key) { return items.reduce((groups, item) => { const value = item[key] || '未分類'; groups[value] = groups[value] || []; groups[value].push(item); return groups; }, {}); }
function formatBytes(bytes) { if (!bytes) return '0 B'; const units = ['B', 'KB', 'MB', 'GB']; const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1); return `${(bytes / Math.pow(1024, index)).toFixed(index ? 1 : 0)} ${units[index]}`; }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char])); }
function convertUrlsToLinks(text) { const urlRegex = /(https?:\/\/[^\s]+)/g; return escapeHtml(text).replace(urlRegex, (url) => { try { new URL(url); return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="text-decoration-underline">${escapeHtml(url)}</a>`; } catch { return escapeHtml(url); } }); }