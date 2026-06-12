const appState = {
    selectedFile: null,
    selectedFiles: [],
    performancePieces: [],
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
    // 保存先は画面に表示しない。既存イベントから呼ばれても何もしない。
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
        await uploadAudioFile(file);
        completed += 1;
    }
    showAlert(`${completed} 件の録音ファイルを保存しました`, 'info');
    await loadRecordings();
}

async function uploadAudioFile(file) {
    // Cloud Run has a request-size limit, so send the audio body directly to GCS.
    // Cloud Run only creates the upload session and registers metadata.
    try {
        await uploadDirectlyToCloudStorage(file);
    } catch (error) {
        console.warn('Direct upload failed. Falling back to Cloud Run upload.', error);
        showAlert('GCS直接アップロードに失敗しました。Cloud Run経由で再試行します。', 'warning');
        await request('/api/drive/upload', { method: 'POST', body: audioFormData(file) });
    }
}

async function uploadDirectlyToCloudStorage(file) {
    const metadata = await audioUploadMetadata(file);
    const session = await request('/api/drive/direct-upload-session', jsonOptions('POST', metadata));
    const uploadResponse = await fetch(session.upload_url, {
        method: 'PUT',
        headers: {
            'Content-Type': session.content_type || metadata.content_type
        },
        body: file
    });
    if (!uploadResponse.ok) {
        const message = await uploadResponse.text();
        throw new Error(message || `GCS upload failed: ${uploadResponse.status}`);
    }

    await request('/api/drive/direct-upload-complete', jsonOptions('POST', {
        ...metadata,
        object_name: session.object_name
    }));
}

async function audioUploadMetadata(file) {
    return {
        filename: file.name,
        content_type: file.type || guessAudioContentType(file.name),
        size: file.size,
        date: document.getElementById('uploadDate').value,
        piece: document.getElementById('uploadPiece').value,
        duration_seconds: await getAudioDurationSeconds(file)
    };
}

function getAudioDurationSeconds(file) {
    return new Promise((resolve) => {
        const audio = document.createElement('audio');
        const objectUrl = URL.createObjectURL(file);
        const cleanup = () => URL.revokeObjectURL(objectUrl);
        audio.preload = 'metadata';
        audio.onloadedmetadata = () => {
            const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
            cleanup();
            resolve(duration);
        };
        audio.onerror = () => {
            cleanup();
            resolve(0);
        };
        audio.src = objectUrl;
    });
}

function guessAudioContentType(filename) {
    const extension = filename.split('.').pop().toLowerCase();
    if (extension === 'wav') return 'audio/wav';
    if (extension === 'mp3') return 'audio/mpeg';
    return 'application/octet-stream';
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
    renderPerformancePieceList();
}

function addPerformancePiece() {
    const composer = $('perfPieceComposer').value.trim();
    const title = $('perfPieceTitle').value.trim();
    if (!title) {
        showAlert('曲名を入力してください', 'warning');
        return;
    }

    appState.performancePieces.push({ composer, title });
    $('perfPieceComposer').value = '';
    $('perfPieceTitle').value = '';
    renderPerformancePieceList();
}

