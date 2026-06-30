// Frontend split: extracted from main.js.
// Loaded after main.js; functions intentionally remain global for legacy handlers.

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
        // Unicode property escapes 非対応ブラウザ向けフォールバック。
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

function renderDateAdjustmentList() {
    const list = $('memberDateAdjustmentList');
    if (!list) return;
    const adjustments = sortedDateAdjustments(appState.dateAdjustments);
    if (!adjustments.length) {
        list.innerHTML = '<p class="text-muted mb-0">日程調整はまだありません</p>';
        return;
    }

    list.innerHTML = '';
    adjustments.forEach((adjustment) => {
        const related = dedupeDateAdjustmentResponses(appState.dateAdjustmentResponses.filter((item) => String(item.adjustment_id || '') === String(adjustment.id || '')));
        const respondentCount = new Set(related.map((item) => dateAdjustmentOwnerKey(item))).size;
        const candidateCount = dateAdjustmentCandidates(adjustment).length;
        const element = document.createElement('button');
        element.type = 'button';
        element.className = 'list-group-item list-group-item-action text-start';
        element.innerHTML = `
            <strong>${escapeHtml(adjustment.title || '日程調整')}</strong>
            <div class="small text-muted">回答期限: ${escapeHtml(formatDateWithWeekday(adjustment.deadline, '未設定'))} / 候補日: ${candidateCount}件 / 回答者: ${respondentCount}名</div>
            ${adjustment.notes ? `<div class="small multiline-text mt-1">${escapeHtml(adjustment.notes)}</div>` : ''}
        `;
        element.addEventListener('click', () => renderDateAdjustmentDetail(adjustment.id));
        list.appendChild(element);
    });
}

function bindDateAdjustmentCandidateRows() {
    const rows = $('dateAdjustmentCandidateRows');
    if (!rows) return;
    rows.querySelectorAll('.date-adjustment-candidate-up').forEach((button) => {
        button.addEventListener('click', () => {
            const row = button.closest('.date-adjustment-candidate-row');
            if (!row) return;
            const previous = row.previousElementSibling;
            if (!previous) return;
            rows.insertBefore(row, previous);
            refreshDateAdjustmentCandidateRowControls();
        });
    });
    rows.querySelectorAll('.date-adjustment-candidate-down').forEach((button) => {
        button.addEventListener('click', () => {
            const row = button.closest('.date-adjustment-candidate-row');
            if (!row) return;
            const next = row.nextElementSibling;
            if (!next) return;
            rows.insertBefore(next, row);
            refreshDateAdjustmentCandidateRowControls();
        });
    });
    rows.querySelectorAll('.date-adjustment-candidate-remove').forEach((button) => {
        button.addEventListener('click', () => {
            const allRows = rows.querySelectorAll('.date-adjustment-candidate-row');
            if (allRows.length <= 1) {
                showAlert('候補日は1件以上必要です', 'warning');
                return;
            }
            button.closest('.date-adjustment-candidate-row')?.remove();
            refreshDateAdjustmentCandidateRowControls();
        });
    });
    refreshDateAdjustmentCandidateRowControls();
}

function renderDateAdjustmentView() {
    const container = $('memberDateAdjustmentInfo');
    if (!container) return;

    container.innerHTML = `
        <div id="memberDateAdjustmentListView">
            <h6>日程調整一覧</h6>
            <div class="list-group mb-3" id="memberDateAdjustmentList"></div>
            <h6>日程調整を作成</h6>
            <div class="row g-2 mb-2">
                <div class="col-md-5"><label class="form-label">タイトル</label><input id="dateAdjustmentTitle" class="form-control" placeholder="例: 夏合宿の日程調整"></div>
                <div class="col-md-3"><label class="form-label">回答期限</label><input id="dateAdjustmentDeadline" type="date" class="form-control"></div>
                <div class="col-md-4"><label class="form-label">削除時の合言葉（任意）</label><input id="dateAdjustmentDeletePhrase" class="form-control" placeholder="任意"></div>
                <div class="col-12"><label class="form-label">説明</label><textarea id="dateAdjustmentNotes" class="form-control" rows="2" placeholder="用途や集合条件など"></textarea></div>
            </div>
            <div class="mb-2"><strong>候補日</strong></div>
            <div id="dateAdjustmentCandidateRows"></div>
            <div class="d-flex flex-wrap gap-2 mb-3">
                <button id="dateAdjustmentAddCandidateBtn" class="btn btn-outline-secondary" type="button">候補日を追加</button>
                <button id="dateAdjustmentCreateBtn" class="btn btn-primary" type="button">日程調整を作成</button>
            </div>
        </div>
        <div id="memberDateAdjustmentDetailView" hidden></div>
    `;

    const candidateRows = $('dateAdjustmentCandidateRows');
    if (candidateRows) {
        candidateRows.innerHTML = dateAdjustmentCandidateRowHtml({ date: today() }, false);
    }
    if ($('dateAdjustmentDeadline')) $('dateAdjustmentDeadline').value = today();

    $('dateAdjustmentAddCandidateBtn')?.addEventListener('click', () => {
        const rows = $('dateAdjustmentCandidateRows');
        if (!rows) return;
        rows.insertAdjacentHTML('beforeend', dateAdjustmentCandidateRowHtml({ date: today() }, true));
        bindDateAdjustmentCandidateRows();
    });
    bindDateAdjustmentCandidateRows();

    $('dateAdjustmentCreateBtn')?.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '作成中...', async () => {
        const title = $('dateAdjustmentTitle')?.value.trim() || '';
        const candidates = collectDateAdjustmentCandidates();
        if (!title) {
            showAlert('タイトルを入力してください', 'warning');
            return;
        }
        if (!candidates.length) {
            showAlert('候補日を1件以上入力してください', 'warning');
            return;
        }

        const payload = {
            title,
            deadline: $('dateAdjustmentDeadline')?.value || '',
            notes: $('dateAdjustmentNotes')?.value.trim() || '',
            delete_phrase: $('dateAdjustmentDeletePhrase')?.value.trim() || '',
            created_by: currentUserMemberName(),
            member_id: appState.currentUserMemberId,
            candidates
        };
        await saveExtra('date_adjustments', payload);
        await loadExtraData();
        showAlert('日程調整を作成しました', 'success');
    }));

    renderDateAdjustmentList();
}

