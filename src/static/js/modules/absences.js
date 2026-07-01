// This file was split from main.js during frontend refactor.
// It depends on shared globals declared in main.js (appState, $, request, helpers).

var appState = window.portalRuntimeContext.appState;
var $ = window.portalRuntimeContext.getById;

function renderAbsenceView() {
    const container = $('memberAbsenceInfo');
    if (!container) return;
    const currentName = currentUserMemberName();
    if (!currentName) {
        container.innerHTML = '<p class="text-muted mb-0">ログイン中の団員情報が見つかりません</p>';
        return;
    }
    const visibleSchedules = sortedSchedules(appState.schedules).filter((schedule) => !schedule?.date || String(schedule.date) >= window.portalRuntimeContext.today());
    const visibleScheduleIds = new Set(visibleSchedules.map((schedule) => String(schedule.id || '')));
    const grouped = groupBy(appState.absences.filter((absence) => visibleScheduleIds.has(String(absence.schedule_id || ''))), 'schedule_id');
    const absenceScheduleOptions = ['<option value="">選択してください</option>'].concat(visibleSchedules.map((s) => `<option value="${escapeHtml(String(s.id))}">${escapeHtml(formatDateWithWeekday(s.date))} ${escapeHtml(scheduleTimeLabel(s))} ${escapeHtml(s.venue || '')}</option>`)).join('');
    container.innerHTML = `
        <input type="hidden" id="absenceId">
        <div class="row g-2 align-items-end mb-3">
            <div class="col-md-5"><label class="form-label">練習日</label><select id="absenceScheduleId" class="form-select">${absenceScheduleOptions}</select></div>
            <div class="col-md-2"><label class="form-label">連絡区分</label><select id="absenceStatus" class="form-select"><option value="absent">欠席</option><option value="late">遅刻</option><option value="leave_early">早退</option></select></div>
            <div class="col-md-2"><label class="form-label" id="absenceTimeLabel" for="absenceTime">予定時刻</label><input id="absenceTime" class="form-control" type="time" disabled></div>
            <div class="col-md-3"><button class="btn btn-primary w-100" id="absenceSaveBtn" type="button">連絡を保存</button></div>
        </div>
        <div class="d-flex flex-wrap gap-2 mb-3">
            <button class="btn btn-outline-secondary btn-sm" id="absenceClearBtn" type="button">入力をクリア</button>
            <button class="btn btn-outline-danger btn-sm" id="absenceDeleteBtn" type="button" disabled>選択中の連絡を削除</button>
        </div>
        <h6>練習日ごとの出欠連絡</h6>
        ${visibleSchedules.map((schedule) => {
            const abs = (grouped[String(schedule.id)] || grouped[schedule.id] || []);
            const rows = abs.length ? abs.map((absence) => {
                const own = absenceBelongsToCurrentUser(absence);
                return `<div class="absence-row d-flex flex-wrap justify-content-between align-items-center gap-2 py-1">
                    <span>${escapeHtml(absenceEntryLabel(absence))}</span>
                    ${own ? `<span class="d-flex gap-2"><button class="btn btn-sm btn-outline-primary absence-edit-btn" type="button" data-absence-id="${escapeHtml(String(absence.id || ''))}">編集</button><button class="btn btn-sm btn-outline-danger absence-delete-btn" type="button" data-absence-id="${escapeHtml(String(absence.id || ''))}">削除</button></span>` : ''}
                </div>`;
            }).join('') : '出欠連絡なし';
            return `<div class="info-block"><strong>${escapeHtml(formatDateWithWeekday(schedule.date))} ${escapeHtml(scheduleTimeLabel(schedule))}</strong><div class="small text-muted">${escapeHtml(schedule.venue || '')}</div><div class="mt-1">${rows}</div></div>`;
        }).join('')}
    `;
    const updateAbsenceTimeState = () => {
        const status = $('absenceStatus').value;
        const timeInput = $('absenceTime');
        const label = $('absenceTimeLabel');
        const needsTime = status === 'late' || status === 'leave_early';
        timeInput.disabled = !needsTime;
        if (!needsTime) timeInput.value = '';
        label.textContent = status === 'late' ? '到着予定時刻' : status === 'leave_early' ? '退出予定時刻' : '予定時刻';
    };
    $('absenceStatus').addEventListener('change', updateAbsenceTimeState);
    updateAbsenceTimeState();
    const setSelectedAbsenceId = (id = '') => { $('absenceId').value = id; $('absenceDeleteBtn').disabled = !id; };
    $('absenceClearBtn').addEventListener('click', () => {
        setSelectedAbsenceId(''); $('absenceScheduleId').value = ''; $('absenceStatus').value = 'absent'; $('absenceTime').value = ''; updateAbsenceTimeState();
    });
    $('absenceDeleteBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', () => deleteOwnAbsence($('absenceId').value)));
    container.querySelectorAll('.absence-edit-btn').forEach((button) => button.addEventListener('click', () => selectOwnAbsence(button.dataset.absenceId || '')));
    container.querySelectorAll('.absence-delete-btn').forEach((button) => button.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', () => deleteOwnAbsence(button.dataset.absenceId || ''))));
    $('absenceSaveBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '登録中...', async () => {
        const name = currentUserMemberName(); const absenceId = $('absenceId').value; const scheduleId = $('absenceScheduleId').value; const status = $('absenceStatus').value; const plannedTime = $('absenceTime').value;
        if (!name || !scheduleId) { showAlert('練習日を選択してください', 'warning'); return; }
        if ((status === 'late' || status === 'leave_early') && !plannedTime) { showAlert('予定時刻を入力してください', 'warning'); return; }
        const sched = appState.schedules.find((s) => String(s.id) === String(scheduleId));
        const payload = { name, member_id: appState.currentUserMemberId, schedule_id: scheduleId, schedule_date: sched ? sched.date : '', status, planned_time: plannedTime };
        const existing = appState.absences.find((item) => String(item.schedule_id || '') === String(scheduleId) && (String(item.member_id || '') === String(appState.currentUserMemberId || '') || item.name === name));
        const saveId = absenceId || existing?.id || '';
        if (saveId) await request(`/api/extra/absences/${encodeURIComponent(saveId)}`, jsonOptions('PUT', payload)); else await saveExtra('absences', payload);
        showAlert('出欠連絡を登録しました', 'success'); await loadExtraData();
    }));
}


