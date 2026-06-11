const appState = {
    selectedFile: null,
    performances: [],
    schedules: [],
    announcements: [],
    recordings: []
};

const today = () => new Date().toISOString().slice(0, 10);
const $ = (id) => document.getElementById(id);

document.addEventListener('DOMContentLoaded', async () => {
    setDefaultDates();
    bindNavigation();
    bindUpload();
    bindForms();
    showAdminPanel();
    await loadAll();
    updateSavePath();
});

function setDefaultDates() {
    ['uploadDate', 'schedDate', 'annDate'].forEach((id) => {
        $(id).value = today();
    });
    $('perfDate').value = today();
}

function bindNavigation() {
    $('adminMenuBtn').addEventListener('click', showAdminPanel);
    $('memberMenuBtn').addEventListener('click', showMemberPanel);

    document.querySelectorAll('#adminPanel [data-tab]').forEach((button) => {
        button.addEventListener('click', () => switchTab('adminPanel', button.dataset.tab));
    });
    document.querySelectorAll('#memberPanel [data-tab]').forEach((button) => {
        button.addEventListener('click', () => switchTab('memberPanel', button.dataset.tab));
    });
}

function bindUpload() {
    const dropZone = $('dropZone');
    const fileInput = $('fileInput');

    $('selectFileBtn').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (event) => handleFiles(event.target.files));
    $('uploadDate').addEventListener('input', updateSavePath);
    $('uploadPiece').addEventListener('input', updateSavePath);
    $('convertBtn').addEventListener('click', convertFile);
    $('uploadBtn').addEventListener('click', uploadToLocalStore);
    $('clearBtn').addEventListener('click', clearUploadForm);

    ['dragenter', 'dragover'].forEach((name) => {
        dropZone.addEventListener(name, (event) => {
            event.preventDefault();
            dropZone.classList.add('dragover');
        });
    });
    ['dragleave', 'drop'].forEach((name) => {
        dropZone.addEventListener(name, (event) => {
            event.preventDefault();
            dropZone.classList.remove('dragover');
        });
    });
    dropZone.addEventListener('drop', (event) => handleFiles(event.dataTransfer.files));
}

function bindForms() {
    $('addPerfBtn').addEventListener('click', savePerformance);
    $('editPerfBtn').addEventListener('click', clearPerformanceForm);
    $('deletePerfBtn').addEventListener('click', deletePerformance);

    $('addSchedBtn').addEventListener('click', saveSchedule);
    $('editSchedBtn').addEventListener('click', clearScheduleForm);
    $('deleteSchedBtn').addEventListener('click', deleteSchedule);

    $('addAnnBtn').addEventListener('click', saveAnnouncement);
    $('editAnnBtn').addEventListener('click', clearAnnouncementForm);
    $('deleteAnnBtn').addEventListener('click', deleteAnnouncement);
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
        'member-announce': 'memberAnnounce',
        'member-performance': 'memberPerformance',
        'member-schedule': 'memberSchedule',
        'member-recording': 'memberRecording'
    };
    return map[value] || value;
}

function updateSavePath() {
    const date = $('uploadDate').value || today();
    const piece = $('uploadPiece').value.trim() || '未分類';
    $('savePath').textContent = `/converted/${date}/${piece}/`;
}

function handleFiles(files) {
    const file = files && files[0];
    if (!file) return;

    const extension = file.name.split('.').pop().toLowerCase();
    if (!['wav', 'mp3'].includes(extension)) {
        showAlert('WAV または MP3 ファイルを選択してください', 'warning');
        return;
    }

    appState.selectedFile = file;
    $('selectedFileName').textContent = `${file.name} (${formatBytes(file.size)})`;
    showAlert('ファイルを選択しました', 'success');
}

async function convertFile() {
    if (!appState.selectedFile) {
        showAlert('先にファイルを選択してください', 'warning');
        return;
    }

    const formData = audioFormData();
    const data = await request('/api/convert', { method: 'POST', body: formData });
    showAlert(`変換しました: ${data.filename}`, 'success');
    await loadRecordings();
}

async function uploadToLocalStore() {
    if (!appState.selectedFile) {
        showAlert('先にファイルを選択してください', 'warning');
        return;
    }

    const data = await request('/api/drive/upload', { method: 'POST', body: audioFormData() });
    showAlert(data.message, 'info');
}

function audioFormData() {
    const formData = new FormData();
    formData.append('file', appState.selectedFile);
    formData.append('bitrate', $('bitrate').value);
    formData.append('date', $('uploadDate').value);
    formData.append('piece', $('uploadPiece').value);
    return formData;
}

function clearUploadForm() {
    appState.selectedFile = null;
    $('fileInput').value = '';
    $('selectedFileName').textContent = '未選択';
    $('uploadDate').value = today();
    $('uploadPiece').value = '';
    $('bitrate').value = '192';
    updateSavePath();
}

