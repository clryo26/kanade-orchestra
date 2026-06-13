const appState = {
    selectedFile: null,
    selectedFiles: [],
    performancePieces: [],
    performancePieceEditIndex: null,
    performances: [],
    schedules: [],
    announcements: [],
    events: [],
    members: [],
    recordings: [],
    absences: [],
    eventResponses: [],
    sheetLibrary: [],
    payments: [],
    castings: [],
    pieceInfos: [],
    albums: []
};

const today = () => new Date().toISOString().slice(0, 10);
const $ = (id) => document.getElementById(id);
const SCHEDULE_EXTRA_PIECES = ['未定', 'ポップス全曲', 'クラシック全曲'];
const MEMBER_PARTS = ['Violin', 'Viola', 'Cello', 'Contrabass', 'Flute', 'Oboe', 'Clarinet', 'Fagot', 'Horn', 'Trumpet', 'Trombone', 'Tuba', 'Percussion', 'Piano'];

document.addEventListener('DOMContentLoaded', async () => {
    setDefaultDates();
    bindNavigation();
    bindUpload();
    bindForms();
    showMemberPanel();
    await loadAll();
    renderSchedulePerformanceOptions();
    updateSchedulePieceOptions();
    updateSavePath();
});

function setDefaultDates() {
    ['uploadDate', 'schedDate', 'annDate'].forEach((id) => {
        $(id).value = today();
    });
    $('perfDate').value = today();
}

function bindNavigation() {
    $('adminMenuBtn').addEventListener('click', requestAdminPanel);
    $('memberMenuBtn').addEventListener('click', showMemberPanel);
    if ($('backToPortalBtn')) $('backToPortalBtn').addEventListener('click', showMemberPanel);
    if ($('memberAdminMenuBtn')) $('memberAdminMenuBtn').addEventListener('click', requestAdminPanel);

    document.querySelectorAll('#adminPanel [data-tab]').forEach((button) => {
        button.addEventListener('click', () => switchTab('adminPanel', button.dataset.tab));
    });
    document.querySelectorAll('#memberPanel [data-tab]').forEach((button) => {
        button.addEventListener('click', () => switchTab('memberPanel', button.dataset.tab));
    });
}

function bindUpload() {
    const fileInput = $('fileInput');

    $('selectFileBtn').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (event) => handleFiles(event.target.files));
    $('uploadDate').addEventListener('input', updateSavePath);
    $('uploadPiece').addEventListener('input', updateSavePath);
    $('uploadBtn').addEventListener('click', uploadToLocalStore);
    $('clearBtn').addEventListener('click', clearUploadForm);
}

function bindForms() {
    $('addPerfBtn').addEventListener('click', savePerformance);
    $('editPerfBtn').addEventListener('click', clearPerformanceForm);
    $('deletePerfBtn').addEventListener('click', deletePerformance);
    $('addPieceBtn').addEventListener('click', addPerformancePiece);

    $('addSchedBtn').addEventListener('click', saveSchedule);
    $('editSchedBtn').addEventListener('click', clearScheduleForm);
    $('deleteSchedBtn').addEventListener('click', deleteSchedule);
    $('schedPerformance').addEventListener('change', updateSchedulePieceOptions);

    $('addAnnBtn').addEventListener('click', saveAnnouncement);
    $('editAnnBtn').addEventListener('click', clearAnnouncementForm);
    $('deleteAnnBtn').addEventListener('click', deleteAnnouncement);

    $('addEventBtn').addEventListener('click', saveEvent);
    $('clearEventBtn').addEventListener('click', clearEventForm);
    $('deleteEventBtn').addEventListener('click', deleteEvent);

    $('addMemberBtn').addEventListener('click', saveMember);
    $('clearMemberBtn').addEventListener('click', clearMemberForm);
    $('deleteMemberBtn').addEventListener('click', deleteMember);
}

function requestAdminPanel() {
    const password = prompt('管理メニューのパスワードを入力してください');
    const expected = localStorage.getItem('adminPassword') || 'kanade';
    if (password !== expected) {
        showAlert('パスワードが違います', 'danger');
        return;
    }
    showAdminPanel();
}

function showAdminPanel() {
    $('adminPanel').hidden = false;
    $('memberPanel').hidden = true;
    localStorage.setItem('userRole', 'admin');
}

function showMemberPanel() {
    $('memberPanel').hidden = false;
    $('adminPanel').hidden = true;
    localStorage.setItem('userRole', 'member');
    renderMemberViews();
}

function switchTab(panelId, tabName) {
    const panel = $(panelId);
    panel.querySelectorAll('.tab-content').forEach((tab) => {
        tab.hidden = true;
    });
    panel.querySelectorAll('[data-tab]').forEach((button) => {
        button.classList.remove('active');
    });

    const targetId = `${toPascalTab(tabName)}Tab`;
    const target = $(targetId);
    if (target) target.hidden = false;
    const button = panel.querySelector(`[data-tab="${tabName}"]`);
    if (button) button.classList.add('active');
}

function toPascalTab(value) {
    const map = {
        upload: 'upload',
        performance: 'performance',
        schedule: 'schedule',
        announcement: 'announcement',
        event: 'event',
        member: 'member',
        'member-announce': 'memberAnnounce',
        'member-performance': 'memberPerformance',
        'member-schedule': 'memberSchedule',
        'member-recording': 'memberRecording',
        'member-intro': 'memberIntro',
        'member-absence': 'memberAbsence',
        'member-sheet': 'memberSheet',
        'member-payment': 'memberPayment',
        'member-casting': 'memberCasting',
        'member-event': 'memberEvent',
        'member-piece-info': 'memberPieceInfo',
        'member-album': 'memberAlbum'
    };
    return map[value] || value;
}

function updateSavePath() {
    const date = $('uploadDate').value || today();
    const piece = $('uploadPiece').value.trim() || '未分類';
    $('savePath').textContent = `/converted/${date}/${piece}/`;
}