function renderDateAdjustmentDetail(adjustmentId) {
    const listView = $('memberDateAdjustmentListView');
    const detailView = $('memberDateAdjustmentDetailView');
    const adjustment = appState.dateAdjustments.find((item) => String(item.id || '') === String(adjustmentId));
    if (!listView || !detailView || !adjustment) return;

    listView.hidden = true;
    detailView.hidden = false;

    const candidates = dateAdjustmentCandidates(adjustment);
    const related = dedupeDateAdjustmentResponses(appState.dateAdjustmentResponses.filter((item) => String(item.adjustment_id || '') === String(adjustment.id || '')));
    const myResponses = related.filter((item) => currentUserMatchesDateAdjustmentResponse(item));

    const candidateStats = candidates.map((candidate, index) => {
        const candidateResponses = related.filter((item) => String(item.candidate_id || '') === String(candidate.id || ''));
        const ok = candidateResponses.filter((item) => item.status === 'ok').length;
        const maybe = candidateResponses.filter((item) => item.status === 'maybe').length;
        const ng = candidateResponses.filter((item) => item.status === 'ng').length;
        const commentCount = candidateResponses.filter((item) => String(item.note || '').trim()).length;
        const score = (ok * 2) + maybe;
        return { candidate, candidateResponses, ok, maybe, ng, commentCount, score, index };
    });
    const rankedCandidates = [...candidateStats].sort((a, b) =>
        b.score - a.score
        || b.ok - a.ok
        || a.ng - b.ng
        || a.index - b.index
    );
    const rankByCandidateId = new Map(rankedCandidates.map((item, idx) => [String(item.candidate.id || ''), idx + 1]));
    const bestCandidateId = String(rankedCandidates[0]?.candidate?.id || '');

    const rows = candidateStats.map((item) => {
        const rank = rankByCandidateId.get(String(item.candidate.id || '')) || '-';
        return `<tr><td>${escapeHtml(dateAdjustmentCandidateLabel(item.candidate))}</td><td>${rank}</td><td>${item.score}</td><td>${item.ok}</td><td>${item.maybe}</td><td>${item.ng}</td><td>${item.commentCount}</td></tr>`;
    }).join('');

    const commentSections = candidateStats.map((item) => {
        const candidate = item.candidate;
        const candidateResponses = item.candidateResponses;
        const commented = candidateResponses.filter((item) => String(item.note || '').trim());
        const keywords = dateAdjustmentFrequentKeywordsFromNotes(commented.map((item) => String(item.note || '').trim()));
        const keywordBadges = keywords.length
            ? `<div class="small text-muted mb-2">頻出キーワード: ${keywords.map(([word, count]) => `<span class="badge text-bg-light me-1">${escapeHtml(word)} (${count})</span>`).join('')}</div>`
            : '<div class="small text-muted mb-2">頻出キーワード: なし</div>';
        const lines = commented.map((item) => `<li>${escapeHtml(item.name || '不明')}（${escapeHtml(dateAdjustmentStatusText(item.status || ''))}）: ${escapeHtml(String(item.note || '').trim())}</li>`).join('');
        return `
            <section class="info-block">
                <h6 class="mb-2">${escapeHtml(dateAdjustmentCandidateLabel(candidate))}</h6>
                ${keywordBadges}
                ${lines ? `<ul class="mb-0">${lines}</ul>` : '<p class="text-muted mb-0">コメントはまだありません</p>'}
            </section>
        `;
    }).join('');

    const respondentMap = new Map();
    related.forEach((item) => {
        const key = dateAdjustmentOwnerKey(item);
        if (!respondentMap.has(key)) respondentMap.set(key, { name: item.name || '不明', statuses: {}, hasComment: false });
        respondentMap.get(key).statuses[String(item.candidate_id || '')] = item.status || '';
        if (String(item.note || '').trim()) respondentMap.get(key).hasComment = true;
    });
    const respondentRowsData = Array.from(respondentMap.values());
    const answeredOwners = new Set(Array.from(respondentMap.keys()));
    const unansweredMembers = (appState.members || []).filter((member) => {
        const key = String(member.id || '').trim() ? `member:${String(member.id || '').trim()}` : `name:${memberDisplayName(member).trim()}`;
        return key && !answeredOwners.has(key);
    });
    const reminderMessage = `日程調整「${adjustment.title || '日程調整'}」が未回答です。回答期限: ${formatDateWithWeekday(adjustment.deadline, '未設定')}。ご都合の入力をお願いします。`;
    const respondentRowsHtml = (commentOnly = false) => {
        const rows = commentOnly ? respondentRowsData.filter((row) => row.hasComment) : respondentRowsData;
        if (!rows.length) {
            return `<tr><td colspan="${candidates.length + 1}" class="text-muted">${commentOnly ? 'コメント付き回答はまだありません' : '回答はまだありません'}</td></tr>`;
        }
        return rows.map((row) => `
            <tr>
                <td>${escapeHtml(row.name || '')}</td>
                ${candidates.map((candidate) => `<td>${escapeHtml(dateAdjustmentStatusLabel(row.statuses[String(candidate.id || '')] || ''))}</td>`).join('')}
            </tr>
        `).join('');
    };

    detailView.innerHTML = `
        <button class="btn btn-sm btn-outline-secondary mb-3" id="dateAdjustmentBackBtn" type="button">日程調整一覧に戻る</button>
        <section class="info-block pt-0">
            <h5>${escapeHtml(adjustment.title || '日程調整')}</h5>
            <div>回答期限: ${escapeHtml(formatDateWithWeekday(adjustment.deadline, '未設定'))}</div>
            <div>作成者: ${escapeHtml(adjustment.created_by || '未設定')}</div>
            ${adjustment.notes ? `<div class="multiline-text mt-2">${escapeHtml(adjustment.notes)}</div>` : ''}
        </section>
        <h6>候補日ごとの集計</h6>
        <div class="table-responsive mb-3">
            <table class="table table-sm table-bordered align-middle">
                <thead><tr><th>候補日</th><th>順位</th><th>スコア</th><th>○</th><th>△</th><th>×</th><th>コメント数</th></tr></thead>
                <tbody>${rows || '<tr><td colspan="7" class="text-muted">候補日がありません</td></tr>'}</tbody>
            </table>
        </div>
        ${bestCandidateId ? `<div class="alert alert-info py-2">第1候補: ${escapeHtml(dateAdjustmentCandidateLabel(candidates.find((item) => String(item.id || '') === bestCandidateId) || {}))}</div>` : ''}
        <h6>回答コメントの集計</h6>
        <div class="mb-3">${commentSections || '<p class="text-muted mb-0">コメントはまだありません</p>'}</div>
        <h6>自分の回答</h6>
        <div class="row g-2 mb-3">
            ${candidates.map((candidate) => {
                const current = myResponses.find((item) => String(item.candidate_id || '') === String(candidate.id || ''));
                return `
                    <div class="col-12">
                        <label class="form-label">${escapeHtml(dateAdjustmentCandidateLabel(candidate))}</label>
                        <div class="row g-2 align-items-center">
                            <div class="col-md-3">
                                <select class="form-select date-adjustment-my-status" data-candidate-id="${escapeHtml(String(candidate.id || ''))}">
                                    <option value="">未回答</option>
                                    <option value="ok" ${current?.status === 'ok' ? 'selected' : ''}>○ 参加可</option>
                                    <option value="maybe" ${current?.status === 'maybe' ? 'selected' : ''}>△ 調整可</option>
                                    <option value="ng" ${current?.status === 'ng' ? 'selected' : ''}>× 不可</option>
                                </select>
                            </div>
                            <div class="col-md-9">
                                <input class="form-control date-adjustment-my-note" data-candidate-id="${escapeHtml(String(candidate.id || ''))}" value="${escapeHtml(String(current?.note || ''))}" placeholder="メモ（任意）">
                            </div>
                        </div>
                    </div>
                `;
            }).join('')}
            <div class="col-12 d-flex flex-wrap gap-2">
                <button class="btn btn-primary" id="dateAdjustmentSaveResponseBtn" type="button">回答を保存</button>
                ${dateAdjustmentCanDelete(adjustment) ? '<button class="btn btn-outline-danger" id="dateAdjustmentDeleteBtn" type="button">この日程調整を削除</button>' : ''}
            </div>
        </div>
        <h6>団員の回答一覧</h6>
        <div class="form-check mb-2">
            <input class="form-check-input" type="checkbox" id="dateAdjustmentCommentOnlyToggle">
            <label class="form-check-label" for="dateAdjustmentCommentOnlyToggle">コメントあり回答のみ抽出</label>
        </div>
        <div class="table-responsive">
            <table class="table table-sm table-bordered align-middle">
                <thead><tr><th>名前</th>${candidates.map((candidate) => `<th>${escapeHtml(dateAdjustmentCandidateLabel(candidate))}</th>`).join('')}</tr></thead>
                <tbody id="dateAdjustmentRespondentBody">${respondentRowsHtml(false)}</tbody>
            </table>
        </div>
        <h6 class="mt-3">未回答者とリマインド</h6>
        <div class="info-block">
            <div class="small mb-2">未回答者: ${unansweredMembers.length}名</div>
            ${unansweredMembers.length
                ? `<ul class="mb-2">${unansweredMembers.map((member) => `<li>${escapeHtml(memberDisplayName(member) || '不明')}</li>`).join('')}</ul>`
                : '<p class="text-muted mb-2">未回答者はいません</p>'}
            <div class="d-flex flex-wrap gap-2">
                <button class="btn btn-sm btn-outline-primary" id="dateAdjustmentCopyReminderBtn" type="button" ${unansweredMembers.length ? '' : 'disabled'}>リマインド文面をコピー</button>
            </div>
        </div>
    `;

    $('dateAdjustmentBackBtn')?.addEventListener('click', () => {
        detailView.hidden = true;
        listView.hidden = false;
        renderDateAdjustmentList();
    });

    $('dateAdjustmentCommentOnlyToggle')?.addEventListener('change', (event) => {
        const checked = Boolean(event.currentTarget?.checked);
        const body = $('dateAdjustmentRespondentBody');
        if (body) body.innerHTML = respondentRowsHtml(checked);
    });

    $('dateAdjustmentCopyReminderBtn')?.addEventListener('click', async () => {
        if (!unansweredMembers.length) {
            showAlert('未回答者はいません', 'info');
            return;
        }
        try {
            await navigator.clipboard.writeText(reminderMessage);
            showAlert('リマインド文面をコピーしました', 'success');
        } catch {
            showAlert(`コピーに失敗しました。文面: ${reminderMessage}`, 'warning');
        }
    });

    $('dateAdjustmentSaveResponseBtn')?.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '保存中...', async () => {
        const name = currentUserMemberName();
        if (!name) {
            showAlert('ログイン中の団員情報が見つかりません', 'warning');
            return;
        }

        const allExisting = appState.dateAdjustmentResponses.filter((item) => String(item.adjustment_id || '') === String(adjustment.id || '') && currentUserMatchesDateAdjustmentResponse(item));
        const existingByCandidate = new Map();
        allExisting.forEach((item) => {
            const key = String(item.candidate_id || '');
            const list = existingByCandidate.get(key) || [];
            list.push(item);
            existingByCandidate.set(key, list);
        });

        for (const candidate of candidates) {
            const candidateId = String(candidate.id || '');
            const status = detailView.querySelector(`.date-adjustment-my-status[data-candidate-id="${CSS.escape(candidateId)}"]`)?.value || '';
            const note = detailView.querySelector(`.date-adjustment-my-note[data-candidate-id="${CSS.escape(candidateId)}"]`)?.value?.trim() || '';
            const existing = existingByCandidate.get(candidateId) || [];
            const primary = existing[0];
            const duplicates = existing.slice(1);

            if (status) {
                const payload = {
                    adjustment_id: adjustment.id,
                    candidate_id: candidate.id,
                    name,
                    member_id: appState.currentUserMemberId,
                    status,
                    note
                };
                if (primary?.id) {
                    await request(`/api/extra/date_adjustment_responses/${encodeURIComponent(primary.id)}`, jsonOptions('PUT', payload));
                } else {
                    await saveExtra('date_adjustment_responses', payload);
                }
            } else if (primary?.id) {
                await request(`/api/extra/date_adjustment_responses/${encodeURIComponent(primary.id)}`, { method: 'DELETE' });
            }

            for (const duplicate of duplicates) {
                if (duplicate?.id) {
                    await request(`/api/extra/date_adjustment_responses/${encodeURIComponent(duplicate.id)}`, { method: 'DELETE' });
                }
            }
        }

        await loadExtraData();
        renderDateAdjustmentDetail(adjustment.id);
        showAlert('回答を保存しました', 'success');
    }));

    $('dateAdjustmentDeleteBtn')?.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', async () => {
        if (!dateAdjustmentCanDelete(adjustment)) {
            showAlert('削除権限がありません', 'warning');
            return;
        }
        if (adjustment.delete_phrase) {
            const phrase = prompt('削除時の合言葉を入力してください');
            if (phrase === null) return;
            if (phrase !== adjustment.delete_phrase) {
                showAlert('削除時の合言葉が違います', 'danger');
                return;
            }
        }
        if (!confirmDelete()) return;

        const relatedResponses = appState.dateAdjustmentResponses.filter((item) => String(item.adjustment_id || '') === String(adjustment.id || ''));
        await Promise.all(relatedResponses.filter((item) => item.id).map((item) => request(`/api/extra/date_adjustment_responses/${encodeURIComponent(item.id)}`, { method: 'DELETE' })));
        await request(`/api/extra/date_adjustments/${encodeURIComponent(adjustment.id)}`, { method: 'DELETE' });
        await loadExtraData();
        renderDateAdjustmentView();
        showAlert('日程調整を削除しました', 'success');
    }));
}

