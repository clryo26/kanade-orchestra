// Piece/practice render blocks split from render.js.
// Keep global names for legacy non-module loading.

var appState = (typeof window.getAppState === 'function') ? window.getAppState() : window.portalRuntimeContext.appState;
var $ = window.portalRuntimeContext.getById;

function renderPieceInfoView() {
    const container = $('memberPieceInfo');
    if (!container) return;
    const upcomingPerformances = [...(appState.performances || [])]
        .filter((perf) => perf.date && perf.date >= window.portalRuntimeContext.today())
        .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')) || String(a.title || '').localeCompare(String(b.title || ''), 'ja'));
    const rows = pieceScopedRows(upcomingPerformances, appState.pieceInfos);
    if (!rows.length) {
        appState.selectedPieceInfoContext = null;
        appState.pieceInfoEditing = false;
        container.innerHTML = '<p class="text-muted mb-0">未開催の演奏会はありません</p>';
        return;
    }
    const hasPiece = (performanceId, piece) => rows.some((row) => row.performanceId === String(performanceId || '') && row.pieces.some((candidate) => performancePieceLookupLabels(candidate).includes(String(piece || '').trim())));
    const selectedContext = appState.selectedPieceInfoContext;
    if (!selectedContext || !hasPiece(selectedContext.performanceId, selectedContext.piece)) {
        appState.selectedPieceInfoContext = null;
        appState.pieceInfoEditing = false;
    }
    if (!appState.selectedPieceInfoContext) {
        container.innerHTML = `
            <section class="info-block mb-3"><h5 class="mb-2">未開催演奏会の曲一覧</h5><p class="text-muted small mb-0">曲を選択すると、曲ごとの楽曲情報登録・編集画面に遷移します。<span class="badge text-bg-success ms-1">情報あり</span> が登録済みの目印です。</p></section>
            ${rows.map((row) => { const heading = `${formatDateWithWeekday(row.date, row.date)} ${row.title}`.trim(); if (!row.pieces.length) { return `<section class="mb-3"><h6 class="mb-2">${escapeHtml(heading)}</h6><p class="text-muted small mb-0">曲がまだ登録されていません</p></section>`; } return `<section class="mb-3"><h6 class="mb-2">${escapeHtml(heading)}</h6><div class="list-group">${row.pieces.map((piece) => { const pieceLabel = performancePieceFormalLabel(piece); const existing = findPieceScopedItem(appState.pieceInfos, row.performanceId, piece); const hasInfo = existing && String(existing.description || existing.notes || '').trim(); return `<button class="list-group-item list-group-item-action d-flex justify-content-between align-items-center gap-2 text-start" type="button" data-piece-info-performance-id="${escapeHtml(row.performanceId)}" data-piece-info-piece="${escapeHtml(encodeURIComponent(pieceLabel))}"><span>${escapeHtml(pieceLabel)}</span>${hasInfo ? '<span class="badge text-bg-success">情報あり</span>' : ''}</button>`; }).join('')}</div></section>`; }).join('')}
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
        <section class="info-block mb-3"><button class="btn btn-sm btn-outline-secondary mb-3" id="pieceInfoBackBtn" type="button">曲一覧に戻る</button><h5 class="mb-1">${escapeHtml(performance?.title || '演奏会未設定')}</h5><div class="small text-muted mb-2">${escapeHtml(formatDateWithWeekday(performance?.date || '', '開催日未設定'))}</div><h6 class="mb-0">${escapeHtml(piece)}</h6></section>
        <section class="info-block"><div class="mb-3"><label class="form-label" for="memberPieceInfoDescription">楽曲情報</label><textarea class="form-control" id="memberPieceInfoDescription" rows="8" ${isEditing ? '' : 'readonly'}>${escapeHtml(initialDescription)}</textarea><div class="form-text">URLを記載するとリンクとして表示されます。</div></div><div class="d-flex flex-wrap gap-2"><button class="btn ${actionButtonClass}" id="memberPieceInfoActionBtn" type="button">${actionButtonLabel}</button><button class="btn btn-danger" id="memberPieceInfoDeleteBtn" type="button" ${existing && isEditing ? '' : 'disabled'}>削除</button></div></section>
    `;
    $('pieceInfoBackBtn')?.addEventListener('click', () => { appState.selectedPieceInfoContext = null; appState.pieceInfoEditing = false; renderPieceInfoView(); });
    $('memberPieceInfoActionBtn')?.addEventListener('click', (event) => withButtonStatus(event.currentTarget, isEditing ? '保存中...' : '編集中...', async () => {
        if (!appState.pieceInfoEditing) { appState.pieceInfoEditing = true; renderPieceInfoView(); return; }
        const description = String($('memberPieceInfoDescription')?.value || '').trim();
        if (!description) { showAlert('楽曲情報を入力してください', 'warning'); return; }
        const payload = { performance_id: performanceId, piece: existing?.piece || piece, description };
        if (existing?.id) await request(`/api/extra/piece_infos/${encodeURIComponent(existing.id)}`, jsonOptions('PUT', payload));
        else await saveExtra('piece_infos', payload);
        appState.pieceInfoEditing = false;
        await loadExtraData();
        showAlert('楽曲情報を保存しました', 'success');
        renderPieceInfoView();
    }));
    $('memberPieceInfoDeleteBtn')?.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', async () => {
        if (!existing?.id) { showAlert('削除対象の楽曲情報がありません', 'warning'); return; }
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
        .filter((perf) => perf.date && perf.date >= window.portalRuntimeContext.today())
        .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')) || String(a.title || '').localeCompare(String(b.title || ''), 'ja'));
    const rows = pieceScopedRows(upcomingPerformances, appState.practiceInstructions);
    if (!rows.length) {
        appState.selectedPracticeInstructionContext = null;
        appState.practiceInstructionEditing = false;
        container.innerHTML = '<p class="text-muted mb-0">未開催の演奏会はありません</p>';
        return;
    }
    const hasPiece = (performanceId, piece) => rows.some((row) => row.performanceId === String(performanceId || '') && row.pieces.some((candidate) => performancePieceLookupLabels(candidate).includes(String(piece || '').trim())));
    const selectedContext = appState.selectedPracticeInstructionContext;
    if (!selectedContext || !hasPiece(selectedContext.performanceId, selectedContext.piece)) {
        appState.selectedPracticeInstructionContext = null;
        appState.practiceInstructionEditing = false;
    }
    if (!appState.selectedPracticeInstructionContext) {
        container.innerHTML = `${rows.map((row) => { const heading = `${formatDateWithWeekday(row.date, row.date)} ${row.title}`.trim(); if (!row.pieces.length) { return `<section class="mb-3"><h6 class="mb-2">${escapeHtml(heading)}</h6><p class="text-muted small mb-0">曲がまだ登録されていません</p></section>`; } return `<section class="mb-3"><h6 class="mb-2">${escapeHtml(heading)}</h6><div class="list-group">${row.pieces.map((piece) => { const pieceLabel = performancePieceFormalLabel(piece); const existing = findPieceScopedItem(appState.practiceInstructions, row.performanceId, piece); return `<button class="list-group-item list-group-item-action d-flex justify-content-between align-items-center gap-2 text-start" type="button" data-practice-performance-id="${escapeHtml(row.performanceId)}" data-practice-piece="${escapeHtml(encodeURIComponent(pieceLabel))}"><span>${escapeHtml(pieceLabel)}</span>${existing && String(existing.practice_notes || '').trim() ? '<span class="badge text-bg-success">指示あり</span>' : ''}</button>`; }).join('')}</div></section>`; }).join('')}`;
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
        <section class="info-block mb-3"><button class="btn btn-sm btn-outline-secondary mb-3" id="practiceInstructionBackBtn" type="button">曲一覧に戻る</button><h5 class="mb-1">${escapeHtml(performance?.title || '演奏会未設定')}</h5><div class="small text-muted mb-2">${escapeHtml(formatDateWithWeekday(performance?.date || '', '開催日未設定'))}</div><h6 class="mb-0">${escapeHtml(piece)}</h6></section>
        <section class="info-block"><div class="mb-3"><label class="form-label" for="memberPracticeInstructionNotes">練習指示内容</label><textarea class="form-control" id="memberPracticeInstructionNotes" rows="8" ${isEditing ? '' : 'readonly'}>${escapeHtml(initialNotes)}</textarea><div class="form-text">URLを記載するとリンクとして表示されます。</div></div><div class="d-flex flex-wrap gap-2"><button class="btn ${actionButtonClass}" id="memberPracticeInstructionActionBtn" type="button">${actionButtonLabel}</button><button class="btn btn-danger" id="memberPracticeInstructionDeleteBtn" type="button" ${existing && isEditing ? '' : 'disabled'}>削除</button></div></section>
    `;
    $('practiceInstructionBackBtn')?.addEventListener('click', () => { appState.selectedPracticeInstructionContext = null; appState.practiceInstructionEditing = false; renderPracticeInstructionView(); });
    $('memberPracticeInstructionActionBtn')?.addEventListener('click', (event) => withButtonStatus(event.currentTarget, isEditing ? '保存中...' : '編集中...', async () => {
        if (!appState.practiceInstructionEditing) { appState.practiceInstructionEditing = true; renderPracticeInstructionView(); return; }
        const notes = String($('memberPracticeInstructionNotes')?.value || '').trim();
        if (!notes) { showAlert('練習指示内容を入力してください', 'warning'); return; }
        const payload = { performance_id: performanceId, piece: existing?.piece || piece, practice_notes: notes, performance_instruction: '' };
        if (existing?.id) await request(`/api/extra/practice_instructions/${encodeURIComponent(existing.id)}`, jsonOptions('PUT', payload));
        else await saveExtra('practice_instructions', payload);
        appState.practiceInstructionEditing = false;
        await loadExtraData();
        showAlert('練習指示を保存しました', 'success');
        renderPracticeInstructionView();
    }));
    $('memberPracticeInstructionDeleteBtn')?.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', async () => {
        if (!existing?.id) { showAlert('削除対象の練習指示がありません', 'warning'); return; }
        if (!confirmDelete()) return;
        await request(`/api/extra/practice_instructions/${encodeURIComponent(existing.id)}`, { method: 'DELETE' });
        appState.practiceInstructionEditing = false;
        await loadExtraData();
        showAlert('練習指示を削除しました', 'success');
        renderPracticeInstructionView();
    }));
}