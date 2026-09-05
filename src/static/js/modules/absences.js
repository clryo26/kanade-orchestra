// Attendance UI shared by the practice schedule, attendance overview, and reminder dialog.
// It depends on the shared globals declared in main.js.

var appState = window.portalRuntimeContext.appState;
var $ = window.portalRuntimeContext.getById;

const ATTENDANCE_STATUS_OPTIONS = [['present', '出席'], ['absent', '欠席'], ['late', '遅刻'], ['leave_early', '早退']];

function absenceBelongsToCurrentUser(absence) {
    const currentId = String(appState.currentUserMemberId || '');
    const currentName = currentUserMemberName();
    // Once the logged-in member has an ID, a matching display name alone must
    // never claim another member's response. Name-only comparison is retained
    // solely for sessions and legacy records that have no member ID at all.
    if (currentId) return String(absence?.member_id || '') === currentId;
    return Boolean(currentName && absence?.name === currentName && !absence?.member_id);
}

function ownAttendanceForSchedule(scheduleId) {
    return (appState.absences || []).find((absence) => String(absence?.schedule_id || '') === String(scheduleId || '') && absenceBelongsToCurrentUser(absence)) || null;
}

function attendanceStatusLabel(absenceOrStatus) {
    const status = typeof absenceOrStatus === 'string' ? absenceOrStatus : absenceOrStatus?.status;
    if (status === 'present') return '出席';
    if (status === 'late') return '遅刻';
    if (status === 'leave_early') return '早退';
    // "ng" is a legacy stored value and remains a readable absence.
    return '欠席';
}

function absencePlannedTimeLabel(value) {
    const text = String(value || '');
    const match = text.match(/^(\d{2}:\d{2})/);
    return match ? match[1] : text;
}

function attendanceEntryLabel(absence, includeName = true) {
    const plannedTime = absencePlannedTimeLabel(absence?.planned_time);
    const status = `${attendanceStatusLabel(absence)}${plannedTime ? ` ${plannedTime}` : ''}`;
    return includeName ? `${absence?.name || ''}（${status}）` : status;
}

function attendanceFormHtml(schedule, existing, context = 'schedule') {
    const scheduleId = String(schedule?.id || '');
    const selectedStatus = existing?.status || '';
    const plannedTime = absencePlannedTimeLabel(existing?.planned_time);
    const formId = `attendance-${context}-${scheduleId}`;
    const saveLabel = existing ? '変更' : '登録';
    return `<section class="attendance-form mt-3 border-top pt-3" data-attendance-form data-attendance-schedule-id="${escapeHtml(scheduleId)}">
        <h6 class="mb-2">出欠登録</h6>
        <div class="row g-2 align-items-end" data-attendance-status-grid role="radiogroup" aria-label="${escapeHtml(formatScheduleDate(schedule.date))} の出欠">
            ${ATTENDANCE_STATUS_OPTIONS.map(([value, label], index) => `<div class="${index < 2 ? 'col-6' : 'col-2'} col-sm-auto"><label class="form-check mb-0" for="${escapeHtml(formId)}-${value}"><input class="form-check-input" type="radio" name="${escapeHtml(formId)}-status" id="${escapeHtml(formId)}-${value}" value="${value}"${selectedStatus === value ? ' checked' : ''}><span class="form-check-label">${label}</span></label></div>`).join('')}
            <div class="col-8 col-sm-auto d-flex align-items-center gap-1" data-attendance-time-row${selectedStatus === 'late' || selectedStatus === 'leave_early' ? '' : ' hidden'}><label class="form-label mb-0 text-nowrap" data-attendance-time-label for="${escapeHtml(formId)}-time">予定時刻</label><input class="form-control flex-grow-1" data-attendance-time id="${escapeHtml(formId)}-time" type="time" value="${escapeHtml(plannedTime)}"></div>
        </div>
        <div class="mt-2"><button class="btn btn-primary btn-sm" type="button" data-attendance-save>${saveLabel}</button></div>
    </section>`;
}
function syncAttendanceTimeInput(form) {
    const selected = form.querySelector('input[type="radio"]:checked')?.value || '';
    const needsTime = selected === 'late' || selected === 'leave_early';
    const timeRow = form.querySelector('[data-attendance-time-row]');
    const label = form.querySelector('[data-attendance-time-label]');
    const timeInput = form.querySelector('[data-attendance-time]');
    if (timeRow) timeRow.hidden = !needsTime;
    if (label) label.textContent = '予定時刻';
    if (!needsTime && timeInput) timeInput.value = '';
}