// renderMemberEventView moved to feature module.

// renderMemberEventList moved to feature module.

// renderMemberEventDetail moved to feature module.

// uniqueEventResponses moved to feature module.

// renderGroupedEventResponses moved to feature module.

function renderPieceInfoView() {
    const container = $('memberPieceInfo');
    if (!container) return;

    const upcomingPerformances = [...(appState.performances || [])]
        .filter((perf) => perf.date && perf.date >= today())
        .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')) || String(a.title || '').localeCompare(String(b.title || ''), 'ja'));

    const rows = pieceScopedRows(upcomingPerformances, appState.pieceInfos);

    if (!rows.length) {
        appState.selectedPieceInfoContext = null;
        appState.pieceInfoEditing = false;
        container.innerHTML = '<p class="text-muted mb-0">未開催の演奏会はありません</p>';
        return;
    }

    const hasPiece = (performanceId, piece) => rows.some((row) =>
        row.performanceId === String(performanceId || '')
        && row.pieces.some((candidate) => performancePieceLookupLabels(candidate).includes(String(piece || '').trim()))
    );
    const selectedContext = appState.selectedPieceInfoContext;
    if (!selectedContext || !hasPiece(selectedContext.performanceId, selectedContext.piece)) {
        appState.selectedPieceInfoContext = null;
        appState.pieceInfoEditing = false;
    }

    if (!appState.selectedPieceInfoContext) {
        container.innerHTML = `
            <section class="info-block mb-3">
                <h5 class="mb-2">未開催演奏会の曲一覧</h5>
                <p class="text-muted small mb-0">曲を選択すると、曲ごとの楽曲情報登録・編集画面に遷移します。<span class="badge text-bg-success ms-1">情報あり</span> が登録済みの目印です。</p>
            </section>
            ${rows.map((row) => {
                const heading = `${formatDateWithWeekday(row.date, row.date)} ${row.title}`.trim();
                if (!row.pieces.length) {
                    return `
                        <section class="mb-3">
                            <h6 class="mb-2">${escapeHtml(heading)}</h6>
                            <p class="text-muted small mb-0">曲がまだ登録されていません</p>
                        </section>
                    `;
                }
                return `
                    <section class="mb-3">
                        <h6 class="mb-2">${escapeHtml(heading)}</h6>
                        <div class="list-group">
                            ${row.pieces.map((piece) => {
                                const pieceLabel = performancePieceFormalLabel(piece);
                                const existing = findPieceScopedItem(appState.pieceInfos, row.performanceId, piece);
                                const hasInfo = existing && String(existing.description || existing.notes || '').trim();
                                return `
                                    <button class="list-group-item list-group-item-action d-flex justify-content-between align-items-center gap-2 text-start" type="button" data-piece-info-performance-id="${escapeHtml(row.performanceId)}" data-piece-info-piece="${escapeHtml(encodeURIComponent(pieceLabel))}">
                                        <span>${escapeHtml(pieceLabel)}</span>
                                        ${hasInfo ? '<span class="badge text-bg-success">情報あり</span>' : ''}
                                    </button>
                                `;
                            }).join('')}
                        </div>
                    </section>
                `;
            }).join('')}
        `;

        container.querySelectorAll('[data-piece-info-performance-id][data-piece-info-piece]').forEach((button) => {
            button.addEventListener('click', () => {
                const performanceId = button.dataset.pieceInfoPerformanceId || '';
                const piece = decodeURIComponent(button.dataset.pieceInfoPiece || '');
                appState.selectedPieceInfoContext = { performanceId, piece };
                appState.pieceInfoEditing = false;
                renderPieceInfoView();
            });
        });
        return;
    }

    const performanceId = String(appState.selectedPieceInfoContext.performanceId || '');
    const piece = String(appState.selectedPieceInfoContext.piece || '');
    const performance = appState.performances.find((perf) => String(perf.id || '') === performanceId);
    const performancePiece = normalizePerformancePieces(performance?.pieces || []).find((candidate) => performancePieceLookupLabels(candidate).includes(piece)) || piece;
    const existing = findPieceScopedItem(appState.pieceInfos, performanceId, performancePiece);
    const initialDescription = String(existing?.description || existing?.notes || '');
    const isEditing = Boolean(appState.pieceInfoEditing);
    const actionButtonClass = isEditing ? 'btn-success' : 'btn-outline-primary';
    const actionButtonLabel = isEditing ? '保存' : '編集';

    container.innerHTML = `
        <section class="info-block mb-3">
            <button class="btn btn-sm btn-outline-secondary mb-3" id="pieceInfoBackBtn" type="button">曲一覧に戻る</button>
            <h5 class="mb-1">${escapeHtml(performance?.title || '演奏会未設定')}</h5>
            <div class="small text-muted mb-2">${escapeHtml(formatDateWithWeekday(performance?.date || '', '開催日未設定'))}</div>
            <h6 class="mb-0">${escapeHtml(piece)}</h6>
        </section>
        <section class="info-block">
            <div class="mb-3">
                <label class="form-label" for="memberPieceInfoDescription">楽曲情報</label>
                <textarea class="form-control" id="memberPieceInfoDescription" rows="8" ${isEditing ? '' : 'readonly'}>${escapeHtml(initialDescription)}</textarea>
                <div class="form-text">URLを記載するとリンクとして表示されます。</div>
            </div>
            <div class="d-flex flex-wrap gap-2">
                <button class="btn ${actionButtonClass}" id="memberPieceInfoActionBtn" type="button">${actionButtonLabel}</button>
                <button class="btn btn-danger" id="memberPieceInfoDeleteBtn" type="button" ${existing && isEditing ? '' : 'disabled'}>削除</button>
            </div>
        </section>
    `;

    $('pieceInfoBackBtn')?.addEventListener('click', () => {
        appState.selectedPieceInfoContext = null;
        appState.pieceInfoEditing = false;
        renderPieceInfoView();
    });

    $('memberPieceInfoActionBtn')?.addEventListener('click', (event) => withButtonStatus(event.currentTarget, isEditing ? '保存中...' : '編集中...', async () => {
        if (!appState.pieceInfoEditing) {
            appState.pieceInfoEditing = true;
            renderPieceInfoView();
            return;
        }
        const description = String($('memberPieceInfoDescription')?.value || '').trim();
        if (!description) {
            showAlert('楽曲情報を入力してください', 'warning');
            return;
        }
        const payload = {
            performance_id: performanceId,
            piece: existing?.piece || piece,
            description
        };
        if (existing?.id) {
            await request(`/api/extra/piece_infos/${encodeURIComponent(existing.id)}`, jsonOptions('PUT', payload));
        } else {
            await saveExtra('piece_infos', payload);
        }
        appState.pieceInfoEditing = false;
        await loadExtraData();
        showAlert('楽曲情報を保存しました', 'success');
        renderPieceInfoView();
    }));

    $('memberPieceInfoDeleteBtn')?.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', async () => {
        if (!existing?.id) {
            showAlert('削除対象の楽曲情報がありません', 'warning');
            return;
        }
        if (!confirmDelete()) return;
        await request(`/api/extra/piece_infos/${encodeURIComponent(existing.id)}`, { method: 'DELETE' });
        appState.pieceInfoEditing = false;
        await loadExtraData();
        showAlert('楽曲情報を削除しました', 'success');
        renderPieceInfoView();
    }));
}

