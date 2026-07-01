// Date adjustment helpers split from modules/date_piece_promotion.js.
// Keep global names for compatibility with legacy non-module loading.

var appState = window.portalRuntimeContext.appState;
var $ = window.portalRuntimeContext.getById;

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
    const normalizeToken = (token) => String(token || '').split(/(?:だと|では|には|とは|は|で|に|の|が|を|へ|と|も)/u)[0] || token;
    try {
        const pattern = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{2,}|[a-z0-9]{2,}/gu;
        return (normalized.match(pattern) || []).map(normalizeToken).filter(Boolean);
    } catch {
        const fallbackPattern = /[\u3040-\u30FF\u3400-\u9FFF]{2,}|[a-z0-9]{2,}/g;
        return (normalized.match(fallbackPattern) || []).map(normalizeToken).filter(Boolean);
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
