// Follow-up overrides for attendance UI.
// Loaded after absences.js so the existing storage/API behavior is preserved.

function attendanceFormHtml(schedule, existing, context = 'schedule') {
    const scheduleId = String(schedule?.id || '');
    const selectedStatus = existing?.status || '';
    const plannedTime = absencePlannedTimeLabel(existing?.planned_time);
    const formId = `attendance-${context}-${scheduleId}`;
    const saveLabel = existing ? '変更' : '登録';
    const statusInputHtml = ([value, label]) => `<label class="form-check form-check-inline mb-0" for="${escapeHtml(formId)}-${value}"><input class="form-check-input" type="radio" name="${escapeHtml(formId)}-status" id="${escapeHtml(formId)}-${value}" value="${value}"${selectedStatus === value ? ' checked' : ''}><span class="form-check-label">${label}</span></label>`;

    return `<section class="attendance-form mt-3 border-top pt-3" data-attendance-form data-attendance-schedule-id="${escapeHtml(scheduleId)}">
        <h6 class="mb-2">出欠登録</h6>
        <div class="attendance-status-layout" role="radiogroup" aria-label="${escapeHtml(formatScheduleDate(schedule.date))} の出欠">
            <div class="attendance-status-row attendance-status-row-primary">
                ${ATTENDANCE_STATUS_OPTIONS.slice(0, 2).map(statusInputHtml).join('')}
            </div>
            <div class="attendance-status-row attendance-status-row-secondary">
                ${ATTENDANCE_STATUS_OPTIONS.slice(2).map(statusInputHtml).join('')}
                <div class="attendance-time-inline" data-attendance-time-row${selectedStatus === 'late' || selectedStatus === 'leave_early' ? '' : ' hidden'}>
                    <label class="form-label mb-1" data-attendance-time-label for="${escapeHtml(formId)}-time">予定時刻</label>
                    <input class="form-control form-control-sm" data-attendance-time id="${escapeHtml(formId)}-time" type="time" value="${escapeHtml(plannedTime)}">
                </div>
            </div>
        </div>
        <div class="mt-2"><button class="btn btn-primary btn-sm" type="button" data-attendance-save>${saveLabel}</button></div>
    </section>`;
}

function bindAttendanceForms(container, afterSave = null) {
    container.querySelectorAll('[data-attendance-form]').forEach((form) => {
        form.querySelectorAll('input[type="radio"]').forEach((input) => input.addEventListener('change', () => syncAttendanceTimeInput(form)));
        form.querySelector('[data-attendance-save]')?.addEventListener('click', (event) => {
            const pendingLabel = event.currentTarget.textContent?.trim() === '変更' ? '変更中...' : '登録中...';
            void withButtonStatus(event.currentTarget, pendingLabel, async () => {
                await saveOwnAttendance(form);
                if (afterSave) await afterSave();
            });
        });
    });
}

function reminderBodyHtml(schedules) {
    return `<p>練習予定について、出欠の登録をお願いいたします。</p>${schedules.map((schedule) => `<div class="info-block"><strong>${escapeHtml(formatScheduleDate(schedule.date))} ${escapeHtml(scheduleTimeLabel(schedule) || '')}</strong><div class="small text-muted">${escapeHtml(schedule.venue || '')}</div>${attendanceFormHtml(schedule, null, 'reminder')}</div>`).join('')}`;
}

function attendanceOverviewSchedules() {
    const today = window.portalRuntimeContext.today();
    return sortedSchedules(appState.schedules || []).filter((schedule) => !schedule?.date || schedule.date >= today);
}

function attendanceMemberForResponse(response, members) {
    const memberId = String(response?.member_id || '');
    if (memberId) {
        const matchedById = (members || []).find((member) => String(member.id || '') === memberId);
        if (matchedById) return matchedById;
    }

    const responseName = String(response?.name || '');
    if (!responseName) return null;
    const matches = (members || []).filter((member) => memberDisplayName(member) === responseName);
    return matches.length === 1 ? matches[0] : null;
}

function attendancePersonFromMember(member, status = '') {
    const name = memberDisplayName(member);
    return {
        name,
        part: String(member?.part || '未分類'),
        sortName: String(memberKanaName(member) || name),
        status: String(status || ''),
    };
}

function attendancePersonFromResponse(response, members, includeStatus) {
    const member = attendanceMemberForResponse(response, members);
    const name = member ? memberDisplayName(member) : String(response?.name || '');
    return {
        name,
        part: String(member?.part || '未分類'),
        sortName: String(member ? (memberKanaName(member) || name) : name),
        status: includeStatus && ['late', 'leave_early'].includes(response?.status)
            ? attendanceEntryLabel(response, false)
            : '',
    };
}