function renderPracticeInstructionView() {
    const container = $('memberPracticeInstructionInfo');
    if (!container) return;

    const upcomingPerformances = [...(appState.performances || [])]
        .filter((perf) => perf.date && perf.date >= today())
        .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')) || String(a.title || '').localeCompare(String(b.title || ''), 'ja'));

    const rows = pieceScopedRows(upcomingPerformances, appState.practiceInstructions);

    if (!rows.length) {
        appState.selectedPracticeInstructionContext = null;
        appState.practiceInstructionEditing = false;
        container.innerHTML = '<p class="text-muted mb-0">未開催の演奏会はありません</p>';
        return;
    }

    const hasPiece = (performanceId, piece) => rows.some((row) =>
        row.performanceId === String(performanceId || '')
        && row.pieces.some((candidate) => performancePieceLookupLabels(candidate).includes(String(piece || '').trim()))
    );
    const selectedContext = appState.selectedPracticeInstructionContext;
    if (!selectedContext || !hasPiece(selectedContext.performanceId, selectedContext.piece)) {
        appState.selectedPracticeInstructionContext = null;
        appState.practiceInstructionEditing = false;
    }

    if (!appState.selectedPracticeInstructionContext) {
        container.innerHTML = `
            ${rows.map((row) => {
                const heading = `${formatDateWithWeekday(row.date, row.date)} ${row.title}`.trim();
                if (!row.pieces.length) {
                    return `
                        <section class="mb-3">
                            <h6 class="mb-2">${escapeHtml(heading)}</h6>
                            <p class="text-muted small mb-0">曲がまだ登録されていません</p>
                        </section>
                    `;
                }
                return `
                    <section class="mb-3">
                        <h6 class="mb-2">${escapeHtml(heading)}</h6>
                        <div class="list-group">
                            ${row.pieces.map((piece) => {
                                const pieceLabel = performancePieceFormalLabel(piece);
                                const existing = findPieceScopedItem(appState.practiceInstructions, row.performanceId, piece);
                                return `
                                    <button class="list-group-item list-group-item-action d-flex justify-content-between align-items-center gap-2 text-start" type="button" data-practice-performance-id="${escapeHtml(row.performanceId)}" data-practice-piece="${escapeHtml(encodeURIComponent(pieceLabel))}">
                                        <span>${escapeHtml(pieceLabel)}</span>
                                        ${existing && String(existing.practice_notes || '').trim() ? '<span class="badge text-bg-success">指示あり</span>' : ''}
                                    </button>
                                `;
                            }).join('')}
                        </div>
                    </section>
                `;
            }).join('')}
        `;

        container.querySelectorAll('[data-practice-performance-id][data-practice-piece]').forEach((button) => {
            button.addEventListener('click', () => {
                const performanceId = button.dataset.practicePerformanceId || '';
                const piece = decodeURIComponent(button.dataset.practicePiece || '');
                appState.selectedPracticeInstructionContext = { performanceId, piece };
                appState.practiceInstructionEditing = false;
                renderPracticeInstructionView();
            });
        });
        return;
    }

    const performanceId = String(appState.selectedPracticeInstructionContext.performanceId || '');
    const piece = String(appState.selectedPracticeInstructionContext.piece || '');
    const performance = appState.performances.find((perf) => String(perf.id || '') === performanceId);
    const performancePiece = normalizePerformancePieces(performance?.pieces || []).find((candidate) => performancePieceLookupLabels(candidate).includes(piece)) || piece;
    const existing = findPieceScopedItem(appState.practiceInstructions, performanceId, performancePiece);
    const initialNotes = String(existing?.practice_notes || '');
    const isEditing = Boolean(appState.practiceInstructionEditing);
    const actionButtonClass = isEditing ? 'btn-success' : 'btn-outline-primary';
    const actionButtonLabel = isEditing ? '保存' : '編集';

    container.innerHTML = `
        <section class="info-block mb-3">
            <button class="btn btn-sm btn-outline-secondary mb-3" id="practiceInstructionBackBtn" type="button">曲一覧に戻る</button>
            <h5 class="mb-1">${escapeHtml(performance?.title || '演奏会未設定')}</h5>
            <div class="small text-muted mb-2">${escapeHtml(formatDateWithWeekday(performance?.date || '', '開催日未設定'))}</div>
            <h6 class="mb-0">${escapeHtml(piece)}</h6>
        </section>
        <section class="info-block">
            <div class="mb-3">
                <label class="form-label" for="memberPracticeInstructionNotes">練習指示内容</label>
                <textarea class="form-control" id="memberPracticeInstructionNotes" rows="8" ${isEditing ? '' : 'readonly'}>${escapeHtml(initialNotes)}</textarea>
                <div class="form-text">URLを記載するとリンクとして表示されます。</div>
            </div>
            <div class="d-flex flex-wrap gap-2">
                <button class="btn ${actionButtonClass}" id="memberPracticeInstructionActionBtn" type="button">${actionButtonLabel}</button>
                <button class="btn btn-danger" id="memberPracticeInstructionDeleteBtn" type="button" ${existing && isEditing ? '' : 'disabled'}>削除</button>
            </div>
        </section>
    `;

    $('practiceInstructionBackBtn')?.addEventListener('click', () => {
        appState.selectedPracticeInstructionContext = null;
        appState.practiceInstructionEditing = false;
        renderPracticeInstructionView();
    });

    $('memberPracticeInstructionActionBtn')?.addEventListener('click', (event) => withButtonStatus(event.currentTarget, isEditing ? '保存中...' : '編集中...', async () => {
        if (!appState.practiceInstructionEditing) {
            appState.practiceInstructionEditing = true;
            renderPracticeInstructionView();
            return;
        }
        const notes = String($('memberPracticeInstructionNotes')?.value || '').trim();
        if (!notes) {
            showAlert('練習指示内容を入力してください', 'warning');
            return;
        }
        const payload = {
            performance_id: performanceId,
            piece: existing?.piece || piece,
            practice_notes: notes,
            performance_instruction: ''
        };
        if (existing?.id) {
            await request(`/api/extra/practice_instructions/${encodeURIComponent(existing.id)}`, jsonOptions('PUT', payload));
        } else {
            await saveExtra('practice_instructions', payload);
        }
        appState.practiceInstructionEditing = false;
        await loadExtraData();
        showAlert('練習指示を保存しました', 'success');
        renderPracticeInstructionView();
    }));

    $('memberPracticeInstructionDeleteBtn')?.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', async () => {
        if (!existing?.id) {
            showAlert('削除対象の練習指示がありません', 'warning');
            return;
        }
        if (!confirmDelete()) return;
        await request(`/api/extra/practice_instructions/${encodeURIComponent(existing.id)}`, { method: 'DELETE' });
        appState.practiceInstructionEditing = false;
        await loadExtraData();
        showAlert('練習指示を削除しました', 'success');
        renderPracticeInstructionView();
    }));
}