function handleFiles(files) {
    const selected = Array.from(files || []);
    if (!selected.length) return;

    const validFiles = selected.filter((file) => {
        const extension = file.name.split('.').pop().toLowerCase();
        return ['wav', 'mp3'].includes(extension);
    });
    if (validFiles.length !== selected.length) {
        showAlert('WAV または MP3 ファイルを選択してください', 'warning');
    }
    if (!validFiles.length) return;

    appState.selectedFiles = validFiles;
    appState.selectedFile = validFiles[0];
    $('selectedFileName').textContent = selectedFileSummary(validFiles);
    showAlert(`${validFiles.length} 件のファイルを選択しました`, 'success');
}

async function uploadToLocalStore() {
    if (!appState.selectedFiles.length) {
        showAlert('先にファイルを選択してください', 'warning');
        return;
    }

    let completed = 0;
    for (const file of appState.selectedFiles) {
        await request('/api/drive/upload', { method: 'POST', body: audioFormData(file) });
        completed += 1;
    }
    showAlert(`${completed} 件の録音ファイルを保存しました`, 'info');
    await loadRecordings();
}

function audioFormData(file) {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('bitrate', $('bitrate').value);
    formData.append('date', document.getElementById('uploadDate').value);
    formData.append('piece', document.getElementById('uploadPiece').value);
    return formData;
}

function selectedFileSummary(files) {
    if (files.length === 1) {
        const file = files[0];
        return `${file.name} (${formatBytes(file.size)})`;
    }
    const totalSize = files.reduce((sum, file) => sum + file.size, 0);
    return `${files.length} 件選択 (${formatBytes(totalSize)})`;
}

function clearUploadForm() {
    appState.selectedFile = null;
    appState.selectedFiles = [];
    $('fileInput').value = '';
    $('selectedFileName').textContent = '未選択';
    $('uploadDate').value = today();
    $('uploadPiece').value = '';
    $('bitrate').value = '192';
    updateSavePath();
}
async function loadAll() {
    await Promise.all([loadPerformances(), loadSchedules(), loadAnnouncements(), loadEvents(), loadMembers(), loadRecordings(), loadExtraData()]);
}

async function loadPerformances() {
    appState.performances = await request('/api/performances');
    renderPerformances();
    renderSchedulePerformanceOptions();
    updateSchedulePieceOptions();
}

async function loadSchedules() {
    appState.schedules = await request('/api/schedules');
    renderSchedules();
}

async function loadAnnouncements() {
    appState.announcements = await request('/api/announcements');
    renderAnnouncements();
}

async function loadEvents() {
    appState.events = await request('/api/events');
    renderEvents();
}

async function loadMembers() {
    appState.members = await request('/api/members');
    renderMembers();
}

async function loadRecordings() {
    const data = await request('/api/recordings');
    appState.recordings = data.files || [];
    renderRecordings();
}

async function loadExtraData() {
    const [absences, eventResponses, sheetLibrary, payments, castings, pieceInfos, albums] = await Promise.all([
        request('/api/extra/absences'),
        request('/api/extra/event_responses'),
        request('/api/extra/sheet_library'),
        request('/api/extra/payments'),
        request('/api/extra/castings'),
        request('/api/extra/piece_infos'),
        request('/api/extra/albums')
    ]);
    Object.assign(appState, { absences, eventResponses, sheetLibrary, payments, castings, pieceInfos, albums });
    renderMemberExtraViews();
}

async function saveExtra(name, payload) {
    return request(`/api/extra/${name}`, jsonOptions('POST', payload));
}

async function savePerformance() {
    const payload = {
        title: $('perfTitle').value.trim(),
        date: $('perfDate').value,
        open_time: $('perfOpenTime').value,
        start_time: $('perfStartTime').value,
        venue: $('perfVenue').value.trim(),
        conductor: $('perfConductor').value.trim(),
        pieces: currentPerformancePieces()
    };
    if (!payload.title || !payload.date) {
        showAlert('タイトルと開催日を入力してください', 'warning');
        return;
    }

    const id = $('perfId').value;
    await request(id ? `/api/performances/${id}` : '/api/performances', jsonOptions(id ? 'PUT' : 'POST', payload));
    clearPerformanceForm();
    await loadPerformances();
    showAlert('演奏会情報を保存しました', 'success');
}

function selectPerformance(id) {
    const item = appState.performances.find((perf) => perf.id === id);
    if (!item) return;
    $('perfId').value = item.id;
    $('perfTitle').value = item.title || '';
    $('perfDate').value = item.date || today();
    $('perfOpenTime').value = item.open_time || '18:00';
    $('perfStartTime').value = item.start_time || '19:00';
    $('perfVenue').value = item.venue || '';
    $('perfConductor').value = item.conductor || '';
    appState.performancePieces = normalizePerformancePieces(item.pieces || []);
    renderPerformancePieceList();
}

async function deletePerformance() {
    const id = $('perfId').value;
    if (!id) {
        showAlert('削除する演奏会を一覧から選択してください', 'warning');
        return;
    }
    await request(`/api/performances/${id}`, { method: 'DELETE' });
    clearPerformanceForm();
    await loadPerformances();
    showAlert('演奏会情報を削除しました', 'success');
}

function clearPerformanceForm() {
    $('perfId').value = '';
    $('perfTitle').value = '';
    $('perfDate').value = today();
    $('perfOpenTime').value = '18:00';
    $('perfStartTime').value = '19:00';
    $('perfVenue').value = '';
    $('perfConductor').value = '';
    $('perfPieceComposer').value = '';
    $('perfPieceTitle').value = '';
    appState.performancePieces = [];
    appState.performancePieceEditIndex = null;
    $('addPieceBtn').textContent = '曲を追加';
    renderPerformancePieceList();
}

