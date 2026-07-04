// Practice/casting API actions split from modules/practice_casting.js.
// Keep global names for compatibility with legacy non-module loading.

var appState = window.portalRuntimeContext.appState;
var $ = window.portalRuntimeContext.getById;

async function savePracticeInstructionAdmin() {
    const payload = {
        performance_id: $('practiceInstructionPerformance')?.value || '',
        piece: $('practiceInstructionPiece')?.value.trim() || '',
        practice_notes: $('practiceInstructionNotes')?.value.trim() || '',
        performance_instruction: '',
    };
    if (!payload.performance_id || !payload.piece) {
        showAlert('演奏会と曲名を入力してください', 'warning');
        return;
    }
    if (!payload.practice_notes) {
        showAlert('練習時の指摘内容を入力してください', 'warning');
        return;
    }

    const id = $('practiceInstructionId')?.value || '';
    const duplicate = appState.practiceInstructions.find((item) => String(item.performance_id || '') === String(payload.performance_id) && String(item.piece || '') === payload.piece);
    const saveId = id || String(duplicate?.id || '');
    if (saveId) {
        await request(`/api/extra/practice_instructions/${encodeURIComponent(saveId)}`, jsonOptions('PUT', payload));
    } else {
        await saveExtra('practice_instructions', payload);
    }
    clearPracticeInstructionForm();
    await loadExtraData();
    showAlert('練習指示を保存しました', 'success');
}

async function deletePracticeInstructionAdmin() {
    const id = $('practiceInstructionId')?.value || '';
    if (!id) {
        showAlert('削除する練習指示を選択してください', 'warning');
        return;
    }
    if (!confirmDelete()) return;
    await request(`/api/extra/practice_instructions/${encodeURIComponent(id)}`, { method: 'DELETE' });
    clearPracticeInstructionForm();
    await loadExtraData();
    showAlert('練習指示を削除しました', 'success');
}

async function saveCasting() {
    const perfId = Number($('castingPerformanceSelect')?.value || 0);
    if (!perfId) {
        showAlert('演奏会を選択してください', 'warning');
        return;
    }

    const piece = $('castingPieceInput')?.value.trim() || '';
    const members = appState.castingEditingMembers.filter((m) => m.member_id);
    const extras = appState.castingEditingExtras.filter((e) => e.name);

    if (!members.length && !extras.length) {
        showAlert('団員またはエキストラを追加してください', 'warning');
        return;
    }

    const payload = { performance_id: perfId, piece, members, extras };
    try {
        setOperationStatus('castingOperationStatus', '保存中...');
        if (appState.castingEditingId) {
            await request(`/api/extra/castings/${appState.castingEditingId}`, jsonOptions('PUT', payload));
        } else {
            await request('/api/extra/castings', jsonOptions('POST', payload));
        }
        await loadExtraData();
        renderCastingAdmin();
        showAlert('乗り番を保存しました', 'success');
        setOperationStatus('castingOperationStatus', null);
    } catch (error) {
        setOperationStatus('castingOperationStatus', '保存に失敗しました', 'danger');
        console.error('Save casting failed', error);
    }
}

async function deleteCasting() {
    if (!appState.castingEditingId) {
        showAlert('削除対象が選択されていません', 'warning');
        return;
    }
    if (!confirmDelete()) return;
    try {
        setOperationStatus('castingOperationStatus', '削除中...');
        await request(`/api/extra/castings/${appState.castingEditingId}`, jsonOptions('DELETE'));
        await loadExtraData();
        renderCastingAdmin();
        clearCastingForm();
        showAlert('乗り番を削除しました', 'success');
        setOperationStatus('castingOperationStatus', null);
    } catch (error) {
        setOperationStatus('castingOperationStatus', '削除に失敗しました', 'danger');
        console.error('Delete casting failed', error);
    }
}