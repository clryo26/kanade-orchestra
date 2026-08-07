// Member API actions split from modules/members.js.
// Keep global names for compatibility with legacy non-module loading.

var appState = window.portalRuntimeContext.appState;
var $ = window.portalRuntimeContext.getById;

async function saveMember() {
    const current = appState.members.find((member) => String(member.id) === String($('memberId').value));
    const photoFile = $('memberPhotoFile')?.files?.[0];
    const photoUrl = current?.photo_url || '';
    const lastName = $('memberLastName') ? $('memberLastName').value.trim() : '';
    const firstName = $('memberFirstName') ? $('memberFirstName').value.trim() : '';
    const payload = {
        name: `${lastName}${firstName}`,
        last_name: lastName,
        first_name: firstName,
        maiden_name: $('memberMaidenName') ? $('memberMaidenName').value.trim() : '',
        last_name_kana: $('memberLastNameKana') ? $('memberLastNameKana').value.trim() : '',
        first_name_kana: $('memberFirstNameKana') ? $('memberFirstNameKana').value.trim() : '',
        maiden_name_kana: $('memberMaidenNameKana') ? $('memberMaidenNameKana').value.trim() : '',
        part: $('memberPart').value,
        photo_url: photoUrl,
        is_founder: $('memberIsFounder') ? $('memberIsFounder').checked : false,
        is_recording_manager: $('memberIsRecordingManager') ? $('memberIsRecordingManager').checked : false,
        is_sheet_manager: $('memberIsSheetManager') ? $('memberIsSheetManager').checked : false,
        password: '',
        permission: $('memberPermission') ? $('memberPermission').value : '荳闊ｬ',
        joined_at: $('memberJoinedAt') ? $('memberJoinedAt').value : '',
        system_access_until: $('memberSystemAccessUntil') ? $('memberSystemAccessUntil').value : '',
        introducer: $('memberIntroducer') ? $('memberIntroducer').value.trim() : '',
        role: $('memberRole') ? $('memberRole').value.trim() : '',
        instrument_history: $('memberInstrumentHistory') ? $('memberInstrumentHistory').value.trim() : '',
        past_orchestras: $('memberPastOrchestras') ? $('memberPastOrchestras').value.trim() : '',
        comment: $('memberComment').value.trim(),
    };
    if (!payload.last_name || !payload.first_name) {
        showAlert('蟋薙→蜷阪ｒ蜈･蜉帙＠縺ｦ縺上□縺輔＞', 'warning');
        return;
    }
    if (!payload.part) {
        showAlert('繝代・繝医ｒ驕ｸ謚槭＠縺ｦ縺上□縺輔＞', 'warning');
        return;
    }
    if (payload.permission === '繧ｨ繧ｭ繧ｹ繝医Λ' && !payload.system_access_until) {
        showAlert('繧ｨ繧ｭ繧ｹ繝医Λ縺ｮ蝣ｴ蜷医・繧ｷ繧ｹ繝・Β蛻ｩ逕ｨ邨ゆｺ・律繧貞・蜉帙＠縺ｦ縺上□縺輔＞', 'warning');
        return;
    }
    if (payload.permission !== '繧ｨ繧ｭ繧ｹ繝医Λ') {
        payload.system_access_until = '';
    }
    const id = $('memberId').value;
    const formData = new FormData();
    Object.entries(payload).forEach(([key, value]) => {
        formData.append(key, typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value ?? ''));
    });
    if (photoFile) {
        formData.append('photo_file', photoFile);
    }
    const savedMember = await request(id ? `/api/members/${id}` : '/api/members', {
        method: id ? 'PUT' : 'POST',
        body: formData,
    });
    if (savedMember) {
        upsertMemberSummary(savedMember);
        storeMemberDetailRecord(savedMember.id, savedMember, 'loaded');
    }
    clearMemberForm();
    renderMembers();
    renderPaymentAdmin();
    showAlert('蝗｣蜩｡諠・ｱ繧剃ｿ晏ｭ倥＠縺ｾ縺励◆', 'success');
}

async function resetMemberPassword() {
    const id = $('memberId').value;
    if (!id) {
        showAlert('繝代せ繝ｯ繝ｼ繝峨ｒ繝ｪ繧ｻ繝・ヨ縺吶ｋ蝗｣蜩｡繧剃ｸ隕ｧ縺九ｉ驕ｸ謚槭＠縺ｦ縺上□縺輔＞', 'warning');
        return;
    }

    const member = appState.members.find((item) => String(item.id) === String(id));
    const name = member ? memberDisplayName(member) : '';
    if (!window.confirm(`${name || 'Selected member'} password reset?`)) return;

    const updatedMember = await request(`/api/members/${encodeURIComponent(id)}/reset-password`, { method: 'POST' });
    if (updatedMember) {
        upsertMemberSummary(updatedMember);
        storeMemberDetailRecord(updatedMember.id, updatedMember, 'loaded');
    }
    renderMembers();
    renderPaymentAdmin();
    showAlert('Password reset completed', 'success');
}

async function deleteMember() {
    const id = $('memberId').value;
    if (!id) {
        showAlert('蜑企勁縺吶ｋ蝗｣蜩｡繧剃ｸ隕ｧ縺九ｉ驕ｸ謚槭＠縺ｦ縺上□縺輔＞', 'warning');
        return;
    }
    if (!confirmDelete()) return;
    await request(`/api/members/${id}`, { method: 'DELETE' });
    clearMemberForm();
    clearMemberSummaryAndDetail(id);
    renderMembers();
    renderPaymentAdmin();
    showAlert('蝗｣蜩｡諠・ｱ繧貞炎髯､縺励∪縺励◆', 'success');
}