function sortedAttendancePeople(people) {
    return [...(people || [])].sort((a, b) =>
        partSortIndex(a.part) - partSortIndex(b.part)
        || String(a.part || '').localeCompare(String(b.part || ''), 'ja')
        || String(a.sortName || a.name || '').localeCompare(String(b.sortName || b.name || ''), 'ja')
        || String(a.name || '').localeCompare(String(b.name || ''), 'ja')
    );
}

function attendancePeopleByPartHtml(people) {
    const sorted = sortedAttendancePeople(people);
    if (!sorted.length) return '<p class="text-muted small mb-0">該当者はいません</p>';

    const groups = new Map();
    sorted.forEach((person) => {
        const part = String(person.part || '未分類');
        if (!groups.has(part)) groups.set(part, []);
        groups.get(part).push(person);
    });

    return Array.from(groups.entries()).map(([part, rows]) => `
        <section class="attendance-part-group mb-3">
            <div class="fw-semibold border-bottom pb-1 mb-1">${escapeHtml(part)}</div>
            <div class="attendance-member-list">
                ${rows.map((person) => `<div class="attendance-member-row">${escapeHtml(person.name || '')}${person.status ? `<span class="text-muted ms-2">（${escapeHtml(person.status)}）</span>` : ''}</div>`).join('')}
            </div>
        </section>
    `).join('');
}

function bindAttendanceOverviewTabs(container) {
    container.querySelectorAll('[data-attendance-overview]').forEach((overview) => {
        const buttons = Array.from(overview.querySelectorAll('[data-attendance-overview-tab]'));
        const panels = Array.from(overview.querySelectorAll('[data-attendance-overview-panel]'));

        buttons.forEach((button) => button.addEventListener('click', () => {
            const target = button.dataset.attendanceOverviewTab || '';

            buttons.forEach((candidate) => {
                const active = candidate === button;
                candidate.classList.toggle('active', active);
                candidate.setAttribute('aria-selected', active ? 'true' : 'false');
            });

            panels.forEach((panel) => {
                panel.hidden = panel.dataset.attendanceOverviewPanel !== target;
            });
        }));
    });
}

function renderAbsenceView() {
    const container = $('memberAbsenceInfo');
    if (!container) return;

    const schedules = attendanceOverviewSchedules();
    if (!schedules.length) {
        container.innerHTML = '<p class="text-muted mb-0">今後の練習予定はありません</p>';
        return;
    }

    container.innerHTML = schedules.map((schedule) => attendanceOverviewHtml(schedule, appState.members || [])).join('');
    bindAttendanceOverviewTabs(container);
}

function attendanceOverviewHtml(schedule, members) {
    const responses = (appState.absences || []).filter((item) => String(item.schedule_id || '') === String(schedule.id || ''));
    const responseByMemberId = new Map(responses.filter((item) => item.member_id).map((item) => [String(item.member_id), item]));
    const responseNames = new Set(responses.filter((item) => !item.member_id).map((item) => String(item.name || '')));
    const present = responses.filter((item) => ['present', 'late', 'leave_early'].includes(item.status));
    const absent = responses.filter((item) => !['present', 'late', 'leave_early'].includes(item.status));

    // The public member list is the current eligibility source. Hidden system users are not included.
    const unregistered = (members || []).filter((member) =>
        !responseByMemberId.has(String(member.id || ''))
        && !responseNames.has(memberDisplayName(member))
    );

    const presentPeople = present.map((response) => attendancePersonFromResponse(response, members, true));
    const absentPeople = absent.map((response) => attendancePersonFromResponse(response, members, false));
    const unregisteredPeople = unregistered.map((member) => attendancePersonFromMember(member));

    return `<article class="info-block attendance-overview" data-attendance-overview>
        <div class="attendance-overview-tabs d-flex flex-wrap gap-2 mb-3" role="tablist" aria-label="出欠区分">
            <button class="btn btn-outline-primary btn-sm active" type="button" role="tab" aria-selected="true" data-attendance-overview-tab="present">出席 ${present.length}名</button>
            <button class="btn btn-outline-primary btn-sm" type="button" role="tab" aria-selected="false" data-attendance-overview-tab="absent">欠席 ${absent.length}名</button>
            <button class="btn btn-outline-primary btn-sm" type="button" role="tab" aria-selected="false" data-attendance-overview-tab="unregistered">未登録 ${unregistered.length}名</button>
        </div>
        <div data-attendance-overview-panel="present">${attendancePeopleByPartHtml(presentPeople)}</div>
        <div data-attendance-overview-panel="absent" hidden>${attendancePeopleByPartHtml(absentPeople)}</div>
        <div data-attendance-overview-panel="unregistered" hidden>${attendancePeopleByPartHtml(unregisteredPeople)}</div>
    </article>`;
}
