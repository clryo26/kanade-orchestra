// This file was split from main.js during frontend refactor.
// It depends on shared globals declared in main.js (appState, $, request, helpers).

var appState = window.portalRuntimeContext.appState;
var $ = window.portalRuntimeContext.getById;

async function saveSchedule() {
    const startTime = $('schedStartTime').value;
    const endTime = $('schedEndTime').value;
    const availableStartTime = $('schedAvailableStartTime').value;
    const availableEndTime = $('schedAvailableEndTime').value;
    const selectedPerformance = selectedSchedulePerformance();
    const payload = {
        date: $('schedDate').value,
        time: formatTimeRange(startTime, endTime),
        start_time: startTime,
        end_time: endTime,
        venue: $('schedVenue').value.trim(),
        available_hours: formatTimeRange(availableStartTime, availableEndTime),
        available_start_time: availableStartTime,
        available_end_time: availableEndTime,
        performance_id: selectedPerformance ? selectedPerformance.id : null,
        performance_title: selectedPerformance ? selectedPerformance.title : '未定',
        pieces: selectedSchedulePiecesValue(),
        is_conductor_training: $('schedConductorTraining') ? $('schedConductorTraining').checked : false,
        is_main_performance: $('schedMainPerformance') ? $('schedMainPerformance').checked : false,
        notes: $('schedNotes').value.trim()
    };
    if (!payload.date || !payload.start_time || !payload.end_time) {
        showAlert('練習日と開始時間を入力してください', 'warning');
        return;
    }

    const id = $('schedId').value;
    await request(id ? `/api/schedules/${id}` : '/api/schedules', jsonOptions(id ? 'PUT' : 'POST', payload));
    clearScheduleForm();
    await loadSchedules();
    showAlert('練習予定を保存しました', 'success');
}


function selectSchedule(id) {
    const item = appState.schedules.find((sched) => sched.id === id);
    if (!item) return;
    $('schedId').value = item.id;
    $('schedDate').value = item.date || window.portalRuntimeContext.today();
    const practiceRange = splitTimeRange(item.time);
    const availableRange = splitTimeRange(item.available_hours);
    $('schedStartTime').value = formatClockTime(item.start_time || practiceRange.start || '13:00');
    $('schedEndTime').value = formatClockTime(item.end_time || practiceRange.end || '16:30');
    if ($('schedVenue')) $('schedVenue').innerHTML = venueSelectOptionsHtml('practice', item.venue || '');
    $('schedVenue').value = item.venue || '';
    $('schedAvailableStartTime').value = formatClockTime(item.available_start_time || availableRange.start || '12:30');
    $('schedAvailableEndTime').value = formatClockTime(item.available_end_time || availableRange.end || '16:30');
    $('schedPerformance').value = item.performance_id ? String(item.performance_id) : '';
    updateSchedulePieceOptions(item.pieces || '未定');
    if ($('schedConductorTraining')) $('schedConductorTraining').checked = Boolean(item.is_conductor_training);
    if ($('schedMainPerformance')) $('schedMainPerformance').checked = Boolean(item.is_main_performance);
    $('schedNotes').value = item.notes || '';
    $('scheduleTab')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
}


async function deleteSchedule() {
    const id = $('schedId').value;
    if (!id) {
        showAlert('削除する練習予定を一覧から選択してください', 'warning');
        return;
    }
    if (!confirmDelete()) return;
    await request(`/api/schedules/${id}`, { method: 'DELETE' });
    clearScheduleForm();
    await loadSchedules();
    showAlert('練習予定を削除しました', 'success');
}


function clearScheduleForm() {
    $('schedId').value = '';
    $('schedDate').value = window.portalRuntimeContext.today();
    $('schedStartTime').value = '13:00';
    $('schedEndTime').value = '16:30';
    if ($('schedVenue')) $('schedVenue').innerHTML = venueSelectOptionsHtml('practice', '');
    $('schedVenue').value = '';
    $('schedAvailableStartTime').value = '12:30';
    $('schedAvailableEndTime').value = '16:30';
    $('schedPerformance').value = '';
    updateSchedulePieceOptions('未定');
    if ($('schedConductorTraining')) $('schedConductorTraining').checked = false;
    if ($('schedMainPerformance')) $('schedMainPerformance').checked = false;
    $('schedNotes').value = '';
}


function selectedSchedulePerformance() {
    const value = $('schedPerformance').value;
    if (!value) return null;
    return appState.performances.find((perf) => String(perf.id) === value) || null;
}