function addPerformancePiece() {
    const composer = $('perfPieceComposer').value.trim();
    const title = $('perfPieceTitle').value.trim();
    if (!title) {
        showAlert('曲名を入力してください', 'warning');
        return;
    }

    const piece = { composer, title };
    if (appState.performancePieceEditIndex !== null) {
        appState.performancePieces[appState.performancePieceEditIndex] = piece;
        appState.performancePieceEditIndex = null;
        $('addPieceBtn').textContent = '曲を追加';
    } else {
        appState.performancePieces.push(piece);
    }
    $('perfPieceComposer').value = '';
    $('perfPieceTitle').value = '';
    renderPerformancePieceList();
}

function editPerformancePiece(index) {
    const piece = appState.performancePieces[index];
    if (!piece) return;
    $('perfPieceComposer').value = piece.composer || '';
    $('perfPieceTitle').value = piece.title || '';
    appState.performancePieceEditIndex = index;
    $('addPieceBtn').textContent = '曲を更新';
}

function removePerformancePiece(index) {
    appState.performancePieces.splice(index, 1);
    if (appState.performancePieceEditIndex === index) {
        appState.performancePieceEditIndex = null;
        $('addPieceBtn').textContent = '曲を追加';
        $('perfPieceComposer').value = '';
        $('perfPieceTitle').value = '';
    } else if (appState.performancePieceEditIndex !== null && appState.performancePieceEditIndex > index) {
        appState.performancePieceEditIndex -= 1;
    }
    renderPerformancePieceList();
}

function currentPerformancePieces() {
    const composer = $('perfPieceComposer').value.trim();
    const title = $('perfPieceTitle').value.trim();
    const pieces = [...appState.performancePieces];
    if (title) {
        pieces.push({ composer, title });
    }
    return pieces;
}

function normalizePerformancePieces(pieces) {
    return (pieces || []).map((piece) => {
        if (typeof piece === 'string') {
            return { composer: '', title: piece };
        }
        return {
            composer: piece.composer || '',
            title: piece.title || piece.name || ''
        };
    }).filter((piece) => piece.title);
}

function performancePieceLabel(piece) {
    if (typeof piece === 'string') return piece;
    return piece.composer ? `${piece.composer}: ${piece.title}` : piece.title;
}

function renderPerformancePieceList() {
    const list = $('perfPieceList');
    list.innerHTML = emptyText(appState.performancePieces, '曲目はまだありません');
    appState.performancePieces.forEach((piece, index) => {
        const item = document.createElement('li');
        item.className = 'list-group-item d-flex justify-content-between align-items-center gap-3';
        item.innerHTML = `
            <span>${escapeHtml(performancePieceLabel(piece))}</span>
            <span class="d-flex gap-2">
                <button class="btn btn-sm btn-outline-primary edit-piece-btn" type="button">編集</button>
                <button class="btn btn-sm btn-outline-danger delete-piece-btn" type="button">削除</button>
            </span>
        `;
        item.querySelector('.edit-piece-btn').addEventListener('click', () => editPerformancePiece(index));
        item.querySelector('.delete-piece-btn').addEventListener('click', () => removePerformancePiece(index));
        list.appendChild(item);
    });
}

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
        pieces: $('schedPieces').value,
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
    $('schedDate').value = item.date || today();
    const practiceRange = splitTimeRange(item.time);
    const availableRange = splitTimeRange(item.available_hours);
    $('schedStartTime').value = item.start_time || practiceRange.start || '13:00';
    $('schedEndTime').value = item.end_time || practiceRange.end || '16:30';
    $('schedVenue').value = item.venue || '';
    $('schedAvailableStartTime').value = item.available_start_time || availableRange.start || '12:30';
    $('schedAvailableEndTime').value = item.available_end_time || availableRange.end || '16:30';
    $('schedPerformance').value = item.performance_id ? String(item.performance_id) : '';
    updateSchedulePieceOptions(item.pieces || '未定');
    $('schedNotes').value = item.notes || '';
}

async function deleteSchedule() {
    const id = $('schedId').value;
    if (!id) {
        showAlert('削除する練習予定を一覧から選択してください', 'warning');
        return;
    }
    await request(`/api/schedules/${id}`, { method: 'DELETE' });
    clearScheduleForm();
    await loadSchedules();
    showAlert('練習予定を削除しました', 'success');
}

