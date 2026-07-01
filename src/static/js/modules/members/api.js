// Member API actions split from modules/members.js.
// Keep global names for compatibility with legacy non-module loading.

var appState = window.portalRuntimeContext.appState;
var $ = window.portalRuntimeContext.getById;

async function saveMember() {
    const current = appState.members.find((member) => String(member.id) === String($('memberId').value));
    const photoFile = $('memberPhotoFile')?.files?.[0];
    const photoUrl = photoFile ? await fileToDataUrl(photoFile) : (current?.photo_url || '');
    const password = $('memberPassword') ? $('memberPassword').value.trim() : '';
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
        password,
        permission: $('memberPermission') ? $('memberPermission').value : '一般',
        joined_at: $('memberJoinedAt') ? $('memberJoinedAt').value : '',
        system_access_until: $('memberSystemAccessUntil') ? $('memberSystemAccessUntil').value : '',
        introducer: $('memberIntroducer') ? $('memberIntroducer').value.trim() : '',
        role: $('memberRole') ? $('memberRole').value.trim() : '',
        instrument_history: $('memberInstrumentHistory') ? $('memberInstrumentHistory').value.trim() : '',
        past_orchestras: $('memberPastOrchestras') ? $('memberPastOrchestras').value.trim() : '',
        comment: $('memberComment').value.trim(),
    };
    if (!payload.last_name || !payload.first_name) {
        showAlert('姓と名を入力してください', 'warning');
        return;
    }
    if (!payload.part) {
        showAlert('パートを選択してください', 'warning');
        return;
    }
    if (payload.permission === 'エキストラ' && !payload.system_access_until) {
        showAlert('エキストラの場合はシステム利用終了日を入力してください', 'warning');
        return;
    }
    if (payload.permission !== 'エキストラ') {
        payload.system_access_until = '';
    }
    const id = $('memberId').value;
    await request(id ? `/api/members/${id}` : '/api/members', jsonOptions(id ? 'PUT' : 'POST', payload));
    clearMemberForm();
    await loadMembers();
    showAlert('団員情報を保存しました', 'success');
}

async function deleteMember() {
    const id = $('memberId').value;
    if (!id) {
        showAlert('削除する団員を一覧から選択してください', 'warning');
        return;
    }
    if (!confirmDelete()) return;
    await request(`/api/members/${id}`, { method: 'DELETE' });
    clearMemberForm();
    await loadMembers();
    showAlert('団員情報を削除しました', 'success');
}