function desiredPieceCurrentVoterKey() {
    return String(appState.currentUserMemberId || currentUserMemberName() || '');
}

function desiredPieceVotes(item) {
    return Array.isArray(item.votes) ? item.votes : [];
}

function desiredPieceHasVoted(item) {
    const key = desiredPieceCurrentVoterKey();
    const name = currentUserMemberName();
    return desiredPieceVotes(item).some((vote) => String(vote.member_id || vote.name || vote) === key || (name && String(vote.name || vote) === name));
}

function desiredPieceIsOwner(item) {
    const memberId = String(appState.currentUserMemberId || '');
    const name = currentUserMemberName();
    return (memberId && String(item.member_id || '') === memberId) || (name && String(item.registered_by || item.name || '') === name);
}

function clearDesiredPieceForm() {
    ['desiredPieceId', 'desiredPieceTitle', 'desiredPieceComposer', 'desiredPieceDuration', 'desiredPieceFormation', 'desiredPieceNotes'].forEach((id) => { if ($(id)) $(id).value = ''; });
    if ($('desiredPieceGenre')) $('desiredPieceGenre').value = 'クラシック';
}

function fillDesiredPieceForm(id) {
    const item = appState.desiredPieces.find((piece) => String(piece.id || '') === String(id));
    if (!item) return;
    $('desiredPieceId').value = item.id || '';
    $('desiredPieceTitle').value = item.title || item.piece || '';
    $('desiredPieceComposer').value = item.composer || '';
    $('desiredPieceDuration').value = item.duration || '';
    $('desiredPieceGenre').value = item.genre || 'クラシック';
    $('desiredPieceFormation').value = item.formation || '';
    $('desiredPieceNotes').value = item.notes || '';
    $('desiredPieceTitle').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// 演奏希望曲は「登録」と「投票」が混在するため、
// 所有者だけ編集/削除、自分は 1 票だけ投票、というルールを UI 側でも明示する。

function renderDesiredPieceView() {
    const c = $('memberDesiredPieceInfo');
    if (!c) return;

    const currentMember = currentUserMember();
    const canSubmit = Boolean(currentMember || appState.currentUserName);
    const sorted = [...(appState.desiredPieces || [])].sort((a, b) => {
        const voteDelta = desiredPieceVotes(b).length - desiredPieceVotes(a).length;
        if (voteDelta !== 0) return voteDelta;
        return String(a.title || a.piece || '').localeCompare(String(b.title || b.piece || ''), 'ja');
    });

    c.innerHTML = `
        <section class="info-block mb-3">
            <h5 class="mb-3">演奏希望曲を登録</h5>
            <input type="hidden" id="desiredPieceId">
            <div class="row g-2">
                <div class="col-md-6"><input id="desiredPieceTitle" class="form-control" placeholder="曲名"></div>
                <div class="col-md-6"><input id="desiredPieceComposer" class="form-control" placeholder="作曲者"></div>
                <div class="col-md-4"><input id="desiredPieceDuration" class="form-control" placeholder="演奏時間（例: 7:30）"></div>
                <div class="col-md-4">
                    <select id="desiredPieceGenre" class="form-select">
                        <option value="クラシック">クラシック</option>
                        <option value="ポップス">ポップス</option>
                        <option value="映画音楽">映画音楽</option>
                        <option value="その他">その他</option>
                    </select>
                </div>
                <div class="col-md-4"><input id="desiredPieceFormation" class="form-control" placeholder="編成"></div>
                <div class="col-12"><textarea id="desiredPieceNotes" class="form-control" rows="2" placeholder="補足・理由"></textarea></div>
            </div>
            <div class="mt-3 d-flex gap-2">
                <button id="desiredPieceSaveBtn" class="btn btn-primary" type="button" ${canSubmit ? '' : 'disabled'}>保存</button>
                <button id="desiredPieceClearBtn" class="btn btn-outline-secondary" type="button">クリア</button>
            </div>
            ${canSubmit ? '' : '<p class="text-muted small mt-2 mb-0">投票・登録には団員としてログインしてください。</p>'}
        </section>
        <section>
            <h5 class="mb-3">希望曲一覧</h5>
            ${sorted.length ? `<div class="list-group">${sorted.map((item) => {
                const id = String(item.id || '');
                const title = item.title || item.piece || '（無題）';
                const votes = desiredPieceVotes(item).length;
                const voted = desiredPieceHasVoted(item);
                const owner = desiredPieceIsOwner(item);
                const canVote = canSubmit;
                return `
                    <article class="list-group-item">
                        <div class="d-flex justify-content-between align-items-start gap-3">
                            <div class="flex-grow-1">
                                <h6 class="mb-1">${escapeHtml(title)}</h6>
                                <div class="small text-muted mb-1">${escapeHtml(item.composer || '作曲者未設定')} / ${escapeHtml(item.genre || 'ジャンル未設定')} / ${escapeHtml(item.duration || '時間未設定')}</div>
                                ${item.formation ? `<div class="small text-muted mb-1">編成: ${escapeHtml(item.formation)}</div>` : ''}
                                ${item.notes ? `<div class="small">${escapeHtml(item.notes)}</div>` : ''}
                                <div class="small text-muted mt-1">登録者: ${escapeHtml(item.registered_by || item.name || '未設定')}</div>
                            </div>
                            <span class="badge text-bg-secondary">${votes} 票</span>
                        </div>
                        <div class="mt-2 d-flex gap-2 flex-wrap">
                            <button class="btn btn-sm ${voted ? 'btn-success' : 'btn-outline-success'} desired-piece-vote-btn" type="button" data-desired-piece-id="${escapeHtml(id)}" ${canVote ? '' : 'disabled'}>${voted ? '投票済み' : '投票する'}</button>
                            ${owner ? `<button class="btn btn-sm btn-outline-primary desired-piece-edit-btn" type="button" data-desired-piece-id="${escapeHtml(id)}">編集</button><button class="btn btn-sm btn-outline-danger desired-piece-delete-btn" type="button" data-desired-piece-id="${escapeHtml(id)}">削除</button>` : ''}
                        </div>
                    </article>
                `;
            }).join('')}</div>` : '<p class="text-muted mb-0">演奏希望曲はまだありません</p>'}
        </section>
    `;

    $('desiredPieceSaveBtn')?.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '保存中...', () => saveDesiredPiece()));
    $('desiredPieceClearBtn')?.addEventListener('click', clearDesiredPieceForm);
    c.querySelectorAll('.desired-piece-vote-btn').forEach((button) => button.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '投票中...', () => toggleDesiredPieceVote(button.dataset.desiredPieceId || ''))));
    c.querySelectorAll('.desired-piece-edit-btn').forEach((button) => button.addEventListener('click', () => fillDesiredPieceForm(button.dataset.desiredPieceId || '')));
    c.querySelectorAll('.desired-piece-delete-btn').forEach((button) => button.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', () => deleteDesiredPiece(button.dataset.desiredPieceId || ''))));
}