function renderSchedulePerformanceOptions() {
    const select = $('schedPerformance');
    if (!select) return;
    const current = select.value;
    select.innerHTML = '<option value="">未定</option>' + appState.performances.map((perf) =>
        `<option value="${escapeHtml(perf.id)}">${escapeHtml(perf.title)}</option>`
    ).join('');
    if ([...select.options].some((option) => option.value === current)) {
        select.value = current;
    }
}


function schedulePieceValuesFromText(value) {
    const text = String(value || '').trim();
    if (!text || text === '未定') return [];
    return text.split(/[、,\n]/).map((item) => item.trim()).filter(Boolean);
}


function selectedSchedulePiecesValue() {
    const container = $('schedPieces');
    if (!container) return '未定';
    const values = Array.from(container.querySelectorAll('input[type="checkbox"]:checked'))
        .map((input) => input.value)
        .filter(Boolean);
    return values.length ? values.join('、') : '未定';
}


function updateSchedulePieceOptions(preferredValue = null) {
    const container = $('schedPieces');
    if (!container) return;
    const currentValues = schedulePieceValuesFromText(preferredValue ?? selectedSchedulePiecesValue());
    const performance = selectedSchedulePerformance();
    const performancePieces = performance ? normalizePerformancePieces(performance.pieces || []).map(performancePieceLabel) : [];
    const values = performancePieces.filter((value, index, array) => value && array.indexOf(value) === index);
    if (!values.length) {
        container.innerHTML = '<p class="text-muted small mb-0">選択中の演奏会に登録されている曲がありません。未選択の場合は「未定」になります。</p>';
        return;
    }
    container.innerHTML = values.map((value, index) => {
        const checked = currentValues.includes(value) ? ' checked' : '';
        const id = `schedPieceCheck${index}`;
        return `<label class="form-check mb-1" for="${id}"><input class="form-check-input" type="checkbox" id="${id}" value="${escapeHtml(value)}"${checked}><span class="form-check-label">${escapeHtml(value)}</span></label>`;
    }).join('');
}


function googleCalendarUrlForSchedule(sched) {
    const startTime = scheduleCalendarStartTime(sched);
    const endTime = scheduleCalendarEndTime(sched, startTime);
    const dates = startTime
        ? `${compactCalendarDate(sched.date, startTime)}/${compactCalendarDate(sched.date, endTime || startTime)}`
        : `${compactCalendarDate(sched.date)}/${compactCalendarDate(nextAllDayDate(sched.date))}`;
    const params = new URLSearchParams({
        action: 'TEMPLATE',
        text: scheduleCalendarTitle(sched),
        dates,
        ctz: 'Asia/Tokyo',
        location: sched.venue || '',
        details: scheduleCalendarDetails(sched)
    });
    return `https://calendar.google.com/calendar/render?${params.toString()}`;
}


function openGoogleCalendarForSchedule(scheduleId) {
    const sched = appState.schedules.find((item) => String(item.id) === String(scheduleId));
    if (!sched) return;
    window.open(googleCalendarUrlForSchedule(sched), '_blank', 'noopener');
}


function downloadSchedulesIcs(schedules) {
    const targets = sortedSchedules(schedules).filter((sched) => sched.date);
    if (!targets.length) {
        showAlert('連携できる練習予定がありません', 'warning');
        return;
    }
    const content = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Kanade Orchestra Portal//Schedule//JA',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        'X-WR-TIMEZONE:Asia/Tokyo',
        ...targets.map(scheduleToIcsEvent),
        'END:VCALENDAR'
    ].join('\r\n');
    downloadTextFile('奏オケ練習予定.ics', content, 'text/calendar;charset=utf-8');
    showAlert('練習予定の一括連携ファイルを作成しました。Googleカレンダーのインポートで読み込めます', 'success');
}

// async function saveAnnouncement() moved to modules/announcements.js.

// async function saveEvent() moved to modules/events.js.


function scheduleTimeLabel(sched) {
    return formatTimeRange(sched.start_time, sched.end_time) || formatTimeRange(splitTimeRange(sched.time).start, splitTimeRange(sched.time).end) || formatClockTime(sched.time);
}


function scheduleAvailableLabel(sched) {
    return formatTimeRange(sched.available_start_time, sched.available_end_time) || formatTimeRange(splitTimeRange(sched.available_hours).start, splitTimeRange(sched.available_hours).end) || formatClockTime(sched.available_hours);
}


function scheduleCalendarTitle(sched) {
    const kind = scheduleIsMainPerformance(sched) ? '本番' : '練習';
    return `${orgShortName()}　${kind}`;
}


function scheduleCalendarStartTime(sched) {
    return formatClockTime(sched.start_time || splitTimeRange(sched.time).start);
}


