// Event adjustment module.

var appState = window.portalRuntimeContext.appState;
var $ = window.portalRuntimeContext.getById;

function canDeleteEventForCurrentUser(event) {
    const creatorId = String(event?.created_by_member_id || '').trim();
    if (!creatorId) return false;
    return creatorId === String(appState.currentUserMemberId || '').trim();
}

async function saveEvent() {
    const payload = {
        title: $('eventTitle').value.trim(),
        date: $('eventDate').value,
        start_time: $('eventStartTime') ? $('eventStartTime').value : '',
        deadline: $('eventDeadline').value,
        url: $('eventUrl').value.trim(),
        notes: $('eventNotes').value.trim(),
        delete_phrase: $('eventDeletePhrase') ? $('eventDeletePhrase').value.trim() : '',
        fee: $('eventFee') ? $('eventFee').value.trim() : ''
    };
    if (!payload.title) {
        showAlert('イベント名を入力してください', 'warning');
        return;
    }

    const id = $('eventId').value;
    await request(id ? `/api/events/${id}` : '/api/events', jsonOptions(id ? 'PUT' : 'POST', payload));
    clearEventForm();
    await loadEvents();
    showAlert('イベント調整を保存しました', 'success');
}

function selectEvent(id) {
    const item = appState.events.find((event) => event.id === id);
    if (!item) return;
    $('eventId').value = item.id;
    $('eventTitle').value = item.title || '';
    $('eventDate').value = item.date || '';
    if ($('eventStartTime')) $('eventStartTime').value = item.start_time || '';
    $('eventDeadline').value = item.deadline || '';
    $('eventUrl').value = item.url || '';
    $('eventNotes').value = item.notes || '';
    if ($('eventDeletePhrase')) $('eventDeletePhrase').value = item.delete_phrase || '';
    if ($('eventFee')) $('eventFee').value = item.fee || '';
}

async function deleteEvent() {
    const id = $('eventId').value;
    if (!id) {
        showAlert('削除するイベントを一覧から選択してください', 'warning');
        return;
    }
    await deleteEventById(id, true);
}

async function deleteEventById(id, adminDelete = false) {
    if (adminDelete && !confirmDelete()) return;
    await request(`/api/events/${id}`, { method: 'DELETE' });
    clearEventForm();
    await loadEvents();
    await loadExtraData();
    showAlert('イベント調整を削除しました', 'success');
}

function clearEventForm() {
    $('eventId').value = '';
    $('eventTitle').value = '';
    $('eventDate').value = '';
    if ($('eventStartTime')) $('eventStartTime').value = '';
    $('eventDeadline').value = '';
    $('eventUrl').value = '';
    $('eventNotes').value = '';
    if ($('eventDeletePhrase')) $('eventDeletePhrase').value = '';
    if ($('eventFee')) $('eventFee').value = '';
}

function sortedEvents(events) {
    return [...(events || [])].sort((a, b) =>
        String(a.date || '').localeCompare(String(b.date || '')) ||
        String(a.start_time || '').localeCompare(String(b.start_time || '')) ||
        String(a.title || '').localeCompare(String(b.title || ''))
    );
}

function eventDateTimeLabel(event) {
    const date = formatDateWithWeekday(event?.date, '未定');
    return event?.start_time ? `${date} ${formatClockTime(event.start_time)}` : date;
}


function renderEvents() {
    const list = $('eventListItems');
    if (!list) return;
    list.innerHTML = emptyText(appState.events, 'イベント調整はまだありません');
    sortedEvents(appState.events).forEach((event) => {
        const item = document.createElement('div');
        item.className = 'list-group-item list-group-item-action';
        item.innerHTML = `
            <div class="d-flex flex-wrap justify-content-between gap-2">
                <span>
                    <strong>${escapeHtml(event.title)}</strong>
                    <div class="small text-muted">開催日: ${escapeHtml(eventDateTimeLabel(event))} / 回答期限: ${escapeHtml(formatDateWithWeekday(event.deadline))}${event.fee ? ` / 会費: ${escapeHtml(event.fee)}` : ''}</div>
                    <div class="small text-muted">削除時の合言葉: ${escapeHtml(event.delete_phrase || '未設定')}</div>
                </span>
                <span>${canDeleteEventForCurrentUser(event) ? '<button class="btn btn-sm btn-outline-danger admin-event-delete-btn" type="button">削除</button>' : ''}</span>
            </div>
            ${event.notes ? `<div class="small multiline-text mt-1">${escapeHtml(event.notes)}</div>` : ''}
            ${event.url ? `<div class="small text-truncate">${escapeHtml(event.url)}</div>` : ''}
        `;
        item.addEventListener('click', () => selectEvent(event.id));
        const deleteBtn = item.querySelector('.admin-event-delete-btn');
        if (deleteBtn) {
            deleteBtn.addEventListener('click', (clickEvent) => {
                clickEvent.preventDefault();
                clickEvent.stopPropagation();
                withButtonStatus(clickEvent.currentTarget, '削除中...', () => deleteEventById(event.id, true));
            });
        }
        list.appendChild(item);
    });
    if (!appState.suppressDerivedRender) renderMemberEventView();
}

