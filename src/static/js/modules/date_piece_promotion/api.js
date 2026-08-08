// Date/piece/promotion API actions split from modules/date_piece_promotion.js.
// Keep global names for legacy non-module loading.

var appState = (typeof window.getAppState === 'function') ? window.getAppState() : window.portalRuntimeContext.appState;
var $ = window.portalRuntimeContext.getById;

async function savePerformanceFee(performanceId) {
    const input = Array.from(document.querySelectorAll('#performanceFeeSettings input[data-performance-id]'))
        .find((element) => String(element.dataset.performanceId || '') === String(performanceId));
    const amount = integerAmountNumber(input?.value || 0);
    const perf = appState.performances.find((p) => String(p.id || '') === String(performanceId));
    if (!perf) {
        showAlert('演奏会が見つかりません', 'warning');
        return;
    }
    const payload = {
        title: perf.title || '',
        date: perf.date || window.portalRuntimeContext.today(),
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
    if (!title) {
        showAlert('曲名を入力してください', 'warning');
        return;
    }
    const member = currentUserMember();
    const id = $('desiredPieceId')?.value || '';
    const current = appState.desiredPieces.find((item) => String(item.id || '') === String(id));
    const referenceScoreFile = $('desiredPieceReferenceScoreFile')?.files?.[0];
    const payload = {
        title,
        composer: $('desiredPieceComposer')?.value.trim() || '',
        duration: $('desiredPieceDuration')?.value.trim() || '',
        genre: $('desiredPieceGenre')?.value || 'クラシック',
        formation: $('desiredPieceFormation')?.value.trim() || '',
        reference_audio_url: $('desiredPieceReferenceAudioUrl')?.value.trim() || '',
        reference_score_url: current?.reference_score_url || '',
        notes: $('desiredPieceNotes')?.value.trim() || '',
        member_id: current?.member_id || member?.id || appState.currentUserMemberId || '',
        registered_by: current?.registered_by || currentUserMemberName(),
        votes: desiredPieceVotes(current || [])
    };
    if (referenceScoreFile) {
        const formData = new FormData();
        formData.append('payload', JSON.stringify(payload));
        if (current?.updated_at) {
            formData.append('expected_updated_at', current.updated_at);
        }
        formData.append('reference_score_file', referenceScoreFile);
        await request(id ? `/api/extra/desired_pieces/${encodeURIComponent(id)}` : '/api/extra/desired_pieces', {
            method: id ? 'PUT' : 'POST',
            body: formData,
        });
    } else if (id) {
        await request(`/api/extra/desired_pieces/${encodeURIComponent(id)}`, jsonOptions('PUT', payload));
    } else {
        await saveExtra('desired_pieces', payload);
    }
    clearDesiredPieceForm();
    await loadExtraData(['desiredPieces']);
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
    await loadExtraData(['desiredPieces']);
}

async function deleteDesiredPiece(id) {
    if (!id || !confirmDelete()) return;
    await request(`/api/extra/desired_pieces/${encodeURIComponent(id)}`, { method: 'DELETE' });
    clearDesiredPieceForm();
    await loadExtraData(['desiredPieces']);
    showAlert('演奏希望曲を削除しました', 'success');
}

async function previewPromotionImage(event) {
    const file = event?.target?.files?.[0];
    if (!file || !$('promotionImagePreview')) return;
    const dataUrl = URL.createObjectURL(file);
    $('promotionImagePreview').innerHTML = `<img src="${escapeHtml(dataUrl)}" class="img-fluid rounded border" alt="宣伝画像プレビュー">`;
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
    const imageUrl = current?.image_url || '';
    const payload = {
        title,
        summary: $('promotionSummary')?.value.trim() || '',
        image_url: imageUrl,
        member_id: current?.member_id || appState.currentUserMemberId || '',
        registered_by: current?.registered_by || currentUserMemberName()
    };
    const formData = new FormData();
    Object.entries(payload).forEach(([key, value]) => {
        formData.append(key, String(value ?? ''));
    });
    if (imageFile) {
        formData.append('image_url_file', imageFile);
    }
    await request(id ? `/api/extra/promotions/${encodeURIComponent(id)}` : '/api/extra/promotions', {
        method: id ? 'PUT' : 'POST',
        body: formData,
    });
    clearPromotionForm();
    await loadExtraData(['promotions']);
    showAlert('宣伝を保存しました', 'success');
}

async function deletePromotion(id) {
    if (!id || !confirmDelete()) return;
    await request(`/api/extra/promotions/${encodeURIComponent(id)}`, { method: 'DELETE' });
    clearPromotionForm();
    await loadExtraData(['promotions']);
    showAlert('宣伝を削除しました', 'success');
}
