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
    const operationPayload = { payload, expected_updated_at: current?.updated_at || '' };
    if (referenceScoreFile) {
        const formData = new FormData();
        formData.append('payload', JSON.stringify(payload));
        if (current?.updated_at) {
            formData.append('expected_updated_at', current.updated_at);
        }
        formData.append('reference_score_file', referenceScoreFile);
        await request(id ? `/api/extra/desired_pieces/${encodeURIComponent(id)}` : '/api/extra/desired_pieces', {
            _portalFileOperation: true,
            method: id ? 'PUT' : 'POST',
            body: formData,
        });
    } else if (id) {
        await request(`/api/extra/desired_pieces/${encodeURIComponent(id)}`, { ...jsonOptions('PUT', operationPayload), _portalFileOperation: true });
    } else {
        await request('/api/extra/desired_pieces', { ...jsonOptions('POST', operationPayload), _portalFileOperation: true });
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
    await request(`/api/extra/desired_pieces/${encodeURIComponent(id)}`, { method: 'DELETE', _portalFileOperation: true });
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
    const payload = {
        title,
        summary: $('promotionSummary')?.value.trim() || '',
        image_action: imageFile ? 'replace' : $('promotionRemoveImage')?.checked ? 'remove' : id ? 'keep' : 'remove',
        ...(id ? { expected_revision: Number($('promotionRevision')?.value || current?.revision) } : {})
    };
    const formData = new FormData();
    Object.entries(payload).forEach(([key, value]) => {
        formData.append(key, String(value ?? ''));
    });
    if (imageFile) {
        formData.append('image_url_file', imageFile);
    }
    if (!await runPromotionOperation(id ? 'PUT' : 'POST', id, payload, imageFile, formData)) return;
    clearPromotionForm();
    await loadExtraData(['promotions']);
    showAlert(appState.promotionLoadState === 'error' ? '保存しましたが一覧を更新できませんでした' : '宣伝を保存しました',
        appState.promotionLoadState === 'error' ? 'warning' : 'success');
}

async function deletePromotion(id) {
    if (!id || !confirmDelete()) return;
    const current = appState.promotions.find((item) => String(item.id) === String(id));
    const payload = { expected_revision: current?.revision };
    if (!await runPromotionOperation('DELETE', id, payload, null, JSON.stringify(payload))) return;
    clearPromotionForm();
    await loadExtraData(['promotions']);
    showAlert('宣伝を削除しました', 'success');
}

function promotionPendingKey() {
    return `promotion-operation:${location.origin}:${appState.currentUserMemberId || currentUserMemberName()}`;
}

function restorePromotionForm() {
    try {
        const pending = JSON.parse(sessionStorage.getItem(promotionPendingKey()) || 'null');
        if (!pending || pending.method === 'DELETE') return;
        $('promotionId').value = pending.id || '';
        $('promotionTitle').value = pending.payload.title || '';
        $('promotionSummary').value = pending.payload.summary || '';
        $('promotionRevision').value = pending.payload.expected_revision || '';
    } catch (_) { /* A malformed local draft must not stop loading the list. */ }
}

function discardPromotionOperation() {
    if (appState.promotionOperationBusy) return;
    if (!confirm('結果不明の登録が成功している場合、再登録すると重複します。先に状態を確認してください。確認待ちの操作を破棄しますか？')) return;
    sessionStorage.removeItem(promotionPendingKey());
    clearPromotionForm();
}

async function promotionDigest(value) {
    const bytes = value instanceof Blob ? await value.arrayBuffer() : new TextEncoder().encode(value);
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
        .map((part) => part.toString(16).padStart(2, '0')).join('');
}

async function checkPromotionOperation() {
    const key = promotionPendingKey();
    const pending = JSON.parse(sessionStorage.getItem(key) || 'null');
    if (!pending) { showAlert('確認待ちの操作はありません', 'info'); return; }
    try {
        const response = await request(`/api/promotions/operations/${encodeURIComponent(pending.operationId)}`, { _structuredResult: true });
        if (response.status === 200 && response.data.state !== 'processing') {
            sessionStorage.removeItem(key);
            if (response.data.result_status >= 400) {
                showAlert(response.data.result_body?.detail?.message || '操作は完了しませんでした。入力を確認してください', 'warning');
            } else {
                clearPromotionForm();
                showAlert('操作の完了を確認しました', 'success');
            }
            await loadExtraData(['promotions']);
            return true;
        }
        showAlert(response.status === 404 || response.data.retryable
            ? '同じ内容で登録・削除を再試行してください。画像は必要に応じて再選択してください'
            : '処理結果は確認中です。しばらくして状態を確認してください', 'warning');
    } catch (_) {
        showAlert('結果を確認できませんでした。状態確認を再試行してください', 'warning');
    }
    return false;
}

async function runPromotionOperation(method, id, payload, file, body) {
    if (appState.promotionOperationBusy) return false;
    const key = promotionPendingKey();
    const digest = await promotionDigest(JSON.stringify([method, String(id || ''), payload, file ? await promotionDigest(file) : null]));
    let pending = JSON.parse(sessionStorage.getItem(key) || 'null');
    if (pending && pending.digest !== digest) {
        showAlert('確認待ちの操作があります。先に「操作の状態確認」を押してください', 'warning');
        return false;
    }
    if (!pending) {
        pending = { operationId: crypto.randomUUID(), digest, method, id, payload };
        sessionStorage.setItem(key, JSON.stringify(pending));
    }
    appState.promotionOperationBusy = true;
    try {
        const response = await request(id ? `/api/extra/promotions/${encodeURIComponent(id)}` : '/api/extra/promotions', {
            method, headers: { 'Idempotency-Key': pending.operationId, ...(method === 'DELETE' ? { 'Content-Type': 'application/json' } : {}) },
            body, _structuredResult: true
        });
        if (response.status === 200) {
            sessionStorage.removeItem(key);
            return true;
        }
        if (response.status === 202 || response.status >= 500) {
            showAlert('結果を確認中です。「操作の状態確認」から確認できます', 'warning');
            // Poll only while visible, bounded to one minute. Keep the operation
            // key after a timeout/reload; a later retry never becomes a new POST.
            for (let attempt = 0; attempt < 6 && !document.hidden; attempt += 1) {
                await new Promise((resolve) => setTimeout(resolve, Math.min(10000, 2000 * (attempt + 1))));
                if (await checkPromotionOperation()) return false;
            }
            return false;
        }
        sessionStorage.removeItem(key);
        showAlert(response.data?.detail?.message || response.data?.detail || '入力内容を確認してください', 'warning');
        return false;
    } catch (_) {
        showAlert('結果を確認できません。同じ内容で再試行するか、操作の状態を確認してください', 'warning');
        return false;
    } finally {
        appState.promotionOperationBusy = false;
    }
}
