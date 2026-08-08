// Date adjustment event handlers split from modules/date_piece_promotion.js.
// Keep global names for compatibility with legacy non-module loading.

function showDesiredPieceReferenceScore(id) {
    const item = appState.desiredPieces.find((piece) => String(piece.id || '') === String(id));
    if (!item) {
        showAlert('参考スコアを表示する曲が見つかりません', 'warning');
        return;
    }

    const viewUrl = String(item.reference_score_url || '').trim();
    if (!viewUrl) {
        showAlert('参考スコアはまだ登録されていません', 'warning');
        return;
    }

    const title = $('sheetViewerTitle');
    const download = $('sheetViewerDownload');
    if (title) title.textContent = item.title || item.piece || '参考スコア';
    if (download) download.href = viewUrl;
    switchTab('memberPanel', 'member-sheet-viewer', false);
    renderPdfViewer(viewUrl);
}

function bindDateAdjustmentCreateEvents() {
    $('dateAdjustmentAddCandidateBtn')?.addEventListener('click', () => {
        const rows = $('dateAdjustmentCandidateRows');
        if (!rows) return;
        rows.insertAdjacentHTML('beforeend', dateAdjustmentCandidateRowHtml({ date: window.portalRuntimeContext.today() }, true));
        bindDateAdjustmentCandidateRows();
    });

    $('dateAdjustmentCreateBtn')?.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '作成中...', async () => {
        const built = buildDateAdjustmentCreatePayload();
        if (!built.ok) {
            showAlert(built.message, 'warning');
            return;
        }

        await saveExtra('date_adjustments', built.payload);
        await loadExtraData(['dateAdjustments']);
        showAlert('日程調整を作成しました', 'success');
    }));
}

function bindDateAdjustmentDetailEvents(options) {
    const {
        adjustment,
        candidates,
        detailView,
        listView,
        unansweredMembers,
        reminderMessage,
        respondentRowsHtml,
    } = options;

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
        if (!validateDateAdjustmentResponseUser(name)) {
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
                    note,
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

        await loadExtraData(['dateAdjustmentResponses']);
        renderDateAdjustmentDetail(adjustment.id);
        showAlert('回答を保存しました', 'success');
    }));

    $('dateAdjustmentDeleteBtn')?.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', async () => {
        if (!dateAdjustmentCanDelete(adjustment)) {
            showAlert('削除権限がありません', 'warning');
            return;
        }
        const phrase = adjustment.delete_phrase ? prompt('削除時の合言葉を入力してください') : null;
        const phraseValidation = validateDateAdjustmentDeletePhrase(adjustment, phrase);
        if (phraseValidation.canceled) return;
        if (!phraseValidation.ok) {
            showAlert(phraseValidation.message, 'danger');
            return;
        }
        if (!confirmDelete()) return;

        const relatedResponses = appState.dateAdjustmentResponses.filter((item) => String(item.adjustment_id || '') === String(adjustment.id || ''));
        await Promise.all(relatedResponses.filter((item) => item.id).map((item) => request(`/api/extra/date_adjustment_responses/${encodeURIComponent(item.id)}`, { method: 'DELETE' })));
        await request(`/api/extra/date_adjustments/${encodeURIComponent(adjustment.id)}`, { method: 'DELETE' });
        await loadExtraData(['dateAdjustments', 'dateAdjustmentResponses']);
        renderDateAdjustmentView();
        showAlert('日程調整を削除しました', 'success');
    }));
}
