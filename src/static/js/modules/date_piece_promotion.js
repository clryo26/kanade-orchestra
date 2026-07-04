// Frontend split: extracted from main.js.
// Loaded after main.js; functions intentionally remain global for legacy handlers.

var appState = window.portalRuntimeContext.appState;
var $ = window.portalRuntimeContext.getById;
// Date adjustment helper functions were extracted to
// modules/date_piece_promotion/helpers.js for Phase4 split.

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
        candidateRows.innerHTML = dateAdjustmentCandidateRowHtml({ date: window.portalRuntimeContext.today() }, false);
    }
    if ($('dateAdjustmentDeadline')) $('dateAdjustmentDeadline').value = window.portalRuntimeContext.today();

    bindDateAdjustmentCreateEvents();
    bindDateAdjustmentCandidateRows();

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

    bindDateAdjustmentDetailEvents({
        adjustment,
        candidates,
        detailView,
        listView,
        unansweredMembers,
        reminderMessage,
        respondentRowsHtml,
    });
}

// renderMemberEventView moved to feature module.

// renderMemberEventList moved to feature module.

// renderMemberEventDetail moved to feature module.

// uniqueEventResponses moved to feature module.

// renderGroupedEventResponses moved to feature module.

// Piece info / practice instruction / desired piece / promotion / payment-fee
// sections were split to modules/date_piece_promotion/render.js.

// Desired piece / promotion state helpers moved to modules/date_piece_promotion/state.js.

// Desired piece / promotion / fee render moved to modules/date_piece_promotion/render.js.

// saveOrgMembershipFee moved to feature module.

// Desired piece / promotion / fee API actions moved to modules/date_piece_promotion/api.js.

// function renderAlbumView() moved to modules/albums.js.