function scheduleCalendarEndTime(sched, startTime = scheduleCalendarStartTime(sched)) {
    const explicitEndTime = formatClockTime(sched.end_time || splitTimeRange(sched.time).end);
    return explicitEndTime || addHoursToTime(startTime, 2);
}


function scheduleCalendarDetails(sched) {
    return [
        `演奏会: ${schedulePerformanceLabel(sched)}`,
        `練習曲: ${sched.pieces || '未定'}`,
        `練習可能時間: ${scheduleAvailableLabel(sched) || '未定'}`,
        `備考: ${sched.notes || 'なし'}`
    ].join('\n');
}


function scheduleToIcsEvent(sched) {
    const startTime = scheduleCalendarStartTime(sched);
    const endTime = scheduleCalendarEndTime(sched, startTime);
    const allDay = !startTime;
    const startKey = allDay ? 'DTSTART;VALUE=DATE' : 'DTSTART;TZID=Asia/Tokyo';
    const endKey = allDay ? 'DTEND;VALUE=DATE' : 'DTEND;TZID=Asia/Tokyo';
    const startValue = allDay ? icsDateTime(sched.date) : icsDateTime(sched.date, startTime);
    const endValue = allDay ? icsDateTime(nextAllDayDate(sched.date)) : icsDateTime(sched.date, endTime || startTime);
    return [
        'BEGIN:VEVENT',
        `UID:kanade-schedule-${sched.id || `${sched.date}-${sched.venue}`}@kanade-portal`,
        `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}`,
        `${startKey}:${startValue}`,
        `${endKey}:${endValue}`,
        `SUMMARY:${icsEscape(scheduleCalendarTitle(sched))}`,
        `LOCATION:${icsEscape(sched.venue || '')}`,
        `DESCRIPTION:${icsEscape(scheduleCalendarDetails(sched))}`,
        'END:VEVENT'
    ].join('\r\n');
}

// downloadSchedulesIcs moved to feature module.


function renderSchedules() {
    const container = $('schedListItems');
    if (!appState.schedules.length) {
        container.innerHTML = '<p class="text-muted mb-0">練習予定はまだありません</p>';
        if (!appState.suppressDerivedRender) renderMemberSchedules();
        return;
    }
    container.innerHTML = `
        <div class="table-responsive">
            <table class="table table-sm align-middle">
                <thead><tr><th>日付</th><th>時間</th><th>場所</th><th>演奏会</th><th>曲</th><th>備考</th></tr></thead>
                <tbody></tbody>
            </table>
        </div>
    `;
    const body = container.querySelector('tbody');
    sortedSchedules(appState.schedules).forEach((sched) => {
        const row = document.createElement('tr');
        row.className = 'clickable-row';
        row.innerHTML = `
            <td>${escapeHtml(formatDateWithWeekday(sched.date))}</td>
            <td>${escapeHtml(scheduleTimeLabel(sched))}</td>
            <td>${escapeHtml(sched.venue || '')}</td>
            <td>${escapeHtml(schedulePerformanceLabel(sched))}</td>
            <td>${escapeHtml(sched.pieces || '')}</td>
            <td>${escapeHtml(sched.notes || '')}</td>
        `;
        row.addEventListener('click', () => selectSchedule(sched.id));
        body.appendChild(row);
    });
    if (!appState.suppressDerivedRender) renderMemberSchedules();
}

// function renderAnnouncements() moved to modules/announcements.js.


