// Desired piece / fee / promotion render blocks split from render.js.
// Keep global names for legacy non-module loading.

var appState = (typeof window.getAppState === 'function') ? window.getAppState() : window.portalRuntimeContext.appState;
var $ = window.portalRuntimeContext.getById;

function _desiredPieceIsClassicGenre(item) {
    return String(item?.genre || '') === 'クラシック';
}

function renderDesiredPieceView() {
    const c = $('memberDesiredPieceInfo');
    if (!c) return;
    const currentMember = currentUserMember();
    const canSubmit = Boolean(currentMember || appState.currentUserName);
    const filters = appState.desiredPieceFilters || { genre: '' };
    const sorted = [...(appState.desiredPieces || [])]
        .sort((a, b) => {
            const voteDelta = desiredPieceVotes(b).length - desiredPieceVotes(a).length;
            if (voteDelta !== 0) return voteDelta;
            return String(a.title || a.piece || '').localeCompare(String(b.title || b.piece || ''), 'ja');
        })
        .filter((item) => {
            if (!filters.genre) return true;
            if (filters.genre === 'classic') return _desiredPieceIsClassicGenre(item);
            return !_desiredPieceIsClassicGenre(item);
        });
    c.innerHTML = `
        <section class="info-block mb-3"><h5 class="mb-3">演奏希望曲を登録</h5><input type="hidden" id="desiredPieceId"><div class="row g-2"><div class="col-md-6"><input id="desiredPieceTitle" class="form-control" placeholder="曲名"></div><div class="col-md-6"><input id="desiredPieceComposer" class="form-control" placeholder="作曲者"></div><div class="col-md-4"><input id="desiredPieceDuration" class="form-control" placeholder="演奏時間（例: 7:30）"></div><div class="col-md-4"><select id="desiredPieceGenre" class="form-select"><option value="クラシック">クラシック</option><option value="ポップス">ポップス</option><option value="映画音楽">映画音楽</option><option value="その他">その他</option></select></div><div class="col-md-4"><input id="desiredPieceFormation" class="form-control" placeholder="編成"></div><div class="col-md-6"><label class="form-label" for="desiredPieceReferenceAudioUrl">参考音源(YouTube)</label><input id="desiredPieceReferenceAudioUrl" class="form-control" placeholder="YouTubeのURL"></div><div class="col-md-6"><label class="form-label" for="desiredPieceReferenceScoreFile">参考スコア</label><input id="desiredPieceReferenceScoreFile" class="form-control" type="file" accept="application/pdf,.pdf"><div class="form-text" id="desiredPieceReferenceScoreStatus"></div></div><div class="col-12"><textarea id="desiredPieceNotes" class="form-control" rows="2" placeholder="補足・理由"></textarea></div></div><div class="mt-3 d-flex gap-2"><button id="desiredPieceSaveBtn" class="btn btn-primary" type="button" ${canSubmit ? '' : 'disabled'}>保存</button><button id="desiredPieceClearBtn" class="btn btn-outline-secondary" type="button">クリア</button></div>${canSubmit ? '' : '<p class="text-muted small mt-2 mb-0">投票・登録には団員としてログインしてください。</p>'}</section>
        <section class="mb-3"><div class="row g-2 align-items-end"><div class="col-md-4"><label class="form-label" for="desiredPieceGenreFilter">ジャンルフィルター</label><select id="desiredPieceGenreFilter" class="form-select"><option value="" ${filters.genre ? '' : 'selected'}>全件</option><option value="classic" ${filters.genre === 'classic' ? 'selected' : ''}>クラシック</option><option value="other" ${filters.genre === 'other' ? 'selected' : ''}>クラシック以外</option></select></div></div></section>
        <section><h5 class="mb-3">希望曲一覧</h5>${sorted.length ? `<div class="list-group">${sorted.map((item) => { const id = String(item.id || ''); const title = item.title || item.piece || '（無題）'; const votes = desiredPieceVotes(item).length; const voted = desiredPieceHasVoted(item); const owner = desiredPieceIsOwner(item); const referenceAudioUrl = String(item.reference_audio_url || '').trim(); const referenceScoreUrl = String(item.reference_score_url || '').trim(); return `<article class="list-group-item"><div class="d-flex justify-content-between align-items-start gap-3"><div class="flex-grow-1"><h6 class="mb-1">${escapeHtml(title)}</h6><div class="small text-muted mb-1">${escapeHtml(item.composer || '作曲者未設定')} / ${escapeHtml(item.genre || 'ジャンル未設定')} / ${escapeHtml(item.duration || '時間未設定')}</div>${referenceAudioUrl || referenceScoreUrl ? `<div class="d-flex flex-wrap gap-2 mt-2 mb-2">${referenceAudioUrl ? `<a class="btn btn-sm btn-outline-primary" href="${escapeHtml(referenceAudioUrl)}" target="_blank" rel="noopener noreferrer">参考音源</a>` : ''}${referenceScoreUrl ? `<button class="btn btn-sm btn-outline-primary desired-piece-reference-score-btn" type="button" data-desired-piece-id="${escapeHtml(id)}">参考スコア</button>` : ''}</div>` : ''}${item.formation ? `<div class="small text-muted mb-1">編成: ${escapeHtml(item.formation)}</div>` : ''}${item.notes ? `<div class="small">${escapeHtml(item.notes)}</div>` : ''}</div><span class="badge text-bg-secondary">${votes} 票</span></div><div class="mt-2 d-flex gap-2 flex-wrap"><button class="btn btn-sm ${voted ? 'btn-success' : 'btn-outline-success'} desired-piece-vote-btn" type="button" data-desired-piece-id="${escapeHtml(id)}" ${canSubmit ? '' : 'disabled'}>${voted ? '投票済み' : '投票する'}</button>${owner ? `<button class="btn btn-sm btn-outline-primary desired-piece-edit-btn" type="button" data-desired-piece-id="${escapeHtml(id)}">編集</button><button class="btn btn-sm btn-outline-danger desired-piece-delete-btn" type="button" data-desired-piece-id="${escapeHtml(id)}">削除</button>` : ''}</div></article>`; }).join('')}</div>` : '<p class="text-muted mb-0">演奏希望曲はまだありません</p>'}</section>
    `;
    $('desiredPieceSaveBtn')?.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '保存中...', () => saveDesiredPiece()));
    $('desiredPieceClearBtn')?.addEventListener('click', clearDesiredPieceForm);
    $('desiredPieceGenreFilter')?.addEventListener('change', (event) => {
        appState.desiredPieceFilters = { ...(appState.desiredPieceFilters || {}), genre: event.currentTarget.value || '' };
        renderDesiredPieceView();
    });
    c.querySelectorAll('.desired-piece-vote-btn').forEach((button) => button.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '投票中...', () => toggleDesiredPieceVote(button.dataset.desiredPieceId || ''))));
    c.querySelectorAll('.desired-piece-edit-btn').forEach((button) => button.addEventListener('click', () => fillDesiredPieceForm(button.dataset.desiredPieceId || '')));
    c.querySelectorAll('.desired-piece-delete-btn').forEach((button) => button.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', () => deleteDesiredPiece(button.dataset.desiredPieceId || ''))));
    c.querySelectorAll('.desired-piece-reference-score-btn').forEach((button) => button.addEventListener('click', () => showDesiredPieceReferenceScore(button.dataset.desiredPieceId || '')));
}