function renderPaymentFeeSettings() {
    const orgMembershipFee = $('orgMembershipFee');
    const perfFeeSettings = $('performanceFeeSettings');
    if (!orgMembershipFee || !perfFeeSettings) return;
    
    // 団費設定の読み込み
    const org = currentOrgSetting();
    const membershipFee = org.membership_fee_amount || 0;
    orgMembershipFee.value = membershipFee > 0 ? String(membershipFee) : '';
    
    // 演奏会費設定の表示
    perfFeeSettings.innerHTML = appState.performances.length
        ? `<div class="list-group">${appState.performances.map((perf) => `
            <div class="list-group-item">
                <div class="row g-3 align-items-end">
                    <div class="col-md-6">
                        <strong>${escapeHtml(perf.title)}</strong>
                        <div class="small text-muted">${escapeHtml(formatDateWithWeekday(perf.date))}</div>
                    </div>
                    <div class="col-md-4">
                        <label class="form-label">演奏会費（円）</label>
                        <input type="number" min="0" step="1" class="form-control performance-fee-amount" data-performance-id="${escapeHtml(String(perf.id))}" value="${Number(perf.performance_fee_amount || 0) > 0 ? perf.performance_fee_amount : ''}" placeholder="例: 5000">
                    </div>
                    <div class="col-md-2">
                        <button class="btn btn-sm btn-outline-primary save-perf-fee-btn" type="button" data-performance-id="${escapeHtml(String(perf.id))}">保存</button>
                    </div>
                </div>
            </div>
        `).join('')}</div>`
        : '<p class="text-muted mb-0">演奏会情報はまだありません</p>';
    
    // イベントリスナー設定
    $('saveOrgMembershipFeeBtn')?.addEventListener('click', saveOrgMembershipFee);
    perfFeeSettings.querySelectorAll('.save-perf-fee-btn').forEach((btn) => {
        btn.addEventListener('click', () => savePerformanceFee(btn.dataset.performanceId));
    });
}