function absenceBelongsToCurrentUser(absence) {
    const currentId = String(appState.currentUserMemberId || '');
    const currentName = currentUserMemberName();
    return (currentId && String(absence?.member_id || '') === currentId) || (currentName && absence?.name === currentName);
}


function selectOwnAbsence(absenceId) {
    const absence = appState.absences.find((item) => String(item.id || '') === String(absenceId));
    if (!absence || !absenceBelongsToCurrentUser(absence)) return;
    $('absenceId').value = absence.id || '';
    $('absenceScheduleId').value = String(absence.schedule_id || '');
    $('absenceStatus').value = absence.status || 'absent';
    $('absenceTime').value = absence.planned_time || '';
    $('absenceDeleteBtn').disabled = false;
    $('absenceStatus').dispatchEvent(new Event('change'));
}


async function deleteOwnAbsence(absenceId) {
    if (!absenceId) return;
    const absence = appState.absences.find((item) => String(item.id || '') === String(absenceId));
    if (!absence || !absenceBelongsToCurrentUser(absence)) {
        showAlert('削除できる出欠連絡が見つかりません', 'warning');
        return;
    }
    if (!confirmDelete()) return;
    await request(`/api/extra/absences/${encodeURIComponent(absenceId)}`, { method: 'DELETE' });
    showAlert('出欠連絡を削除しました', 'success');
    await loadExtraData();
}


function absenceStatusLabel(absence) {
    const status = absence?.status || 'absent';
    if (status === 'late') return '遅刻';
    if (status === 'leave_early') return '早退';
    return '欠席';
}


function absenceEntryLabel(absence, includeName = true) {
    const time = absence?.planned_time ? ` ${absence.planned_time}` : '';
    const status = `${absenceStatusLabel(absence)}${time}`;
    return includeName ? `${absence?.name || ''}（${status}）` : status;
}