function renderMemberSchedules() {
    const container = $('memberSchedInfo');
    const upcoming = sortedSchedules(appState.schedules).filter((sched) => !sched.date || sched.date >= window.portalRuntimeContext.today());
    if (!upcoming.length) {
        container.innerHTML = '<p class="text-muted mb-0">練習予定はまだありません</p>';
        return;
    }
    const grouped = groupSchedulesByPerformance(upcoming);
    container.innerHTML = `
        <div class="d-flex flex-wrap justify-content-end gap-2 mb-3">
            <button class="btn btn-outline-success btn-sm" id="scheduleBulkCalendarBtn" type="button">予定を一括連携</button>
        </div>
        ${grouped.map((group) => `
        <details class="schedule-performance-group" open>
            <summary class="schedule-performance-summary">
                <span class="schedule-performance-title">${escapeHtml(group.title)}</span>
            </summary>
            ${group.schedules.map((sched) => `
                <article class="info-block schedule-card ${scheduleIsMainPerformance(sched) ? 'schedule-card-main-performance' : ''}">
                    <div class="schedule-main-line schedule-date-line">
                        <span>${escapeHtml(formatScheduleDate(sched.date))}</span>
                        ${scheduleIsConductorTraining(sched) ? '<span class="schedule-conductor-training">※指揮トレ</span>' : ''}
                    </div>
                    <div class="schedule-main-line">${escapeHtml(scheduleTimeLabel(sched) || '時間未定')}</div>
                    <div class="schedule-main-line">${escapeHtml(sched.venue || '場所未定')}</div>
                    <div class="schedule-detail-line">練習可能時間: ${escapeHtml(scheduleAvailableLabel(sched) || '未定')}</div>
                    <div class="schedule-detail-line">練習曲: ${escapeHtml(sched.pieces || '未定')}</div>
                    <div class="schedule-detail-line multiline-text">備考: ${escapeHtml(sched.notes || 'なし')}</div>
                    <div class="schedule-action-row">
                        <button class="btn btn-outline-success btn-sm" type="button" data-google-calendar="${escapeHtml(String(sched.id))}">Googleカレンダー連携</button>
                    </div>
                </article>
            `).join('')}
        </details>
    `).join('')}
    `;
    $('scheduleBulkCalendarBtn')?.addEventListener('click', () => downloadSchedulesIcs(upcoming));
    container.querySelectorAll('[data-google-calendar]').forEach((button) => {
        button.addEventListener('click', () => openGoogleCalendarForSchedule(button.dataset.googleCalendar));
    });
}


function sortedSchedules(schedules) {
    return [...(schedules || [])].sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')) || String(scheduleTimeLabel(a)).localeCompare(String(scheduleTimeLabel(b))));
}


function groupSchedulesByPerformance(schedules) {
    const groups = new Map();
    schedules.forEach((sched) => {
        const key = sched.performance_id ? `performance-${sched.performance_id}` : `title-${schedulePerformanceLabel(sched)}`;
        if (!groups.has(key)) {
            const performance = appState.performances.find((perf) => String(perf.id) === String(sched.performance_id));
            groups.set(key, {
                title: performance ? performance.title : schedulePerformanceLabel(sched),
                performanceId: performance?.id || sched.performance_id || null,
                date: performance?.date || '',
                schedules: []
            });
        }
        groups.get(key).schedules.push(sched);
    });
    return Array.from(groups.values())
        .sort(compareSchedulePerformanceGroups)
        .map((group) => ({
            ...group,
            schedules: sortedSchedules(group.schedules)
        }));
}


function compareSchedulePerformanceGroups(a, b) {
    const aUndecided = schedulePerformanceGroupIsUndecided(a);
    const bUndecided = schedulePerformanceGroupIsUndecided(b);
    if (aUndecided !== bUndecided) return aUndecided ? 1 : -1;

    const aHasDate = Boolean(a.date);
    const bHasDate = Boolean(b.date);
    if (aHasDate !== bHasDate) return aHasDate ? -1 : 1;

    return String(a.date || '').localeCompare(String(b.date || ''))
        || String(a.title || '').localeCompare(String(b.title || ''));
}


function schedulePerformanceGroupIsUndecided(group) {
    return !group.performanceId && (!group.title || group.title === '未定');
}


function schedulePerformance(sched) {
    if (!sched || !sched.performance_id) return null;
    return appState.performances.find((perf) => String(perf.id) === String(sched.performance_id)) || null;
}


function scheduleIsConductorTraining(sched) {
    return Boolean(sched?.is_conductor_training);
}


function scheduleIsMainPerformance(sched) {
    return Boolean(sched?.is_main_performance);
}


function schedulePerformanceLabel(sched) {
    if (sched.performance_title) return sched.performance_title;
    if (sched.performance_id) {
        const performance = appState.performances.find((perf) => String(perf.id) === String(sched.performance_id));
        if (performance) return performance.title;
    }
    return '未定';
}


function formatScheduleDate(dateText) {
    return formatDateWithWeekday(dateText);
}


function scheduleOptions(selected = '') {
    return ['<option value="">選択してください</option>'].concat(sortedSchedules(appState.schedules).map((s) => `<option value="${escapeHtml(String(s.id))}" ${String(s.id) === String(selected) ? 'selected' : ''}>${escapeHtml(formatDateWithWeekday(s.date))} ${escapeHtml(scheduleTimeLabel(s))} ${escapeHtml(s.venue || '')}</option>`)).join('');
}

// renderAbsenceView moved to feature module.

// absenceBelongsToCurrentUser moved to feature module.

// selectOwnAbsence moved to feature module.

// deleteOwnAbsence moved to feature module.

// absenceStatusLabel moved to feature module.

// absenceEntryLabel moved to feature module.