function clearScheduleForm() {
    $('schedId').value = '';
    $('schedDate').value = today();
    $('schedStartTime').value = '13:00';
    $('schedEndTime').value = '16:30';
    $('schedVenue').value = '';
    $('schedAvailableStartTime').value = '12:30';
    $('schedAvailableEndTime').value = '16:30';
    $('schedPerformance').value = '';
    updateSchedulePieceOptions('未定');
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

function updateSchedulePieceOptions(preferredValue = null) {
    const select = $('schedPieces');
    if (!select) return;
    const current = preferredValue ?? select.value ?? '未定';
    const performance = selectedSchedulePerformance();
    const performancePieces = performance ? normalizePerformancePieces(performance.pieces || []).map(performancePieceLabel) : [];
    const values = [...SCHEDULE_EXTRA_PIECES, ...performancePieces].filter((value, index, array) => value && array.indexOf(value) === index);
    select.innerHTML = values.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join('');
    select.value = values.includes(current) ? current : '未定';
}

function formatTimeRange(start, end) {
    return start && end ? `${start} - ${end}` : start || end || '';
}

function splitTimeRange(value) {
    const match = String(value || '').match(/(\d{1,2}:\d{2})\s*(?:-|〜|~|～)\s*(\d{1,2}:\d{2})/);
    return match ? { start: match[1], end: match[2] } : { start: '', end: '' };
}

function scheduleTimeLabel(sched) {
    return formatTimeRange(sched.start_time, sched.end_time) || sched.time || '';
}

function scheduleAvailableLabel(sched) {
    return formatTimeRange(sched.available_start_time, sched.available_end_time) || sched.available_hours || '';
}

async function saveAnnouncement() {
    const payload = {
        date: $('annDate').value || today(),
        content: $('annContent').value.trim()
    };
    if (!payload.content) {
        showAlert('お知らせ内容を入力してください', 'warning');
        return;
    }

    const id = $('annId').value;
    await request(id ? `/api/announcements/${id}` : '/api/announcements', jsonOptions(id ? 'PUT' : 'POST', payload));
    clearAnnouncementForm();
    await loadAnnouncements();
    showAlert('お知らせを保存しました', 'success');
}

function selectAnnouncement(id) {
    const item = appState.announcements.find((ann) => ann.id === id);
    if (!item) return;
    $('annId').value = item.id;
    $('annDate').value = item.date || today();
    $('annContent').value = item.content || '';
}

async function deleteAnnouncement() {
    const id = $('annId').value;
    if (!id) {
        showAlert('削除するお知らせを一覧から選択してください', 'warning');
        return;
    }
    await request(`/api/announcements/${id}`, { method: 'DELETE' });
    clearAnnouncementForm();
    await loadAnnouncements();
    showAlert('お知らせを削除しました', 'success');
}

function clearAnnouncementForm() {
    $('annId').value = '';
    $('annDate').value = today();
    $('annContent').value = '';
}


async function saveEvent() {
    const payload = {
        title: $('eventTitle').value.trim(),
        date: $('eventDate').value,
        deadline: $('eventDeadline').value,
        url: $('eventUrl').value.trim(),
        notes: $('eventNotes').value.trim()
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
    $('eventDeadline').value = item.deadline || '';
    $('eventUrl').value = item.url || '';
    $('eventNotes').value = item.notes || '';
}

async function deleteEvent() {
    const id = $('eventId').value;
    if (!id) {
        showAlert('削除するイベントを一覧から選択してください', 'warning');
        return;
    }
    if (!confirm('選択中のイベント調整を削除しますか？')) return;
    await request(`/api/events/${id}`, { method: 'DELETE' });
    clearEventForm();
    await loadEvents();
    showAlert('イベント調整を削除しました', 'success');
}

function clearEventForm() {
    $('eventId').value = '';
    $('eventTitle').value = '';
    $('eventDate').value = '';
    $('eventDeadline').value = '';
    $('eventUrl').value = '';
    $('eventNotes').value = '';
}

async function saveMember() {
    const payload = {
        name: $('memberName').value.trim(),
        part: $('memberPart').value,
        photo_url: $('memberPhotoUrl') ? $('memberPhotoUrl').value.trim() : '',
        joined_at: $('memberJoinedAt') ? $('memberJoinedAt').value : '',
        introducer: $('memberIntroducer') ? $('memberIntroducer').value.trim() : '',
        role: $('memberRole') ? $('memberRole').value.trim() : '',
        instrument_history: $('memberInstrumentHistory') ? $('memberInstrumentHistory').value.trim() : '',
        past_orchestras: $('memberPastOrchestras') ? $('memberPastOrchestras').value.trim() : '',
        comment: $('memberComment').value.trim()
    };
    if (!payload.name) {
        showAlert('団員名を入力してください', 'warning');
        return;
    }
    if (!payload.part) {
        showAlert('パートを選択してください', 'warning');
        return;
    }
    const id = $('memberId').value;
    await request(id ? `/api/members/${id}` : '/api/members', jsonOptions(id ? 'PUT' : 'POST', payload));
    clearMemberForm();
    await loadMembers();
    showAlert('団員情報を保存しました', 'success');
}

function selectMember(id) {
    const item = appState.members.find((member) => member.id === id);
    if (!item) return;
    $('memberId').value = item.id;
    $('memberName').value = item.name || '';
    $('memberPart').value = item.part || '';
    if ($('memberPhotoUrl')) $('memberPhotoUrl').value = item.photo_url || '';
    if ($('memberJoinedAt')) $('memberJoinedAt').value = item.joined_at || '';
    if ($('memberIntroducer')) $('memberIntroducer').value = item.introducer || '';
    if ($('memberRole')) $('memberRole').value = item.role || '';
    if ($('memberInstrumentHistory')) $('memberInstrumentHistory').value = item.instrument_history || '';
    if ($('memberPastOrchestras')) $('memberPastOrchestras').value = item.past_orchestras || '';
    $('memberComment').value = item.comment || '';
}

async function deleteMember() {
    const id = $('memberId').value;
    if (!id) {
        showAlert('削除する団員を一覧から選択してください', 'warning');
        return;
    }
    if (!confirm('選択中の団員情報を削除しますか？')) return;
    await request(`/api/members/${id}`, { method: 'DELETE' });
    clearMemberForm();
    await loadMembers();
    showAlert('団員情報を削除しました', 'success');
}

function clearMemberForm() {
    $('memberId').value = '';
    $('memberName').value = '';
    $('memberPart').value = '';
    if ($('memberPhotoUrl')) $('memberPhotoUrl').value = '';
    if ($('memberJoinedAt')) $('memberJoinedAt').value = '';
    if ($('memberIntroducer')) $('memberIntroducer').value = '';
    if ($('memberRole')) $('memberRole').value = '';
    if ($('memberInstrumentHistory')) $('memberInstrumentHistory').value = '';
    if ($('memberPastOrchestras')) $('memberPastOrchestras').value = '';
    $('memberComment').value = '';
}

function renderMembers() {
    const list = $('memberListItems');
    if (list) {
        list.innerHTML = emptyText(appState.members, '団員情報はまだありません');
        [...appState.members].sort((a, b) => String(a.part || '').localeCompare(String(b.part || '')) || String(a.name || '').localeCompare(String(b.name || ''))).forEach((member) => {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'list-group-item list-group-item-action';
            item.innerHTML = `<strong>${escapeHtml(member.name)}</strong><div class="small text-muted">${escapeHtml(member.part || '')}${member.comment ? ` / ${escapeHtml(member.comment)}` : ''}</div>`;
            item.addEventListener('click', () => selectMember(member.id));
            list.appendChild(item);
        });
    }
    renderMemberIntros();
    renderMemberExtraViews();
}

function renderMemberIntros() {
    const container = $('memberIntroInfo');
    if (!container) return;
    if (!appState.members.length) {
        container.innerHTML = '<p class="text-muted mb-0">団員情報はまだありません</p>';
        return;
    }
    const grouped = groupBy([...appState.members].sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))), 'part');
    container.innerHTML = Object.entries(grouped).map(([part, members]) => `
        <section class="mb-3">
            <h6>${escapeHtml(part || '未設定')}</h6>
            <div class="row g-3">${members.map((member) => `
                <div class="col-md-6 col-xl-4"><div class="card h-100"><div class="card-body">
                    <div class="d-flex gap-3">
                        ${member.photo_url ? `<img src="${escapeHtml(member.photo_url)}" alt="${escapeHtml(member.name)}" class="member-photo">` : ''}
                        <div><h6 class="mb-1">${escapeHtml(member.name)}</h6><div class="small text-muted">${escapeHtml(member.part || '')}</div></div>
                    </div>
                    ${member.joined_at ? `<div class="small mt-2"><strong>入団:</strong> ${escapeHtml(member.joined_at)}</div>` : ''}
                    ${member.introducer ? `<div class="small"><strong>紹介者:</strong> ${escapeHtml(member.introducer)}</div>` : ''}
                    ${member.role ? `<div class="small"><strong>役割:</strong> ${escapeHtml(member.role)}</div>` : ''}
                    ${member.instrument_history ? `<div class="small mt-2 multiline-text"><strong>楽器歴:</strong><br>${escapeHtml(member.instrument_history)}</div>` : ''}
                    ${member.past_orchestras ? `<div class="small mt-2 multiline-text"><strong>過去所属オケ:</strong><br>${escapeHtml(member.past_orchestras)}</div>` : ''}
                    ${member.comment ? `<div class="small text-muted mt-2 multiline-text">${escapeHtml(member.comment)}</div>` : ''}
                </div></div></div>`).join('')}</div>
        </section>
    `).join('');
}