function renderPaymentFeeSettings() {
    const orgMembershipFee = $('orgMembershipFee');
    const perfFeeSettings = $('performanceFeeSettings');
    if (!orgMembershipFee || !perfFeeSettings) return;
    const org = currentOrgSetting();
    orgMembershipFee.value = integerAmountInputValue(org.membership_fee_amount);
    perfFeeSettings.innerHTML = appState.performances.length ? `<div class="list-group">${appState.performances.map((perf) => `<div class="list-group-item"><div class="row g-3 align-items-end"><div class="col-md-6"><strong>${escapeHtml(perf.title)}</strong><div class="small text-muted">${escapeHtml(formatDateWithWeekday(perf.date))}</div></div><div class="col-md-4"><label class="form-label">演奏会費（円）</label><input type="number" min="0" step="1" class="form-control performance-fee-amount" data-performance-id="${escapeHtml(String(perf.id))}" value="${integerAmountInputValue(perf.performance_fee_amount)}" placeholder="例: 5000"></div><div class="col-md-2"><button class="btn btn-sm btn-outline-primary save-perf-fee-btn" type="button" data-performance-id="${escapeHtml(String(perf.id))}">保存</button></div></div></div>`).join('')}</div>` : '<p class="text-muted mb-0">演奏会情報はまだありません</p>';
    $('saveOrgMembershipFeeBtn')?.addEventListener('click', saveOrgMembershipFee);
    perfFeeSettings.querySelectorAll('.save-perf-fee-btn').forEach((btn) => {
        btn.addEventListener('click', () => savePerformanceFee(btn.dataset.performanceId));
    });
}