// saveOrgMembershipFee moved to feature module.

async function savePerformanceFee(performanceId) {
    const input = Array.from(document.querySelectorAll('#performanceFeeSettings input[data-performance-id]'))
        .find((element) => String(element.dataset.performanceId || '') === String(performanceId));
    const amount = Number(input?.value || 0);
    const perf = appState.performances.find((p) => String(p.id || '') === String(performanceId));
    if (!perf) {
        showAlert('演奏会が見つかりません', 'warning');
        return;
    }
    const payload = {
        title: perf.title || '',
        date: perf.date || today(),
        open_time: perf.open_time || '18:00',
        start_time: perf.start_time || '19:00',
        venue: perf.venue || '',
        conductor: perf.conductor || '',
        flyer_image: perf.flyer_image || '',
        performance_fee_amount: amount,
        pieces: normalizePerformancePieces(perf.pieces || [])
    };
    await request(`/api/performances/${encodeURIComponent(perf.id)}`, jsonOptions('PUT', payload));
    await loadEssentialData();
    showAlert('演奏会費を保存しました', 'success');
    renderPaymentAdmin();
}

async function saveDesiredPiece() {
    const title = $('desiredPieceTitle')?.value.trim() || '';
    if (!title) { showAlert('曲名を入力してください', 'warning'); return; }
    const member = currentUserMember();
    const id = $('desiredPieceId')?.value || '';
    const current = appState.desiredPieces.find((item) => String(item.id || '') === String(id));
    const payload = {
        title,
        composer: $('desiredPieceComposer')?.value.trim() || '',
        duration: $('desiredPieceDuration')?.value.trim() || '',
        genre: $('desiredPieceGenre')?.value || 'クラシック',
        formation: $('desiredPieceFormation')?.value.trim() || '',
        notes: $('desiredPieceNotes')?.value.trim() || '',
        member_id: current?.member_id || member?.id || appState.currentUserMemberId || '',
        registered_by: current?.registered_by || currentUserMemberName(),
        votes: desiredPieceVotes(current || [])
    };
    if (id) await request(`/api/extra/desired_pieces/${encodeURIComponent(id)}`, jsonOptions('PUT', payload));
    else await saveExtra('desired_pieces', payload);
    clearDesiredPieceForm();
    await loadExtraData();
    showAlert('演奏希望曲を保存しました', 'success');
}

async function toggleDesiredPieceVote(id) {
    const item = appState.desiredPieces.find((piece) => String(piece.id || '') === String(id));
    if (!item) return;
    const key = desiredPieceCurrentVoterKey();
    const name = currentUserMemberName();
    let votes = desiredPieceVotes(item).filter((vote) => String(vote.member_id || vote.name || vote) !== key && (!name || String(vote.name || vote) !== name));
    if (!desiredPieceHasVoted(item)) {
        votes.push({ member_id: appState.currentUserMemberId || '', name });
    }
    await request(`/api/extra/desired_pieces/${encodeURIComponent(id)}`, jsonOptions('PUT', { ...item, votes }));
    await loadExtraData();
}