function renderEvents() {
    const list = $('eventListItems');
    if (!list) return;
    list.innerHTML = emptyText(appState.events, 'イベント調整はまだありません');
    appState.events.forEach((event) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'list-group-item list-group-item-action';
        item.innerHTML = `
            <strong>${escapeHtml(event.title)}</strong>
            <div class="small text-muted">開催日: ${escapeHtml(event.date || '未定')} / 回答期限: ${escapeHtml(event.deadline || '未定')}</div>
            ${event.url ? `<div class="small text-truncate">${escapeHtml(event.url)}</div>` : ''}
        `;
        item.addEventListener('click', () => selectEvent(event.id));
        list.appendChild(item);
    });
}

function renderPerformances() {
    const list = $('perfListItems');
    list.innerHTML = emptyText(appState.performances, '演奏会情報はまだありません');
    appState.performances.forEach((perf) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'list-group-item list-group-item-action';
        item.innerHTML = `
            <strong>${escapeHtml(perf.title)}</strong>
            <div class="small text-muted">${escapeHtml(perf.date)} / ${escapeHtml(perf.venue || '会場未定')} / 指揮: ${escapeHtml(perf.conductor || '未定')}</div>
        `;
        item.addEventListener('click', () => selectPerformance(perf.id));
        list.appendChild(item);
    });
    renderMemberPerformances();
    renderSchedulePerformanceOptions();
    updateSchedulePieceOptions();
}

