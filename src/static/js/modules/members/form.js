// Member form helpers split from modules/members.js.
// Keep global names for compatibility with legacy non-module loading.

var appState = window.portalRuntimeContext.appState;
var $ = window.portalRuntimeContext.getById;

function joinedAtMonthInputValue(value) {
    const text = String(value || '').trim();
    const match = text.match(/^(\d{4})[-\/\.](\d{2})/);
    return match ? `${match[1]}-${match[2]}` : '';
}

async function selectMember(id) {
    const item = memberSummaryById(id);
    if (!item) return;
    await loadMemberDetail(id);
    const detail = memberDetailById(id) || item;
    $('memberId').value = detail.id;
    const fallbackName = detail.name && !detail.last_name && !detail.first_name ? detail.name : '';
    if ($('memberLastName')) $('memberLastName').value = detail.last_name || fallbackName;
    if ($('memberFirstName')) $('memberFirstName').value = detail.first_name || '';
    if ($('memberMaidenName')) $('memberMaidenName').value = detail.maiden_name || '';
    if ($('memberLastNameKana')) $('memberLastNameKana').value = detail.last_name_kana || '';
    if ($('memberFirstNameKana')) $('memberFirstNameKana').value = detail.first_name_kana || '';
    if ($('memberMaidenNameKana')) $('memberMaidenNameKana').value = detail.maiden_name_kana || '';
    $('memberPart').value = detail.part || '';
    if ($('memberPhotoFile')) $('memberPhotoFile').value = '';
    if ($('memberIsFounder')) $('memberIsFounder').checked = Boolean(detail.is_founder);
    if ($('memberIsRecordingManager')) $('memberIsRecordingManager').checked = Boolean(detail.is_recording_manager);
    if ($('memberIsSheetManager')) $('memberIsSheetManager').checked = Boolean(detail.is_sheet_manager);
    if ($('memberPermission')) $('memberPermission').value = detail.permission || '一般';
    if ($('memberJoinedAt')) $('memberJoinedAt').value = joinedAtMonthInputValue(detail.joined_at);
    if ($('memberSystemAccessUntil')) $('memberSystemAccessUntil').value = detail.system_access_until || '';
    if ($('memberIntroducer')) $('memberIntroducer').value = detail.introducer || '';
    if ($('memberRole')) $('memberRole').value = detail.role || '';
    if ($('memberInstrumentHistory')) $('memberInstrumentHistory').value = detail.instrument_history || '';
    if ($('memberPastOrchestras')) $('memberPastOrchestras').value = detail.past_orchestras || '';
    $('memberComment').value = detail.comment || '';
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
