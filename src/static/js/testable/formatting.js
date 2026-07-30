(function (globalObj) {
    function cloudRunRevisionLabel(revision) {
        const value = String(revision || '').trim();
        if (!value) return '';
        const match = value.match(/(?:^|-)(\d{5}-[a-z0-9]+)$/i);
        return match ? match[1] : value;
    }
    function formatClockTime(value) {
        const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?/);
        return match ? `${match[1].padStart(2, '0')}:${match[2]}` : String(value || '').trim();
    }
    function splitTimeRange(value) {
        const match = String(value || '').match(/(\d{1,2}:\d{2}(?::\d{2})?)\s*(?:-|〜|~|～)\s*(\d{1,2}:\d{2}(?::\d{2})?)/);
        return match ? { start: formatClockTime(match[1]), end: formatClockTime(match[2]) } : { start: '', end: '' };
    }
    function formatTimeRange(start, end) {
        const formattedStart = formatClockTime(start);
        const formattedEnd = formatClockTime(end);
        return formattedStart && formattedEnd ? `${formattedStart} - ${formattedEnd}` : formattedStart || formattedEnd || '';
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
        const normalizedTime = formatClockTime(time);
        if (!normalizedTime) return ymd;
        return `${ymd}T${normalizedTime.replaceAll(':', '')}00`;
    }
    function nextAllDayDate(date) {
        if (!date) return '';
        const value = new Date(`${date}T00:00:00`);
        value.setDate(value.getDate() + 1);
        const y = value.getFullYear();
        const m = String(value.getMonth() + 1).padStart(2, '0');
        const d = String(value.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }
    function icsEscape(value) {
        return String(value || '').replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll(',', '\\,').replaceAll(';', '\\;');
    }
    function displayNameWithoutExtension(name = '') { return String(name || '').replace(/\.[^.\\/]+$/, ''); }
    function formatDurationLabel(file) {
        if (file?.duration) return file.duration;
        if (file?.duration_seconds || file?.duration_seconds === 0) {
            const total = Math.round(Number(file.duration_seconds));
            const minutes = Math.floor(total / 60);
            const seconds = total % 60;
            return `${minutes}:${String(seconds).padStart(2, '0')}`;
        }
        return '長さ未取得';
    }
    function paymentMonthLabel(monthText) {
        const match = String(monthText || '').trim().match(/^(\d{4})-(\d{2})$/);
        if (!match) return '';
        return `${match[1]}年${match[2]}月`;
    }
    function paymentMonthValue(monthText) {
        if (!monthText || !/^\d{4}-\d{2}$/.test(String(monthText))) return null;
        const [year, month] = String(monthText).split('-').map(Number);
        return year * 12 + month;
    }
    function paymentCurrentMonthValue() {
        const today = typeof window !== 'undefined' && window.portalRuntimeContext && typeof window.portalRuntimeContext.today === 'function'
            ? window.portalRuntimeContext.today()
            : new Date().toISOString().slice(0, 10);
        return paymentMonthValue(String(today || '').slice(0, 7));
    }
    function paymentRemainingMonthCount(payment) {
        const paidUntil = paymentMonthValue(payment?.paid_until_month || payment?.membership_fee || payment?.dues || '');
        const current = paymentCurrentMonthValue();
        if (paidUntil === null || current === null) return null;
        return Math.max(0, current - paidUntil);
    }
    function paymentPaymentRangeLabel(payment) {
        const until = payment?.paid_until_month || payment?.membership_fee || payment?.dues || '';
        if (!until) return '未登録';
        const label = paymentMonthLabel(until);
        if (!label) return '未登録';
        const remaining = paymentRemainingMonthCount(payment);
        if (remaining === null || remaining <= 0) return `${label}まで支払済み`;
        return `${label}まで支払済み（${remaining}ヶ月分未納）`;
    }
    function integerAmountNumber(value) {
        const amount = Number(value || 0);
        return Number.isFinite(amount) && amount > 0 ? Math.round(amount) : 0;
    }
    function integerAmountInputValue(value) {
        const amount = integerAmountNumber(value);
        return amount > 0 ? String(amount) : '';
    }
    function yenAmountLabel(value, fallback = '未設定') {
        const amount = integerAmountNumber(value);
        return amount > 0 ? `${amount.toLocaleString('ja-JP', { maximumFractionDigits: 0 })}円` : fallback;
    }
    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
    }
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
    const api = { cloudRunRevisionLabel, formatClockTime, splitTimeRange, formatTimeRange, addHoursToTime, compactCalendarDate, nextAllDayDate, icsEscape, displayNameWithoutExtension, formatDurationLabel, paymentPaymentRangeLabel, integerAmountNumber, integerAmountInputValue, yenAmountLabel, escapeHtml, convertUrlsToLinks };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    globalObj.FrontendTestableFormatting = api;
})(typeof window !== 'undefined' ? window : globalThis);
