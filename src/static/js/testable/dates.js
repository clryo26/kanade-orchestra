(function (globalObj) {
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
        const normalized = String(text || '').toLowerCase().replace(/https?:\/\/\S+/g, ' ').replace(/[\r\n\t]/g, ' ');
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
        const stopWords = new Set(['です', 'ます', 'した', 'ので', 'ため', 'について', 'こと', 'それ', 'これ', 'こちら', 'あちら', '参加', '調整', '不可', '可能', '予定', '未定', '回答', 'コメント', '日程', '候補日']);
        const frequency = new Map();
        (notes || []).forEach((note) => {
            dateAdjustmentKeywordTokens(note).forEach((token) => {
                if (stopWords.has(token)) return;
                frequency.set(token, (frequency.get(token) || 0) + 1);
            });
        });
        return Array.from(frequency.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ja')).slice(0, maxCount);
    }

    function dedupeDateAdjustmentResponses(responses) {
        const map = new Map();
        (responses || []).forEach((response) => {
            const key = `${String(response.candidate_id || '')}|${dateAdjustmentOwnerKey(response)}`;
            if (!key.startsWith('|')) map.set(key, response);
        });
        return Array.from(map.values());
    }

    function dateAdjustmentCandidateLabel(candidate, formatDateWithWeekdayFn) {
        const formatter = typeof formatDateWithWeekdayFn === 'function' ? formatDateWithWeekdayFn : ((d, fallback) => fallback || d || '');
        const date = candidate?.date ? formatter(candidate.date, candidate.date) : '';
        const start = String(candidate?.start_time || '').trim();
        const end = String(candidate?.end_time || '').trim();
        const time = start && end ? `${start}-${end}` : (start || end);
        const note = String(candidate?.note || '').trim();
        const blocks = [date, time, note].filter(Boolean);
        return blocks.join(' / ') || '候補日未設定';
    }

    function moveDateAdjustmentCandidateRow(rowsContainer, row, direction) {
        if (!rowsContainer || !row) return false;
        if (direction < 0) {
            const previous = row.previousElementSibling;
            if (!previous) return false;
            rowsContainer.insertBefore(row, previous);
            return true;
        }
        if (direction > 0) {
            const next = row.nextElementSibling;
            if (!next) return false;
            rowsContainer.insertBefore(next, row);
            return true;
        }
        return false;
    }

    function buildDateAdjustmentSummary(adjustment, responses, members, memberDisplayNameFn) {
        const candidates = Array.isArray(adjustment?.candidates) ? adjustment.candidates : [];
        const related = dedupeDateAdjustmentResponses((responses || []).filter((item) => String(item.adjustment_id || '') === String(adjustment?.id || '')));
        const candidateStats = candidates.map((candidate, index) => {
            const candidateResponses = related.filter((item) => String(item.candidate_id || '') === String(candidate.id || ''));
            const ok = candidateResponses.filter((item) => item.status === 'ok').length;
            const maybe = candidateResponses.filter((item) => item.status === 'maybe').length;
            const ng = candidateResponses.filter((item) => item.status === 'ng').length;
            const commentCount = candidateResponses.filter((item) => String(item.note || '').trim()).length;
            const score = (ok * 2) + maybe;
            return { candidate, candidateResponses, ok, maybe, ng, commentCount, score, index };
        });
        const rankedCandidates = [...candidateStats].sort((a, b) => b.score - a.score || b.ok - a.ok || a.ng - b.ng || a.index - b.index);
        const rankByCandidateId = new Map(rankedCandidates.map((item, idx) => [String(item.candidate.id || ''), idx + 1]));
        const bestCandidateId = String(rankedCandidates[0]?.candidate?.id || '');
        const respondentMap = new Map();
        related.forEach((item) => {
            const key = dateAdjustmentOwnerKey(item);
            if (!respondentMap.has(key)) respondentMap.set(key, { name: item.name || '不明', statuses: {}, hasComment: false });
            respondentMap.get(key).statuses[String(item.candidate_id || '')] = item.status || '';
            if (String(item.note || '').trim()) respondentMap.get(key).hasComment = true;
        });
        const respondentRowsData = Array.from(respondentMap.values());
        const displayName = typeof memberDisplayNameFn === 'function' ? memberDisplayNameFn : ((member) => String(member?.name || ''));
        const answeredOwners = new Set(Array.from(respondentMap.keys()));
        const unansweredMembers = (members || []).filter((member) => {
            const key = String(member.id || '').trim() ? `member:${String(member.id || '').trim()}` : `name:${displayName(member).trim()}`;
            return key && !answeredOwners.has(key);
        });
        return { candidates, related, candidateStats, rankedCandidates, rankByCandidateId, bestCandidateId, respondentRowsData, unansweredMembers };
    }

    function filterRespondentRows(rows, commentOnly) {
        return commentOnly ? (rows || []).filter((row) => row.hasComment) : (rows || []);
    }

    const api = { dateAdjustmentOwnerKey, dateAdjustmentStatusLabel, dateAdjustmentStatusText, dateAdjustmentKeywordTokens, dateAdjustmentFrequentKeywordsFromNotes, dedupeDateAdjustmentResponses, dateAdjustmentCandidateLabel, moveDateAdjustmentCandidateRow, buildDateAdjustmentSummary, filterRespondentRows };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    globalObj.FrontendTestableDates = api;
})(typeof window !== 'undefined' ? window : globalThis);