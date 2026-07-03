// Member form helpers split from modules/members.js.
// Keep global names for compatibility with legacy non-module loading.

var appState = window.portalRuntimeContext.appState;
var $ = window.portalRuntimeContext.getById;

function joinedAtMonthInputValue(value) {
    const text = String(value || '').trim();
    const match = text.match(/^(\d{4})[-\/\.](\d{2})/);
    return match ? `${match[1]}-${match[2]}` : '';
}

function selectMember(id) {
    const item = appState.members.find((member) => member.id === id);
    if (!item) return;
    $('memberId').value = item.id;
    const fallbackName = item.name && !item.last_name && !item.first_name ? item.name : '';
    if ($('memberLastName')) $('memberLastName').value = item.last_name || fallbackName;
    if ($('memberFirstName')) $('memberFirstName').value = item.first_name || '';
    if ($('memberMaidenName')) $('memberMaidenName').value = item.maiden_name || '';
    if ($('memberLastNameKana')) $('memberLastNameKana').value = item.last_name_kana || '';
    if ($('memberFirstNameKana')) $('memberFirstNameKana').value = item.first_name_kana || '';
    if ($('memberMaidenNameKana')) $('memberMaidenNameKana').value = item.maiden_name_kana || '';
    $('memberPart').value = item.part || '';
    if ($('memberPhotoFile')) $('memberPhotoFile').value = '';
    if ($('memberIsFounder')) $('memberIsFounder').checked = Boolean(item.is_founder);
    if ($('memberIsRecordingManager')) $('memberIsRecordingManager').checked = Boolean(item.is_recording_manager);
    if ($('memberIsSheetManager')) $('memberIsSheetManager').checked = Boolean(item.is_sheet_manager);
    if ($('memberPassword')) $('memberPassword').value = '';
    if ($('memberPermission')) $('memberPermission').value = item.permission || '一般';
    if ($('memberJoinedAt')) $('memberJoinedAt').value = joinedAtMonthInputValue(item.joined_at);
    if ($('memberSystemAccessUntil')) $('memberSystemAccessUntil').value = item.system_access_until || '';
    if ($('memberIntroducer')) $('memberIntroducer').value = item.introducer || '';
    if ($('memberRole')) $('memberRole').value = item.role || '';
    if ($('memberInstrumentHistory')) $('memberInstrumentHistory').value = item.instrument_history || '';
    if ($('memberPastOrchestras')) $('memberPastOrchestras').value = item.past_orchestras || '';
    $('memberComment').value = item.comment || '';
    syncMemberPermissionFields();
}

function clearMemberForm() {
    $('memberId').value = '';
    if ($('memberLastName')) $('memberLastName').value = '';
    if ($('memberFirstName')) $('memberFirstName').value = '';
    if ($('memberMaidenName')) $('memberMaidenName').value = '';
    if ($('memberLastNameKana')) $('memberLastNameKana').value = '';
    if ($('memberFirstNameKana')) $('memberFirstNameKana').value = '';
    if ($('memberMaidenNameKana')) $('memberMaidenNameKana').value = '';
    $('memberPart').value = '';
    if ($('memberPhotoFile')) $('memberPhotoFile').value = '';
    if ($('memberIsFounder')) $('memberIsFounder').checked = false;
    if ($('memberIsRecordingManager')) $('memberIsRecordingManager').checked = false;
    if ($('memberIsSheetManager')) $('memberIsSheetManager').checked = false;
    if ($('memberPassword')) $('memberPassword').value = '';
    if ($('memberPermission')) $('memberPermission').value = '一般';
    if ($('memberJoinedAt')) $('memberJoinedAt').value = '';
    if ($('memberSystemAccessUntil')) $('memberSystemAccessUntil').value = '';
    if ($('memberIntroducer')) $('memberIntroducer').value = '';
    if ($('memberRole')) $('memberRole').value = '';
    if ($('memberInstrumentHistory')) $('memberInstrumentHistory').value = '';
    if ($('memberPastOrchestras')) $('memberPastOrchestras').value = '';
    $('memberComment').value = '';
    syncMemberPermissionFields();
}

function syncMemberPermissionFields() {
    const permission = $('memberPermission')?.value || '一般';
    const accessUntil = $('memberSystemAccessUntil');
    if (!accessUntil) return;
    const isExtra = permission === 'エキストラ';
    accessUntil.disabled = !isExtra;
    accessUntil.required = isExtra;
    if (!isExtra) accessUntil.value = '';
}