async function loadAll() {
    await Promise.all([loadPerformances(), loadSchedules(), loadAnnouncements(), loadRecordings()]);
}

async function loadPerformances() {
    appState.performances = await request('/api/performances');
    renderPerformances();
}

async function loadSchedules() {
    appState.schedules = await request('/api/schedules');
    renderSchedules();
}

async function loadAnnouncements() {
    appState.announcements = await request('/api/announcements');
    renderAnnouncements();
}

async function loadRecordings() {
    const data = await request('/api/recordings');
    appState.recordings = data.files || [];
    renderRecordings();
}

async function savePerformance() {
    const payload = {
        title: $('perfTitle').value.trim(),
        date: $('perfDate').value,
        open_time: $('perfOpenTime').value,
        start_time: $('perfStartTime').value,
        venue: $('perfVenue').value.trim(),
        conductor: $('perfConductor').value.trim(),
        pieces: $('perfPieces').value.split(',').map((value) => value.trim()).filter(Boolean)
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
    $('perfPieces').value = (item.pieces || []).join(', ');
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
    $('perfPieces').value = '';
}

async function saveSchedule() {
    const payload = {
        date: $('schedDate').value,
        time: $('schedTime').value,
        venue: $('schedVenue').value.trim(),
        available_hours: $('schedAvailHours').value.trim(),
        pieces: $('schedPieces').value.trim(),
        notes: $('schedNotes').value.trim()
    };
    if (!payload.date || !payload.time) {
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
    $('schedTime').value = item.time || '13:00';
    $('schedVenue').value = item.venue || '';
    $('schedAvailHours').value = item.available_hours || '';
    $('schedPieces').value = item.pieces || '';
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
    $('schedTime').value = '13:00';
    $('schedVenue').value = '';
    $('schedAvailHours').value = '';
    $('schedPieces').value = '';
    $('schedNotes').value = '';
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
                <thead><tr><th>日付</th><th>時間</th><th>場所</th><th>曲</th><th>備考</th></tr></thead>
                <tbody></tbody>
            </table>
        </div>
    `;
    const body = container.querySelector('tbody');
    appState.schedules.forEach((sched) => {
        const row = document.createElement('tr');
        row.className = 'clickable-row';
        row.innerHTML = `
            <td>${escapeHtml(sched.date)}</td>
            <td>${escapeHtml(sched.time)}</td>
            <td>${escapeHtml(sched.venue || '')}</td>
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
    renderRecordingList('songTreeAdmin');
    renderRecordingList('songTreeMember');
}

function renderRecordingList(containerId) {
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
            const link = document.createElement('a');
            link.className = 'list-group-item list-group-item-action d-flex justify-content-between align-items-center gap-3';
            link.href = file.download_url;
            link.innerHTML = `
                <span>
                    <strong>${escapeHtml(file.name)}</strong>
                    <span class="small text-muted d-block">${escapeHtml(file.piece || '未分類')} / ${formatBytes(file.size)}</span>
                </span>
                <span class="badge text-bg-primary">DL</span>
            `;
            list.appendChild(link);
        });
        section.appendChild(list);
        container.appendChild(section);
    });
}

function renderMemberViews() {
    renderMemberPerformances();
    renderMemberSchedules();
    renderAnnouncements();
    renderRecordings();
}

function renderMemberPerformances() {
    const container = $('memberPerfInfo');
    if (!appState.performances.length) {
        container.innerHTML = '<p class="text-muted mb-0">演奏会情報はまだありません</p>';
        return;
    }
    container.innerHTML = appState.performances.map((perf) => `
        <article class="info-block">
            <h5>${escapeHtml(perf.title)}</h5>
            <p>${escapeHtml(perf.date)} ${escapeHtml(perf.open_time)}開場 / ${escapeHtml(perf.start_time)}開演</p>
            <p>${escapeHtml(perf.venue || '会場未定')} / 指揮: ${escapeHtml(perf.conductor || '未定')}</p>
            <p class="mb-0">${escapeHtml((perf.pieces || []).join('、'))}</p>
        </article>
    `).join('');
}

function renderMemberSchedules() {
    const container = $('memberSchedInfo');
    if (!appState.schedules.length) {
        container.innerHTML = '<p class="text-muted mb-0">練習予定はまだありません</p>';
        return;
    }
    container.innerHTML = appState.schedules.map((sched) => `
        <article class="info-block">
            <h5>${escapeHtml(sched.date)} ${escapeHtml(sched.time)}</h5>
            <p>${escapeHtml(sched.venue || '')} / 利用可能: ${escapeHtml(sched.available_hours || '')}</p>
            <p>${escapeHtml(sched.pieces || '')}</p>
            <p class="mb-0 text-muted">${escapeHtml(sched.notes || '')}</p>
        </article>
    `).join('');
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
