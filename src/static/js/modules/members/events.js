// Member event views split from modules/members.js.
// Keep global names for compatibility with legacy non-module loading.

var appState = window.portalRuntimeContext.appState;
var $ = window.portalRuntimeContext.getById;

function renderMemberEventView() {
    const c = $('memberEventInfo'); if (!c) return;
    c.innerHTML = `
        <div id="memberEventListView">
            <h6>イベント一覧</h6>
            <div class="list-group mb-3" id="memberEventList"></div>
            <h6>イベント登録</h6>
            <div class="row g-2 mb-3">
                <div class="col-md-4"><label class="form-label">イベント名</label><input id="memberEventTitle" class="form-control"></div>
                <div class="col-md-3"><label class="form-label">開催日</label><input id="memberEventDate" type="date" class="form-control"></div>
                <div class="col-md-2"><label class="form-label">開始時刻</label><input id="memberEventStartTime" type="time" class="form-control"></div>
                <div class="col-md-3"><label class="form-label">回答期限</label><input id="memberEventDeadline" type="date" class="form-control"></div>
                <div class="col-md-6"><label class="form-label">会費</label><input id="memberEventFee" class="form-control" placeholder="例: 4,000円"></div>
                <div class="col-12"><label class="form-label">イベント概要/備考</label><textarea id="memberEventNotes" class="form-control" rows="3"></textarea></div>
                <div class="col-md-6"><label class="form-label">削除時の合言葉</label><input id="memberEventDeletePhrase" class="form-control"></div>
                <div class="col-md-3 d-flex align-items-end"><button id="memberEventCreateBtn" class="btn btn-primary w-100" type="button">イベント登録</button></div>
            </div>
        </div>
        <div id="memberEventDetailView" hidden></div>`;
    $('memberEventDate').value = window.portalRuntimeContext.today();
    $('memberEventDeadline').value = window.portalRuntimeContext.today();
    $('memberEventCreateBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '作成中...', async () => {
        const payload = {
            title: $('memberEventTitle').value.trim(),
            date: $('memberEventDate').value,
            start_time: $('memberEventStartTime').value,
            deadline: $('memberEventDeadline').value,
            notes: $('memberEventNotes').value.trim(),
            delete_phrase: $('memberEventDeletePhrase').value.trim(),
            fee: $('memberEventFee') ? $('memberEventFee').value.trim() : '',
            url: '',
        };
        if (!payload.title || !payload.date || !payload.start_time || !payload.deadline || !payload.delete_phrase) {
            showAlert('イベント名、開催日、開始時刻、回答期限、削除時の合言葉を入力してください', 'warning');
            return;
        }
        await request('/api/events', jsonOptions('POST', payload));
        showAlert('イベントを作成しました', 'success');
        await loadEvents(); await loadExtraData();
    }));
    renderMemberEventList();
}

function renderMemberEventList() {
    const list = $('memberEventList');
    if (!list) return;
    const events = sortedEvents(appState.events);
    list.innerHTML = events.length ? '' : '<p class="text-muted mb-0">イベントはまだありません</p>';
    events.forEach((event) => {
        const item = document.createElement('button');
        item.className = 'list-group-item list-group-item-action text-start';
        item.type = 'button';
        const responseCount = uniqueEventResponses(appState.eventResponses.filter((r) => String(r.event_id) === String(event.id))).length;
        item.innerHTML = `
            <strong>${escapeHtml(event.title)}</strong>
            <div class="small text-muted">開催: ${escapeHtml(eventDateTimeLabel(event))} / 回答期限: ${escapeHtml(formatDateWithWeekday(event.deadline))}${event.fee ? ` / 会費: ${escapeHtml(event.fee)}` : ''}</div>
            ${event.notes ? `<div class="small multiline-text mt-1">${escapeHtml(event.notes)}</div>` : ''}
            <div class="small text-muted mt-1">回答数: ${responseCount}</div>
        `;
        item.addEventListener('click', () => renderMemberEventDetail(event.id));
        list.appendChild(item);
    });
}

function renderMemberEventDetail(id) {
    const listView = $('memberEventListView');
    const detailView = $('memberEventDetailView');
    const event = appState.events.find((item) => String(item.id) === String(id));
    if (!listView || !detailView || !event) return;
    listView.hidden = true;
    detailView.hidden = false;
    const responses = appState.eventResponses.filter((r) => String(r.event_id) === String(id));
    const groupedResponsesHtml = renderGroupedEventResponses(responses);
    detailView.innerHTML = `
        <button class="btn btn-sm btn-outline-secondary mb-3" id="memberEventBackBtn" type="button">イベント一覧に戻る</button>
        <section class="info-block pt-0">
            <h5>${escapeHtml(event.title)}</h5>
            <div>開催: ${escapeHtml(eventDateTimeLabel(event))}</div>
            <div>回答期限: ${escapeHtml(formatDateWithWeekday(event.deadline))}${event.fee ? ` / 会費: ${escapeHtml(event.fee)}` : ''}</div>
            ${event.notes ? `<div class="multiline-text mt-2">${escapeHtml(event.notes)}</div>` : ''}
        </section>
        <div class="row g-2 align-items-end mb-3">
            <div class="col-md-7"><label class="form-label">参加/不参加</label><select id="eventResponseStatus" class="form-select"><option>参加</option><option>不参加</option></select></div>
            <div class="col-md-3"><button id="eventResponseSaveBtn" class="btn btn-primary w-100" type="button">登録</button></div>
        </div>
        <div class="d-flex flex-wrap gap-2 mb-3">
            <button class="btn btn-outline-danger" id="memberEventDeleteBtn" type="button">イベント削除</button>
        </div>
        <h6>回答状況</h6>
        ${groupedResponsesHtml}
    `;
    $('memberEventBackBtn').addEventListener('click', () => {
        detailView.hidden = true;
        listView.hidden = false;
        renderMemberEventList();
    });
    $('eventResponseSaveBtn').addEventListener('click', (eventNode) => withButtonStatus(eventNode.currentTarget, '登録中...', async () => {
        const name = currentUserMemberName(); const status = $('eventResponseStatus').value;
        if (!name) { showAlert('ログイン中の団員情報が見つかりません', 'warning'); return; }
        const existingResponses = appState.eventResponses.filter((r) => String(r.event_id) === String(id) && String(r.name || '') === String(name));
        const existing = existingResponses[0];
        const payload = { event_id: id, name, status };
        if (existing?.id) {
            await request(`/api/extra/event_responses/${existing.id}`, jsonOptions('PUT', payload));
            await Promise.all(existingResponses.slice(1).filter((r) => r.id).map((r) => request(`/api/extra/event_responses/${r.id}`, { method: 'DELETE' })));
            showAlert('イベント出欠を上書きしました', 'success');
        } else {
            await saveExtra('event_responses', payload);
            showAlert('イベント出欠を登録しました', 'success');
        }
        await loadExtraData();
        renderMemberEventDetail(id);
    }));
    $('memberEventDeleteBtn').addEventListener('click', (clickEvent) => withButtonStatus(clickEvent.currentTarget, '削除中...', async () => {
        const phrase = prompt('削除時の合言葉を入力してください');
        if (phrase === null) return;
        if (phrase !== (event.delete_phrase || '')) {
            showAlert('削除時の合言葉が違います', 'danger');
            return;
        }
        if (!confirmDelete()) return;
        await deleteEventById(id, false);
        renderMemberEventView();
    }));
}