function removePerformancePiece(index) {
    appState.performancePieces.splice(index, 1);
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
            <button class="btn btn-sm btn-outline-danger" type="button">削除</button>
        `;
        item.querySelector('button').addEventListener('click', () => removePerformancePiece(index));
        list.appendChild(item);
    });
}

async function saveSchedule() {
    const startTime = $('schedStartTime').value;
    const endTime = $('schedEndTime').value;
    const availableStartTime = $('schedAvailableStartTime').value;
    const availableEndTime = $('schedAvailableEndTime').value;
    const payload = {
        date: $('schedDate').value,
        time: formatTimeRange(startTime, endTime),
        start_time: startTime,
        end_time: endTime,
        venue: $('schedVenue').value.trim(),
        available_hours: formatTimeRange(availableStartTime, availableEndTime),
        available_start_time: availableStartTime,
        available_end_time: availableEndTime,
        pieces: $('schedPieces').value.trim(),
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
    $('schedStartTime').value = '13:00';
    $('schedEndTime').value = '16:30';
    $('schedVenue').value = '';
    $('schedAvailableStartTime').value = '12:30';
    $('schedAvailableEndTime').value = '16:30';
    $('schedPieces').value = '';
    $('schedNotes').value = '';
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
            <td>${escapeHtml(scheduleTimeLabel(sched))}</td>
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
    renderRecordingList('songTreeAdmin', true);
    renderRecordingList('songTreeMember', false);
}

function renderRecordingList(containerId, canDelete) {
    const container = $(containerId);
    if (!appState.recordings.length) {
        container.innerHTML = '<p class="text-muted mb-0">録音ファイルはまだありません</p>';
        return;
    }

    const isMember = !canDelete;
    const groupedByDate = groupBy(appState.recordings, 'date');
    container.innerHTML = '';

    Object.entries(groupedByDate)
        .sort(([a], [b]) => String(b).localeCompare(String(a)))
        .forEach(([date, dateFiles]) => {
            const dateDetails = document.createElement('details');
            dateDetails.className = 'recording-date-group mb-3';
            dateDetails.open = true;

            const dateSummary = document.createElement('summary');
            dateSummary.className = 'recording-summary fw-bold';
            dateSummary.innerHTML = `
                <span>${escapeHtml(date || '未分類')}</span>
                <span class="small text-muted ms-2">${dateFiles.length}件</span>
            `;
            if (isMember) {
                dateSummary.appendChild(downloadGroupButton(dateFiles, `${date || '未分類'}_録音一括.zip`));
            }
            dateDetails.appendChild(dateSummary);

            const groupedByPiece = groupBy(dateFiles, 'piece');
            Object.entries(groupedByPiece)
                .sort(([a], [b]) => String(a).localeCompare(String(b), 'ja'))
                .forEach(([piece, pieceFiles]) => {
                    const pieceDetails = document.createElement('details');
                    pieceDetails.className = 'recording-piece-group ms-3 mt-2';
                    pieceDetails.open = true;

                    const pieceSummary = document.createElement('summary');
                    pieceSummary.className = 'recording-summary';
                    pieceSummary.innerHTML = `
                        <span>${escapeHtml(piece || '未分類')}</span>
                        <span class="small text-muted ms-2">${pieceFiles.length}件</span>
                    `;
                    if (isMember) {
                        pieceSummary.appendChild(downloadGroupButton(pieceFiles, `${date || '未分類'}_${piece || '未分類'}_録音一括.zip`));
                    }
                    pieceDetails.appendChild(pieceSummary);

                    const list = document.createElement('div');
                    list.className = 'list-group mt-2 mb-3';
                    pieceFiles.forEach((file) => {
                        const item = document.createElement('div');
                        item.className = 'list-group-item';
                        const downloadUrl = file.download_url || file.play_url || '#';
                        const durationLabel = formatDuration(file.duration_seconds);
                        const metaParts = [formatBytes(file.size)];
                        if (durationLabel) metaParts.push(durationLabel);

                        const actionButton = canDelete
                            ? '<button class="btn btn-sm btn-outline-danger delete-recording-btn" type="button">削除</button>'
                            : `<a class="btn btn-sm btn-primary" href="${escapeHtml(downloadUrl)}">DL</a>`;

                        item.innerHTML = `
                            <div class="d-flex justify-content-between align-items-center gap-3 flex-wrap">
                                <span>
                                    <strong>${escapeHtml(file.name)}</strong>
                                    <span class="small text-muted d-block">${escapeHtml(metaParts.join(' / '))}</span>
                                </span>
                                <span class="d-flex gap-2">${actionButton}</span>
                            </div>
                        `;

                        if (canDelete) {
                            item.querySelector('.delete-recording-btn').addEventListener('click', () => deleteRecording(file));
                        }
                        list.appendChild(item);
                    });
                    pieceDetails.appendChild(list);
                    dateDetails.appendChild(pieceDetails);
                });

            container.appendChild(dateDetails);
        });
}

function downloadGroupButton(files, filename) {
    const button = document.createElement('button');
    button.className = 'btn btn-sm btn-outline-primary ms-2';
    button.type = 'button';
    button.textContent = '配下一括DL';
    button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        downloadRecordingGroup(files, filename);
    });
    return button;
}

async function downloadRecordingGroup(files, filename) {
    if (!files.length) return;
    const response = await fetch('/api/recordings/download-zip', jsonOptions('POST', {
        filename,
        files: files.map((file) => ({
            source: file.source || 'local',
            object_name: file.object_name || file.id || '',
            path: file.path || '',
            name: file.name || 'recording.mp3'
        }))
    }));
    if (!response.ok) {
        showAlert('一括ダウンロードに失敗しました', 'danger');
        return;
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
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
            <ul class="mb-0">${(perf.pieces || []).map((piece) => `<li>${escapeHtml(performancePieceLabel(piece))}</li>`).join('')}</ul>
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
            <h5>${escapeHtml(sched.date)} ${escapeHtml(scheduleTimeLabel(sched))}</h5>
            <p>${escapeHtml(sched.venue || '')} / 利用可能: ${escapeHtml(scheduleAvailableLabel(sched))}</p>
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

function formatDuration(seconds) {
    const totalSeconds = Math.round(Number(seconds) || 0);
    if (!totalSeconds) return '';
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const secs = totalSeconds % 60;
    if (hours) return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    return `${minutes}:${String(secs).padStart(2, '0')}`;
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