function renderSchedules() {
    const container = $('schedListItems');
    if (!appState.schedules.length) {
        container.innerHTML = '<p class="text-muted mb-0">練習予定はまだありません</p>';
        renderMemberSchedules();
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
            <td>${escapeHtml(sched.date)}</td>
            <td>${escapeHtml(scheduleTimeLabel(sched))}</td>
            <td>${escapeHtml(sched.venue || '')}</td>
            <td>${escapeHtml(schedulePerformanceLabel(sched))}</td>
            <td>${escapeHtml(sched.pieces || '')}</td>
            <td>${escapeHtml(sched.notes || '')}</td>
        `;
        row.addEventListener('click', () => selectSchedule(sched.id));
        body.appendChild(row);
    });
    renderMemberSchedules();
}

function renderAnnouncements() {
    const admin = $('annListItems');
    const member = $('memberAnnList');
    admin.innerHTML = emptyText(appState.announcements, 'お知らせはまだありません');
    member.innerHTML = emptyText(appState.announcements, 'お知らせはまだありません');
    appState.announcements.forEach((ann) => {
        const adminItem = announcementItem(ann, true);
        const memberItem = announcementItem(ann, false);
        admin.appendChild(adminItem);
        member.appendChild(memberItem);
    });
}

function announcementItem(ann, selectable) {
    const item = document.createElement(selectable ? 'button' : 'li');
    item.className = selectable
        ? 'list-group-item list-group-item-action'
        : 'list-group-item';
    if (selectable) item.type = 'button';
    item.innerHTML = `<span class="small text-muted">${escapeHtml(ann.date)}</span><br>${escapeHtml(ann.content)}`;
    if (selectable) item.addEventListener('click', () => selectAnnouncement(ann.id));
    return item;
}

function renderRecordings() {
    renderRecordingList('songTreeAdmin', true);
    renderRecordingList('songTreeMember', false);
}

function renderRecordingList(containerId, canDelete) {
    const container = $(containerId);
    if (!appState.recordings.length) {
        container.innerHTML = '<p class="text-muted mb-0">録音ファイルはまだありません</p>';
        return;
    }

    const grouped = groupBy(appState.recordings, 'date');
    container.innerHTML = '';
    Object.entries(grouped).forEach(([date, files]) => {
        const section = document.createElement('div');
        section.className = 'recording-group';
        section.innerHTML = `<h6>${escapeHtml(date || '未分類')}</h6>`;
        const list = document.createElement('div');
        list.className = 'list-group mb-3';
        files.forEach((file) => {
            const item = document.createElement('div');
            item.className = 'list-group-item';
            const playUrl = file.play_url || file.download_url;
            const downloadUrl = file.download_url || playUrl;
            const actionButton = canDelete
                ? '<button class="btn btn-sm btn-outline-danger delete-recording-btn" type="button">削除</button>'
                : `<a class="btn btn-sm btn-primary" href="${escapeHtml(downloadUrl)}">DL</a>`;
            item.innerHTML = `
                <div class="d-flex justify-content-between align-items-center gap-3 flex-wrap">
                    <span>
                    <strong>${escapeHtml(file.name)}</strong>
                    <span class="small text-muted d-block">${escapeHtml(file.piece || '未分類')} / ${formatDurationLabel(file)} / ${formatBytes(file.size)}</span>
                    </span>
                    <span class="d-flex gap-2">
                        <button class="btn btn-sm btn-outline-primary play-recording-btn" type="button">再生</button>
                        ${actionButton}
                    </span>
                </div>
                <div class="recording-player-area mt-2"></div>
            `;
            const playButton = item.querySelector('.play-recording-btn');
            const playerArea = item.querySelector('.recording-player-area');
            playButton.disabled = !playUrl;
            if (playUrl) {
                let audio = null;
                playButton.addEventListener('click', async () => {
                    try {
                        if (!audio) {
                            audio = document.createElement('audio');
                            audio.controls = true;
                            audio.preload = 'metadata';
                            audio.className = 'w-100';
                            audio.src = withCacheBuster(playUrl);
                            playerArea.appendChild(audio);
                            audio.addEventListener('ended', () => {
                                playButton.textContent = '再生';
                            });
                            audio.addEventListener('error', () => {
                                showAlert('音声ファイルを読み込めませんでした。再デプロイ後の場合は更新して再試行してください。', 'danger');
                                playButton.textContent = '再生';
                            });
                        }
                        if (audio.paused) {
                            await audio.play();
                            playButton.textContent = '停止';
                        } else {
                            audio.pause();
                            playButton.textContent = '再生';
                        }
                    } catch (error) {
                        showAlert(`再生できませんでした: ${error.message}`, 'danger');
                        playButton.textContent = '再生';
                    }
                });
            }
            if (canDelete) {
                item.querySelector('.delete-recording-btn').addEventListener('click', () => deleteRecording(file));
            }
            list.appendChild(item);
        });
        section.appendChild(list);
        container.appendChild(section);
    });
}

function withCacheBuster(url) {
    if (!url) return url;
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}t=${Date.now()}`;
}

async function deleteRecording(file) {
    if (!confirm(`${file.name} を削除しますか？`)) return;

    await request('/api/recordings', jsonOptions('DELETE', {
        source: file.source || 'local',
        object_name: file.object_name || file.id || '',
        path: file.path || ''
    }));
    await loadRecordings();
    showAlert('録音ファイルを削除しました', 'success');
}

function renderMemberViews() {
    renderMemberPerformances();
    renderMemberSchedules();
    renderAnnouncements();
    renderRecordings();
    renderMemberIntros();
}

function renderMemberPerformances() {
    const container = $('memberPerfInfo');
    if (!appState.performances.length) {
        container.innerHTML = '<p class="text-muted mb-0">演奏会情報はまだありません</p>';
        return;
    }
    const upcoming = [...appState.performances].filter((perf) => perf.date).sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const nextPerf = upcoming.find((perf) => perf.date >= today()) || upcoming[0];
    const countdown = nextPerf ? daysUntil(nextPerf.date) : null;
    container.innerHTML = `${nextPerf && countdown !== null ? `<div class="countdown-banner">本番まであと${countdown}日！</div>` : ''}` + appState.performances.map((perf) => `
        <article class="info-block">
            <h5>${escapeHtml(perf.title)}</h5>
            <p>${escapeHtml(perf.date)} ${escapeHtml(perf.open_time)}開場 / ${escapeHtml(perf.start_time)}開演</p>
            <p>${escapeHtml(perf.venue || '会場未定')} / 指揮: ${escapeHtml(perf.conductor || '未定')}</p>
            <div class="mb-0">${(perf.pieces || []).map((piece) => `<div>${escapeHtml(performancePieceLabel(piece))}</div>`).join('')}</div>
        </article>
    `).join('');
}

function renderMemberSchedules() {
    const container = $('memberSchedInfo');
    const upcoming = sortedSchedules(appState.schedules).filter((sched) => !sched.date || sched.date >= today());
    if (!upcoming.length) {
        container.innerHTML = '<p class="text-muted mb-0">練習予定はまだありません</p>';
        return;
    }
    container.innerHTML = upcoming.map((sched) => `
        <article class="info-block">
            <h5>${escapeHtml(sched.date)} ${escapeHtml(scheduleTimeLabel(sched))}</h5>
            <p>${escapeHtml(sched.venue || '')} / 利用可能: ${escapeHtml(scheduleAvailableLabel(sched))}</p>
            <p class="mb-1"><strong>演奏会:</strong> ${escapeHtml(schedulePerformanceLabel(sched))}</p>
            <p class="mb-1"><strong>練習曲:</strong> ${escapeHtml(sched.pieces || '未定')}</p>
            <p class="mb-0 text-muted multiline-text">${escapeHtml(sched.notes || '')}</p>
        </article>
    `).join('');
}

function sortedSchedules(schedules) {
    return [...(schedules || [])].sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')) || String(scheduleTimeLabel(a)).localeCompare(String(scheduleTimeLabel(b))));
}

function schedulePerformanceLabel(sched) {
    if (sched.performance_title) return sched.performance_title;
    if (sched.performance_id) {
        const performance = appState.performances.find((perf) => String(perf.id) === String(sched.performance_id));
        if (performance) return performance.title;
    }
    return '未定';
}

function daysUntil(dateText) {
    const target = new Date(`${dateText}T00:00:00`);
    const base = new Date(`${today()}T00:00:00`);
    if (Number.isNaN(target.getTime())) return null;
    return Math.ceil((target - base) / 86400000);
}

function formatDurationLabel(file) {
    if (file.duration) return file.duration;
    if (file.duration_seconds || file.duration_seconds === 0) {
        const total = Math.round(Number(file.duration_seconds));
        const minutes = Math.floor(total / 60);
        const seconds = total % 60;
        return `${minutes}:${String(seconds).padStart(2, '0')}`;
    }
    return '長さ未取得';
}

function renderMemberExtraViews() {
    renderAbsenceView();
    renderSheetLibraryView();
    renderPaymentView();
    renderCastingView();
    renderMemberEventView();
    renderPieceInfoView();
    renderAlbumView();
}

function memberOptions(selected = '') {
    return ['<option value="">選択してください</option>'].concat(appState.members.map((m) => `<option value="${escapeHtml(m.name)}" ${m.name === selected ? 'selected' : ''}>${escapeHtml(m.name)}（${escapeHtml(m.part || '')}）</option>`)).join('');
}

function scheduleOptions(selected = '') {
    const upcoming = sortedSchedules(appState.schedules).filter((s) => !s.date || s.date >= today());
    return ['<option value="">選択してください</option>'].concat(upcoming.map((s) => `<option value="${escapeHtml(String(s.id))}" ${String(s.id) === String(selected) ? 'selected' : ''}>${escapeHtml(s.date)} ${escapeHtml(scheduleTimeLabel(s))} ${escapeHtml(s.venue || '')}</option>`)).join('');
}

function renderAbsenceView() {
    const container = $('memberAbsenceInfo');
    if (!container) return;
    const grouped = groupBy(appState.absences, 'schedule_id');
    container.innerHTML = `
        <div class="row g-2 align-items-end mb-3">
            <div class="col-md-4"><label class="form-label">名前</label><select id="absenceMemberName" class="form-select">${memberOptions()}</select></div>
            <div class="col-md-5"><label class="form-label">欠席する練習日</label><select id="absenceScheduleId" class="form-select">${scheduleOptions()}</select></div>
            <div class="col-md-3"><button class="btn btn-primary w-100" id="absenceSaveBtn" type="button">欠席連絡を登録</button></div>
        </div>
        <h6>練習日ごとの欠席者</h6>
        ${sortedSchedules(appState.schedules).map((s) => {
            const abs = (grouped[String(s.id)] || grouped[s.id] || []);
            return `<div class="info-block"><strong>${escapeHtml(s.date)} ${escapeHtml(scheduleTimeLabel(s))}</strong><div class="small text-muted">${escapeHtml(s.venue || '')}</div><div>${abs.length ? abs.map((a) => escapeHtml(a.name)).join('、') : '欠席連絡なし'}</div></div>`;
        }).join('')}
    `;
    $('absenceSaveBtn').addEventListener('click', async () => {
        const name = $('absenceMemberName').value;
        const scheduleId = $('absenceScheduleId').value;
        if (!name || !scheduleId) { showAlert('名前と練習日を選択してください', 'warning'); return; }
        const sched = appState.schedules.find((s) => String(s.id) === String(scheduleId));
        await saveExtra('absences', { name, schedule_id: scheduleId, schedule_date: sched ? sched.date : '' });
        showAlert('欠席連絡を登録しました', 'success');
        await loadExtraData();
    });
}

function renderSheetLibraryView() {
    const c = $('memberSheetInfo'); if (!c) return;
    c.innerHTML = appState.performances.map((perf) => {
        const rows = appState.sheetLibrary.filter((x) => String(x.performance_id || '') === String(perf.id));
        return `<section class="mb-3"><h5>${escapeHtml(perf.title)}</h5>${rows.length ? rows.map((r) => `<div class="list-group-item d-flex justify-content-between"><span>${escapeHtml(r.piece || r.title || '楽譜')}</span><span><a class="btn btn-sm btn-outline-primary" href="${escapeHtml(r.url || '#')}" target="_blank">閲覧</a> <a class="btn btn-sm btn-primary" href="${escapeHtml(r.url || '#')}" download>DL</a></span></div>`).join('') : '<p class="text-muted">登録された楽譜はありません</p>'}</section>`;
    }).join('') || '<p class="text-muted">演奏会情報がありません</p>';
}

function renderPaymentView() {
    const c = $('memberPaymentInfo'); if (!c) return;
    c.innerHTML = `<div class="mb-3"><label class="form-label">団員</label><select id="paymentMemberName" class="form-select">${memberOptions()}</select></div><div id="paymentResult"></div>`;
    const render = () => {
        const name = $('paymentMemberName').value;
        const rows = appState.payments.filter((p) => p.name === name);
        $('paymentResult').innerHTML = name ? (rows.length ? rows.map((p) => `<div class="info-block"><strong>${escapeHtml(p.title || p.year || '支払')}</strong><div>団費: ${escapeHtml(p.membership_fee || p.dues || '未登録')}</div><div>演奏会費: ${escapeHtml(p.performance_fee || '未登録')}</div></div>`).join('') : '<p class="text-muted">支払情報は未登録です</p>') : '';
    };
    $('paymentMemberName').addEventListener('change', render);
}

function renderCastingView() {
    const c = $('memberCastingInfo'); if (!c) return;
    c.innerHTML = appState.performances.map((perf) => {
        const rows = appState.castings.filter((x) => String(x.performance_id || '') === String(perf.id));
        return `<section class="mb-3"><h5>${escapeHtml(perf.title)}</h5>${rows.length ? rows.map((r) => `<div class="info-block"><strong>${escapeHtml(r.piece || '全曲')}</strong><div>${escapeHtml(r.members || r.names || '')}</div></div>`).join('') : '<p class="text-muted">乗り番表は未登録です</p>'}</section>`;
    }).join('');
}

function renderMemberEventView() {
    const c = $('memberEventInfo'); if (!c) return;
    c.innerHTML = `
        <div class="row g-2 mb-3"><div class="col-md-5"><input id="memberEventTitle" class="form-control" placeholder="イベント名"></div><div class="col-md-3"><input id="memberEventDate" type="date" class="form-control"></div><div class="col-md-2"><button id="memberEventCreateBtn" class="btn btn-primary w-100">イベント作成</button></div></div>
        <div class="mb-3"><label class="form-label">イベント選択</label><select id="memberEventSelect" class="form-select"><option value="">選択してください</option>${appState.events.map((e) => `<option value="${e.id}">${escapeHtml(e.date || '')} ${escapeHtml(e.title)}</option>`).join('')}</select></div>
        <div id="memberEventChild"></div>`;
    $('memberEventDate').value = today();
    $('memberEventCreateBtn').addEventListener('click', async () => {
        const title = $('memberEventTitle').value.trim(); const date = $('memberEventDate').value;
        if (!title || !date) { showAlert('イベント名と日付を入力してください', 'warning'); return; }
        await request('/api/events', jsonOptions('POST', { title, date, deadline: '', url: '', notes: '' }));
        showAlert('イベントを作成しました', 'success');
        await loadEvents(); await loadExtraData();
    });
    $('memberEventSelect').addEventListener('change', renderEventChildForm);
}

function renderEventChildForm() {
    const id = $('memberEventSelect').value;
    const c = $('memberEventChild');
    if (!id) { c.innerHTML = ''; return; }
    const responses = appState.eventResponses.filter((r) => String(r.event_id) === String(id));
    c.innerHTML = `<div class="row g-2 align-items-end mb-3"><div class="col-md-5"><label class="form-label">名前</label><select id="eventResponseName" class="form-select">${memberOptions()}</select></div><div class="col-md-4"><label class="form-label">参加/不参加</label><select id="eventResponseStatus" class="form-select"><option>参加</option><option>不参加</option></select></div><div class="col-md-3"><button id="eventResponseSaveBtn" class="btn btn-primary w-100">登録</button></div></div><h6>回答状況</h6>${responses.length ? responses.map((r) => `<div class="list-group-item">${escapeHtml(r.name)}：${escapeHtml(r.status)}</div>`).join('') : '<p class="text-muted">回答はまだありません</p>'}`;
    $('eventResponseSaveBtn').addEventListener('click', async () => {
        const name = $('eventResponseName').value; const status = $('eventResponseStatus').value;
        if (!name) { showAlert('名前を選択してください', 'warning'); return; }
        await saveExtra('event_responses', { event_id: id, name, status });
        showAlert('イベント出欠を登録しました', 'success');
        await loadExtraData();
        if ($('memberEventSelect')) { $('memberEventSelect').value = id; renderEventChildForm(); }
    });
}

function renderPieceInfoView() {
    const c = $('memberPieceInfo'); if (!c) return;
    c.innerHTML = appState.performances.map((perf) => {
        const rows = appState.pieceInfos.filter((x) => String(x.performance_id || '') === String(perf.id));
        const fallback = (perf.pieces || []).map((p) => ({ title: performancePieceLabel(p), description: '' }));
        const list = rows.length ? rows : fallback;
        return `<section class="mb-3"><h5>${escapeHtml(perf.title)}</h5>${list.map((r) => `<div class="info-block"><strong>${escapeHtml(r.piece || r.title || '')}</strong>${r.composer ? `<div class="small text-muted">${escapeHtml(r.composer)}</div>` : ''}${r.description || r.notes ? `<div class="multiline-text mt-1">${escapeHtml(r.description || r.notes)}</div>` : ''}</div>`).join('')}</section>`;
    }).join('');
}

function renderAlbumView() {
    const c = $('memberAlbumInfo'); if (!c) return;
    c.innerHTML = appState.albums.length ? `<div class="row g-3">${appState.albums.map((a) => `<div class="col-6 col-md-4 col-xl-3"><a href="${escapeHtml(a.url || '#')}" target="_blank"><img src="${escapeHtml(a.thumbnail_url || a.url || '')}" class="album-photo" alt="${escapeHtml(a.title || '写真')}"></a><div class="small mt-1">${escapeHtml(a.title || '')}</div></div>`).join('')}</div>` : '<p class="text-muted">写真はまだ登録されていません</p>';
}


async function request(url, options = {}) {
    const response = await fetch(url, options);
    const contentType = response.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await response.json() : await response.text();
    if (!response.ok) {
        const message = typeof data === 'object' && data.detail ? data.detail : '通信に失敗しました';
        showAlert(message, 'danger');
        throw new Error(message);
    }
    return data;
}

function jsonOptions(method, payload) {
    return {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    };
}

function emptyText(items, message) {
    return items.length ? '' : `<li class="list-group-item text-muted">${message}</li>`;
}

function groupBy(items, key) {
    return items.reduce((groups, item) => {
        const value = item[key] || '未分類';
        groups[value] = groups[value] || [];
        groups[value].push(item);
        return groups;
    }, {});
}

function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / Math.pow(1024, index)).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    }[char]));
}

function showAlert(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `alert alert-${type} shadow-sm`;
    toast.textContent = message;
    $('toastArea').appendChild(toast);
    setTimeout(() => toast.remove(), 4200);
}