async function deleteDesiredPiece(id) {
    if (!id || !confirmDelete()) return;
    await request(`/api/extra/desired_pieces/${encodeURIComponent(id)}`, { method: 'DELETE' });
    clearDesiredPieceForm();
    await loadExtraData();
    showAlert('演奏希望曲を削除しました', 'success');
}

function promotionIsOwner(item) {
    const currentId = String(appState.currentUserMemberId || '');
    const currentName = currentUserMemberName();
    return (currentId && String(item?.member_id || '') === currentId)
        || (currentName && String(item?.registered_by || '') === currentName);
}

function fillPromotionForm(id) {
    const item = appState.promotions.find((promotion) => String(promotion.id || '') === String(id));
    if (!item) return;
    if ($('promotionId')) $('promotionId').value = item.id || '';
    if ($('promotionTitle')) $('promotionTitle').value = item.title || '';
    if ($('promotionSummary')) $('promotionSummary').value = item.summary || item.description || '';
    if ($('promotionImageFile')) $('promotionImageFile').value = '';
    if ($('promotionImagePreview')) $('promotionImagePreview').innerHTML = item.image_url ? `<img src="${escapeHtml(item.image_url)}" class="img-fluid rounded border" alt="宣伝画像">` : '';
}

function clearPromotionForm() {
    if ($('promotionId')) $('promotionId').value = '';
    if ($('promotionTitle')) $('promotionTitle').value = '';
    if ($('promotionSummary')) $('promotionSummary').value = '';
    if ($('promotionImageFile')) $('promotionImageFile').value = '';
    if ($('promotionImagePreview')) $('promotionImagePreview').innerHTML = '';
}

async function previewPromotionImage(event) {
    const file = event?.target?.files?.[0];
    if (!file || !$('promotionImagePreview')) return;
    const dataUrl = await fileToDataUrl(file);
    $('promotionImagePreview').innerHTML = `<img src="${escapeHtml(dataUrl)}" class="img-fluid rounded border" alt="宣伝画像プレビュー">`;
}

// 宣伝機能は画像付き投稿のため、一覧描画時は本文よりも
// 投稿者・登録日・所有権判定が追いやすい構造を優先している。

function renderPromotionView() {
    const c = $('memberPromotionInfo');
    if (!c) return;
    const items = [...(appState.promotions || [])].sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    c.innerHTML = `
        <div class="info-block">
            <input type="hidden" id="promotionId">
            <div class="row g-3">
                <div class="col-md-6"><label class="form-label">タイトル</label><input class="form-control" id="promotionTitle"></div>
                <div class="col-12"><label class="form-label">概要</label><textarea class="form-control" id="promotionSummary" rows="3"></textarea></div>
                <div class="col-md-6"><label class="form-label">画像登録</label><input class="form-control" id="promotionImageFile" type="file" accept="image/*"></div>
                <div class="col-md-6"><div id="promotionImagePreview"></div></div>
                <div class="col-12 d-flex flex-wrap gap-2">
                    <button class="btn btn-success" id="promotionSaveBtn" type="button">登録</button>
                    <button class="btn btn-outline-secondary" id="promotionClearBtn" type="button">クリア</button>
                </div>
            </div>
        </div>
        <div class="mt-3">${items.length ? items.map((item) => {
            const own = promotionIsOwner(item);
            const registeredAt = item.created_at || item.updated_at || '';
            return `<article class="info-block desired-piece-card">
                <div class="d-flex flex-wrap justify-content-between gap-3 align-items-start">
                    <div class="flex-grow-1">
                        <h5 class="mb-1">${escapeHtml(item.title || '')}</h5>
                        ${item.summary ? `<div class="small multiline-text mt-2">${escapeHtml(item.summary)}</div>` : ''}
                        <div class="small text-muted mt-2">登録者: ${escapeHtml(item.registered_by || '未登録')}</div>
                        <div class="small text-muted">登録日: ${escapeHtml(registeredAt ? formatDateTimeLabel(registeredAt) : '未登録')}</div>
                    </div>
                    ${item.image_url ? `<div style="max-width: 240px;"><img src="${escapeHtml(item.image_url)}" class="img-fluid rounded border" alt="宣伝画像"></div>` : ''}
                </div>
                ${own ? `<div class="d-flex flex-wrap gap-2 mt-3"><button class="btn btn-sm btn-outline-primary promotion-edit-btn" type="button" data-promotion-id="${escapeHtml(String(item.id || ''))}">編集</button><button class="btn btn-sm btn-outline-danger promotion-delete-btn" type="button" data-promotion-id="${escapeHtml(String(item.id || ''))}">削除</button></div>` : ''}
            </article>`;
        }).join('') : '<p class="text-muted mb-0">宣伝はまだ登録されていません</p>'}</div>
    `;
    $('promotionSaveBtn')?.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '保存中...', () => savePromotion()));
    $('promotionClearBtn')?.addEventListener('click', clearPromotionForm);
    $('promotionImageFile')?.addEventListener('change', previewPromotionImage);
    c.querySelectorAll('.promotion-edit-btn').forEach((button) => button.addEventListener('click', () => fillPromotionForm(button.dataset.promotionId || '')));
    c.querySelectorAll('.promotion-delete-btn').forEach((button) => button.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', () => deletePromotion(button.dataset.promotionId || ''))));
}

async function savePromotion() {
    const title = $('promotionTitle')?.value.trim() || '';
    if (!title) {
        showAlert('タイトルを入力してください', 'warning');
        return;
    }
    const id = $('promotionId')?.value || '';
    const current = appState.promotions.find((item) => String(item.id || '') === String(id));
    const imageFile = $('promotionImageFile')?.files?.[0];
    const imageUrl = imageFile ? await fileToDataUrl(imageFile) : (current?.image_url || '');
    const payload = {
        title,
        summary: $('promotionSummary')?.value.trim() || '',
        image_url: imageUrl,
        member_id: current?.member_id || appState.currentUserMemberId || '',
        registered_by: current?.registered_by || currentUserMemberName()
    };
    if (id) await request(`/api/extra/promotions/${encodeURIComponent(id)}`, jsonOptions('PUT', payload));
    else await saveExtra('promotions', payload);
    clearPromotionForm();
    await loadExtraData();
    showAlert('宣伝を保存しました', 'success');
}

async function deletePromotion(id) {
    if (!id || !confirmDelete()) return;
    await request(`/api/extra/promotions/${encodeURIComponent(id)}`, { method: 'DELETE' });
    clearPromotionForm();
    await loadExtraData();
    showAlert('宣伝を削除しました', 'success');
}

// function renderAlbumView() moved to modules/albums.js.