function renderPromotionView() {
    const c = $('memberPromotionInfo');
    if (!c) return;
    const items = [...(appState.promotions || [])].sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    c.innerHTML = `
        <div class="info-block"><input type="hidden" id="promotionId"><div class="row g-3"><div class="col-md-6"><label class="form-label">タイトル</label><input class="form-control" id="promotionTitle"></div><div class="col-12"><label class="form-label">概要</label><textarea class="form-control" id="promotionSummary" rows="3"></textarea></div><div class="col-md-6"><label class="form-label">画像登録</label><input class="form-control" id="promotionImageFile" type="file" accept="image/*"></div><div class="col-md-6"><div id="promotionImagePreview"></div></div><div class="col-12 d-flex flex-wrap gap-2"><button class="btn btn-success" id="promotionSaveBtn" type="button">登録</button><button class="btn btn-outline-secondary" id="promotionClearBtn" type="button">クリア</button></div></div></div>
        <div class="mt-3">${items.length ? items.map((item) => { const own = promotionIsOwner(item); const registeredAt = item.created_at || item.updated_at || ''; return `<article class="info-block desired-piece-card"><div class="d-flex flex-wrap justify-content-between gap-3 align-items-start"><div class="flex-grow-1"><h5 class="mb-1">${escapeHtml(item.title || '')}</h5>${item.summary ? `<div class="small multiline-text mt-2">${escapeHtml(item.summary)}</div>` : ''}<div class="small text-muted mt-2">登録者: ${escapeHtml(item.registered_by || '未登録')}</div><div class="small text-muted">登録日: ${escapeHtml(registeredAt ? formatDateTimeLabel(registeredAt) : '未登録')}</div></div>${item.image_url ? `<div style="max-width: 240px;"><img src="${escapeHtml(item.image_url)}" class="img-fluid rounded border" alt="宣伝画像"></div>` : ''}</div>${own ? `<div class="d-flex flex-wrap gap-2 mt-3"><button class="btn btn-sm btn-outline-primary promotion-edit-btn" type="button" data-promotion-id="${escapeHtml(String(item.id || ''))}">編集</button><button class="btn btn-sm btn-outline-danger promotion-delete-btn" type="button" data-promotion-id="${escapeHtml(String(item.id || ''))}">削除</button></div>` : ''}</article>`; }).join('') : '<p class="text-muted mb-0">宣伝はまだ登録されていません</p>'}</div>
    `;
    $('promotionSaveBtn')?.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '保存中...', () => savePromotion()));
    $('promotionClearBtn')?.addEventListener('click', clearPromotionForm);
    $('promotionImageFile')?.addEventListener('change', previewPromotionImage);
    c.querySelectorAll('.promotion-edit-btn').forEach((button) => button.addEventListener('click', () => fillPromotionForm(button.dataset.promotionId || '')));
    c.querySelectorAll('.promotion-delete-btn').forEach((button) => button.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', () => deletePromotion(button.dataset.promotionId || ''))));
}