function bindAttendanceForms(container, afterSave = null) {
    container.querySelectorAll('[data-attendance-form]').forEach((form) => {
        form.querySelectorAll('input[type="radio"]').forEach((input) => input.addEventListener('change', () => syncAttendanceTimeInput(form)));
        form.querySelector('[data-attendance-save]')?.addEventListener('click', (event) => {
            void withButtonStatus(event.currentTarget, '登録中...', async () => {
                await saveOwnAttendance(form);
                if (afterSave) await afterSave();
            });
        });
    });
}

async function saveOwnAttendance(form) {
    const scheduleId = form.dataset.attendanceScheduleId || '';
    const status = form.querySelector('input[type="radio"]:checked')?.value || '';
    const plannedTime = form.querySelector('[data-attendance-time]')?.value || '';
    const name = currentUserMemberName();
    if (!scheduleId || !name || !status) { showAlert('出欠を選択してください', 'warning'); return; }
    if ((status === 'late' || status === 'leave_early') && !plannedTime) { showAlert('予定時刻を入力してください', 'warning'); return; }
    const schedule = (appState.schedules || []).find((item) => String(item.id) === String(scheduleId));
    const payload = { name, member_id: appState.currentUserMemberId, schedule_id: scheduleId, schedule_date: schedule?.date || '', status, planned_time: plannedTime };
    const existing = ownAttendanceForSchedule(scheduleId);
    if (existing?.id) await request(`/api/extra/absences/${encodeURIComponent(existing.id)}`, jsonOptions('PUT', payload));
    else await saveExtra('absences', payload);
    await loadExtraData(['absences']);
    showAlert('出欠を登録しました', 'success');
}

function visibleAttendanceSchedules() {
    const today = window.portalRuntimeContext.today();
    return sortedSchedules(appState.schedules || []).filter((schedule) => !schedule?.date || String(schedule.date) >= today);
}

function renderAbsenceView() {
    const container = $('memberAbsenceInfo');
    if (!container) return;
    const schedules = visibleAttendanceSchedules();
    if (!schedules.length) { container.innerHTML = '<p class="text-muted mb-0">今後の練習予定はありません</p>'; return; }
    container.innerHTML = schedules.map((schedule) => attendanceOverviewHtml(schedule, appState.members || [])).join('');
    bindAttendanceOverviewTabs(container, renderAbsenceView);
}

function bindAttendanceOverviewTabs(container, rerender) {
    container.querySelectorAll('[data-attendance-overview-tab]').forEach((button) => button.addEventListener('click', () => {
        const scheduleId = String(button.dataset.attendanceScheduleId || '');
        const status = button.dataset.attendanceOverviewStatus || 'present';
        appState.attendanceOverviewSelectionBySchedule ||= {};
        appState.attendanceOverviewSelectionBySchedule[scheduleId] = status;
        rerender();
    }));
}

function attendanceMemberForResponse(response, members) {
    const memberId = String(response?.member_id || '');
    const member = (memberId && members.find((item) => String(item.id || '') === memberId))
        || members.find((item) => memberDisplayName(item) === String(response?.name || '')) || null;
    return { member, part: member?.part || '未設定', name: member ? memberDisplayName(member) : String(response?.name || ''), response };
}

