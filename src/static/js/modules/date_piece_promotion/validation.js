// Date adjustment validation split from modules/date_piece_promotion.js.
// Keep global names for compatibility with legacy non-module loading.

function validateDateAdjustmentCreateInput(title, candidates) {
    if (!String(title || '').trim()) {
        return 'タイトルを入力してください';
    }
    if (!Array.isArray(candidates) || !candidates.length) {
        return '候補日を1件以上入力してください';
    }
    return '';
}

function buildDateAdjustmentCreatePayload() {
    const title = $('dateAdjustmentTitle')?.value.trim() || '';
    const candidates = collectDateAdjustmentCandidates();
    const validationMessage = validateDateAdjustmentCreateInput(title, candidates);
    if (validationMessage) {
        return { ok: false, message: validationMessage, payload: null };
    }

    return {
        ok: true,
        message: '',
        payload: {
            title,
            deadline: $('dateAdjustmentDeadline')?.value || '',
            notes: $('dateAdjustmentNotes')?.value.trim() || '',
            delete_phrase: $('dateAdjustmentDeletePhrase')?.value.trim() || '',
            created_by: currentUserMemberName(),
            member_id: appState.currentUserMemberId,
            candidates,
        },
    };
}

function validateDateAdjustmentResponseUser(name) {
    return Boolean(String(name || '').trim());
}

function validateDateAdjustmentDeletePhrase(adjustment, phrase) {
    if (!adjustment?.delete_phrase) return { ok: true, message: '' };
    if (phrase === null) return { ok: false, message: '', canceled: true };
    if (phrase !== adjustment.delete_phrase) {
        return { ok: false, message: '削除時の合言葉が違います', canceled: false };
    }
    return { ok: true, message: '', canceled: false };
}