function attendanceEntryCompare(a, b) {
    return partSortIndex(a.part) - partSortIndex(b.part)
        || String(a.part).localeCompare(String(b.part), 'ja')
        || String(memberKanaName(a.member) || a.name).localeCompare(String(memberKanaName(b.member) || b.name), 'ja')
        || String(a.name).localeCompare(String(b.name), 'ja');
}

function attendanceOverviewEntries(status, responses, members) {
    const responseByMemberId = new Map(responses.filter((item) => item.member_id).map((item) => [String(item.member_id), item]));
    const responseNames = new Set(responses.filter((item) => !item.member_id).map((item) => String(item.name || '')));
    if (status === 'unregistered') {
        return members.filter((member) => !responseByMemberId.has(String(member.id || '')) && !responseNames.has(memberDisplayName(member)))
            .map((member) => ({ member, part: member.part || '未設定', name: memberDisplayName(member), response: null })).sort(attendanceEntryCompare);
    }
    const statuses = status === 'present' ? new Set(['present', 'late', 'leave_early']) : new Set(['absent', 'ng']);
    const deduped = new Map();
    responses.filter((response) => statuses.has(response.status || 'absent')).forEach((response) => {
        const entry = attendanceMemberForResponse(response, members);
        const key = entry.member ? 'member:' + String(entry.member.id || '') : 'legacy:' + entry.name;
        if (!deduped.has(key)) deduped.set(key, entry);
    });
    return [...deduped.values()].sort(attendanceEntryCompare);
}

function attendanceMemberGroupsHtml(entries, includeStatus) {
    if (!entries.length) return '<div>なし</div>';
    const groups = groupBy(entries, 'part');
    return [...new Set(entries.map((entry) => entry.part))].sort((a, b) => partSortIndex(a) - partSortIndex(b) || String(a).localeCompare(String(b), 'ja')).map((part) => {
        const names = (groups[part] || []).map((entry) => escapeHtml(includeStatus && ['late', 'leave_early'].includes(entry.response?.status) ? attendanceEntryLabel(entry.response) : entry.name));
        return `<section class="attendance-part-group mt-2"><h6 class="mb-1">${escapeHtml(part)}</h6><div>${names.join('、')}</div></section>`;
    }).join('');
}

function attendanceOverviewHtml(schedule, members) {
    const responses = (appState.absences || []).filter((item) => String(item.schedule_id || '') === String(schedule.id || ''));
    const entries = { present: attendanceOverviewEntries('present', responses, members), absent: attendanceOverviewEntries('absent', responses, members), unregistered: attendanceOverviewEntries('unregistered', responses, members) };
    const scheduleId = String(schedule.id || '');
    const selected = appState.attendanceOverviewSelectionBySchedule?.[scheduleId] || 'present';
    const labels = { present: '出席', absent: '欠席', unregistered: '未登録' };
    const tabs = ['present', 'absent', 'unregistered'].map((status) => `<button type="button" role="tab" class="btn btn-sm ${selected === status ? 'btn-primary' : 'btn-outline-primary'}" data-attendance-overview-tab data-attendance-schedule-id="${escapeHtml(scheduleId)}" data-attendance-overview-status="${status}" aria-selected="${selected === status}">${labels[status]} ${entries[status].length}名</button>`).join('');
    return `<article class="info-block attendance-overview"><strong>${escapeHtml(formatScheduleDate(schedule.date))} ${escapeHtml(scheduleTimeLabel(schedule) || '')}</strong><div class="small text-muted mb-2">${escapeHtml(schedule.venue || '')}</div><div class="btn-group flex-wrap" role="tablist" aria-label="出欠区分">${tabs}</div><div class="mt-2" data-attendance-overview-members>${attendanceMemberGroupsHtml(entries[selected], selected === 'present')}</div></article>`;
}
function upcomingUnregisteredSchedules() {
    const today = window.portalRuntimeContext.today();
    // Date-only schedule values must not shift a day when the browser is in JST.
    const deadline = new Date(`${today}T00:00:00Z`);
    deadline.setUTCDate(deadline.getUTCDate() + 7);
    const deadlineText = deadline.toISOString().slice(0, 10);
    return sortedSchedules(appState.schedules || []).filter((schedule) => schedule?.date >= today && schedule.date <= deadlineText && !ownAttendanceForSchedule(schedule.id));
}

function attendanceReminderPresentationSet() {
    const memberKey = String(appState.currentUserMemberId || currentUserMemberName() || '');
    if (!memberKey) return null;
    appState.attendanceReminderPresentedByMember ||= {};
    const existing = appState.attendanceReminderPresentedByMember[memberKey];
    if (existing instanceof Set) return existing;
    const presented = new Set(Array.isArray(existing) ? existing : []);
    appState.attendanceReminderPresentedByMember[memberKey] = presented;
    return presented;
}

function unpresentedUpcomingAttendanceSchedules() {
    const upcoming = upcomingUnregisteredSchedules();
    const presented = attendanceReminderPresentationSet();
    if (!presented) return [];
    const currentIds = new Set(upcoming.map((schedule) => String(schedule.id || '')));
    // Forget answered, expired, or removed schedules so a future unregistration
    // of that schedule can be presented again.
    [...presented].forEach((scheduleId) => {
        if (!currentIds.has(String(scheduleId))) presented.delete(scheduleId);
    });
    return upcoming.filter((schedule) => !presented.has(String(schedule.id || '')));
}

function markAttendanceReminderPresented(schedules) {
    const presented = attendanceReminderPresentationSet();
    if (!presented) return;
    (schedules || []).forEach((schedule) => presented.add(String(schedule.id || '')));
}

function reminderBodyHtml(schedules) {
    return `<p>7日以内の練習予定について出欠を登録してください。</p>${schedules.map((schedule) => `<div class="info-block"><strong>${escapeHtml(formatScheduleDate(schedule.date))} ${escapeHtml(scheduleTimeLabel(schedule) || '')}</strong><div class="small text-muted">${escapeHtml(schedule.venue || '')}</div>${attendanceFormHtml(schedule, null, 'reminder')}</div>`).join('')}`;
}

function bindReminderForms(dialog) {
    bindAttendanceForms(dialog, async () => {
        const remaining = upcomingUnregisteredSchedules();
        if (!remaining.length) { dialog.remove(); return; }
        const body = dialog.querySelector('.card-body');
        if (body) body.innerHTML = reminderBodyHtml(remaining);
        bindReminderForms(dialog);
    });
}

function showUpcomingAttendanceReminder() {
    const schedules = unpresentedUpcomingAttendanceSchedules();
    if (!schedules.length) return;
    markAttendanceReminderPresented(schedules);
    document.getElementById('attendanceReminderDialog')?.remove();
    const dialog = document.createElement('div');
    dialog.id = 'attendanceReminderDialog';
    dialog.className = 'position-fixed top-0 start-0 w-100 h-100 d-flex align-items-center justify-content-center p-3';
    dialog.style.cssText = 'z-index:1080;background:rgba(0,0,0,.45);overflow-y:auto;';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', '出欠登録のお願い');
    dialog.innerHTML = `<div class="card w-100" style="max-width:720px;max-height:calc(100vh - 2rem);overflow-y:auto;"><div class="card-header d-flex justify-content-between align-items-center"><strong>出欠登録のお願い</strong><button class="btn-close" type="button" aria-label="閉じる" data-attendance-reminder-close></button></div><div class="card-body">${reminderBodyHtml(schedules)}</div></div>`;
    dialog.querySelector('[data-attendance-reminder-close]')?.addEventListener('click', () => dialog.remove());
    bindReminderForms(dialog);
    document.body.appendChild(dialog);
}
