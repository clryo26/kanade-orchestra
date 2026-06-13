const KANADE_EXTERNAL_LINKS = {
    x: 'https://twitter.com/kanade_orche',
    facebook: 'https://facebook.com/zouokesutora',
    instagram: 'https://instagram.com/kanade.orchestra',
    youtube: 'https://www.youtube.com/@fukuoka-kanade-orchestra'
};

const KANADE_PORTAL_ICON = '/static/img/kanade-icon.svg';

const KANADE_MEMBER_PROFILES = [
    {
        section: '弦楽器',
        members: [
            { part: 'Violin', name: 'プロフィール募集中', role: '団員', message: '練習や本番を一緒に支える仲間です。自己紹介文は順次追加予定です。' },
            { part: 'Viola', name: 'プロフィール募集中', role: '団員', message: '中声部から響きを支えるパートです。' },
            { part: 'Cello / Contrabass', name: 'プロフィール募集中', role: '団員', message: '低音から合奏全体を支えるパートです。' }
        ]
    },
    {
        section: '管打楽器',
        members: [
            { part: 'Woodwinds', name: 'プロフィール募集中', role: '団員', message: '木管セクションのプロフィールを掲載予定です。' },
            { part: 'Brass', name: 'プロフィール募集中', role: '団員', message: '金管セクションのプロフィールを掲載予定です。' },
            { part: 'Percussion', name: 'プロフィール募集中', role: '団員', message: '打楽器セクションのプロフィールを掲載予定です。' }
        ]
    },
    {
        section: '運営・スタッフ',
        members: [
            { part: '運営', name: 'プロフィール募集中', role: '運営メンバー', message: '演奏会、練習、広報などを支えるメンバーです。' }
        ]
    }
];

const appState = {
    selectedFile: null,
    selectedFiles: [],
    performancePieces: [],
    performances: [],
    schedules: [],
    announcements: [],
    recordings: [],
    recordingsLoaded: false,
    recordingsLoading: null,
    members: [],
    selectedEventId: null
};

const today = () => {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
};
const $ = (id) => document.getElementById(id);
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

document.addEventListener('DOMContentLoaded', async () => {
    setDefaultDates();
    setupPortalExtension();
    setupPortalShell();
    portalExtensionReady = true;
    bindNavigation();
    bindUpload();
    bindForms();
    showMemberPanel();
    await loadAll();
    await loadPortalData();
    renderMemberViews();
    switchTab('memberPanel', 'member-announce');
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
    $('portalReloadBtn').addEventListener('click', reloadPortal);

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

    const schedVenue = $('schedVenue');
    const schedVenueOther = $('schedVenueOther');
    if (schedVenue && schedVenueOther) {
        schedVenue.addEventListener('change', syncScheduleVenueOther);
    }
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

    if (tabName === 'upload' || tabName === 'member-recording') {
        ensureRecordingsLoaded();
    }
    if (tabName === 'member-registration') {
        renderAdminMemberRegistration();
    }
    if (tabName.startsWith('member-')) {
        renderPortalTab(tabName);
    }
}

async function reloadPortal() {
    const button = $('portalReloadBtn');
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = 'リロード中...';
    try {
        await Promise.all([loadAll(), loadPortalData()]);
        if (!$('memberPanel').hidden) {
            renderMemberViews();
        }
        showAlert('最新情報に更新しました', 'success');
    } catch (error) {
        console.error(error);
        showAlert(`リロードに失敗しました: ${error.message}`, 'danger');
    } finally {
        button.disabled = false;
        button.textContent = originalText;
    }
}

function toPascalTab(value) {
    const map = {
        upload: 'upload',
        performance: 'performance',
        schedule: 'schedule',
        announcement: 'announcement',
        'member-registration': 'memberRegistration',
        'member-announce': 'memberAnnounce',
        'member-performance': 'memberPerformance',
        'member-schedule': 'memberSchedule',
        'member-recording': 'memberRecording',
        'member-profile': 'memberProfile',
        'member-absence': 'memberAbsence',
        'member-sheets': 'memberSheets',
        'member-payments': 'memberPayments',
        'member-roster': 'memberRoster',
        'member-events': 'memberEvents',
        'member-song-info': 'memberSongInfo',
        'member-album': 'memberAlbum',
        'member-sns': 'memberSns',
        'member-concert-records': 'memberConcertRecords'
    };
    return map[value] || value;
}

function formatDateWithWeekday(value) {
    if (!value) return '';
    const date = new Date(`${value}T00:00:00`);
    if (Number.isNaN(date.getTime())) return value;
    return `${value}（${WEEKDAYS[date.getDay()]}）`;
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
    const uploadDate = $('uploadDate').value.trim();
    const uploadPiece = $('uploadPiece').value.trim();

    if (!uploadDate) {
        showAlert('練習日は必須です', 'warning');
        $('uploadDate').focus();
        return;
    }
    if (!uploadPiece) {
        showAlert('曲名は必須です', 'warning');
        $('uploadPiece').focus();
        return;
    }
    if (!appState.selectedFiles.length) {
        showAlert('先にファイルを選択してください', 'warning');
        return;
    }

    setUploadControlsDisabled(true);
    resetUploadProgress(appState.selectedFiles);

    let completed = 0;
    try {
        for (const [index, file] of appState.selectedFiles.entries()) {
            setUploadProgress(index, 0, `${file.name} の準備中`, `${index + 1}/${appState.selectedFiles.length} 件目`);
            await uploadAudioFile(file, index, appState.selectedFiles.length);
            completed += 1;
            setUploadProgress(index, 100, `${file.name} の保存完了`, `${completed}/${appState.selectedFiles.length} 件完了`);
        }
        showAlert(`${completed} 件の録音ファイルを保存しました`, 'info');
        await loadRecordings();
        setUploadProgress(appState.selectedFiles.length - 1, 100, 'すべての録音ファイルを保存しました', '完了');
    } catch (error) {
        console.error(error);
        showAlert(`録音ファイルの保存に失敗しました: ${error.message}`, 'danger');
    } finally {
        setUploadControlsDisabled(false);
    }
}

async function uploadAudioFile(file, fileIndex = 0, totalFiles = 1) {
    // Cloud Run has a request-size limit, so send the audio body directly to GCS.
    // Cloud Run only creates the upload session and registers metadata.
    try {
        await uploadDirectlyToCloudStorage(file, fileIndex, totalFiles);
    } catch (error) {
        console.warn('Direct upload failed.', error);
        const canFallbackToCloudRun = file.size < 30 * 1024 * 1024;
        if (!canFallbackToCloudRun) {
            throw error;
        }
        showAlert('GCS直接アップロードに失敗しました。Cloud Run経由で再試行します。', 'warning');
        setUploadProgress(fileIndex, 5, `${file.name} をCloud Run経由で再試行中`, `${fileIndex + 1}/${totalFiles} 件目`);
        await request('/api/drive/upload', { method: 'POST', body: audioFormData(file) });
    }
}

async function uploadDirectlyToCloudStorage(file, fileIndex = 0, totalFiles = 1) {
    setUploadProgress(fileIndex, 5, `${file.name} の音声情報を確認中`, `${fileIndex + 1}/${totalFiles} 件目`);
    const metadata = await audioUploadMetadata(file);

    setUploadProgress(fileIndex, 12, `${file.name} のアップロードURLを取得中`, `${fileIndex + 1}/${totalFiles} 件目`);
    const session = await request('/api/drive/direct-upload-session', jsonOptions('POST', metadata));

    setUploadProgress(fileIndex, 15, `${file.name} をGCSへアップロード中`, `${fileIndex + 1}/${totalFiles} 件目`);
    await uploadFileWithProgress(session.upload_url, file, session.content_type || metadata.content_type, (percent) => {
        const scaledPercent = 15 + Math.round(percent * 0.75);
        setUploadProgress(fileIndex, scaledPercent, `${file.name} をGCSへアップロード中 ${percent}%`, `${fileIndex + 1}/${totalFiles} 件目`);
    });

    setUploadProgress(fileIndex, 92, `${file.name} の変換・登録情報を保存中`, `${fileIndex + 1}/${totalFiles} 件目`);
    await request('/api/drive/direct-upload-complete', jsonOptions('POST', {
        ...metadata,
        object_name: session.object_name
    }));
}

function uploadFileWithProgress(uploadUrl, file, contentType, onProgress) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', uploadUrl, true);
        xhr.setRequestHeader('Content-Type', contentType || file.type || 'application/octet-stream');
        xhr.upload.onprogress = (event) => {
            if (!event.lengthComputable) return;
            const percent = Math.min(100, Math.round((event.loaded / event.total) * 100));
            onProgress(percent);
        };
        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                onProgress(100);
                resolve();
            } else {
                reject(new Error(xhr.responseText || `GCS upload failed: ${xhr.status}`));
            }
        };
        xhr.onerror = () => reject(new Error('GCSアップロード中に通信エラーが発生しました'));
        xhr.onabort = () => reject(new Error('GCSアップロードが中断されました'));
        xhr.send(file);
    });
}

function resetUploadProgress(files) {
    const area = $('uploadProgressArea');
    const list = $('uploadProgressList');
    area.hidden = false;
    list.innerHTML = '';
    files.forEach((file, index) => {
        const li = document.createElement('li');
        li.id = `uploadProgressItem${index}`;
        li.textContent = `${file.name}: 待機中`;
        list.appendChild(li);
    });
    updateUploadProgressBar(0, 'アップロード準備中', '待機中');
}

function setUploadProgress(fileIndex, percent, status, title = '録音ファイル取り込み中') {
    updateUploadProgressBar(percent, title, status);
    const item = $(`uploadProgressItem${fileIndex}`);
    if (item) item.textContent = `${status} (${percent}%)`;
}

function updateUploadProgressBar(percent, title, status) {
    const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));
    $('uploadProgressTitle').textContent = title;
    $('uploadProgressPercent').textContent = `${safePercent}%`;
    $('uploadProgressStatus').textContent = status;
    $('uploadProgressBar').style.width = `${safePercent}%`;
    $('uploadProgressBar').setAttribute('aria-valuenow', String(safePercent));
}

function setUploadControlsDisabled(disabled) {
    $('uploadBtn').disabled = disabled;
    $('clearBtn').disabled = disabled;
    $('selectFileBtn').disabled = disabled;
    $('fileInput').disabled = disabled;
}

function updateAdminProgress(percent, title, status) {
    const area = $('adminProgressArea');
    if (!area) return;
    const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));
    area.hidden = false;
    $('adminProgressTitle').textContent = title || '処理中';
    $('adminProgressPercent').textContent = `${safePercent}%`;
    $('adminProgressStatus').textContent = status || '';
    $('adminProgressBar').style.width = `${safePercent}%`;
    $('adminProgressBar').setAttribute('aria-valuenow', String(safePercent));
}

function clearAdminProgressAfterDelay(delayMs = 1600) {
    window.setTimeout(() => {
        const area = $('adminProgressArea');
        if (area) area.hidden = true;
    }, delayMs);
}

function setButtonBusy(button, busyText) {
    if (!button) return () => {};
    const originalHtml = button.innerHTML;
    const originalDisabled = button.disabled;
    button.disabled = true;
    button.innerHTML = `<span class="spinner-border spinner-border-sm me-1" aria-hidden="true"></span>${escapeHtml(busyText)}`;
    return () => {
        button.innerHTML = originalHtml;
        button.disabled = originalDisabled;
    };
}

async function runAdminOperation(buttonOrId, title, status, operation) {
    const button = typeof buttonOrId === 'string' ? $(buttonOrId) : buttonOrId;
    const restoreButton = setButtonBusy(button, '処理中...');
    updateAdminProgress(10, title, status);
    try {
        const result = await operation();
        updateAdminProgress(100, title, '完了しました');
        clearAdminProgressAfterDelay();
        return result;
    } catch (error) {
        updateAdminProgress(100, title, `失敗しました: ${error.message}`);
        clearAdminProgressAfterDelay(4000);
        throw error;
    } finally {
        restoreButton();
    }
}

async function audioUploadMetadata(file) {
    return {
        filename: file.name,
        content_type: file.type || guessAudioContentType(file.name),
        size: file.size,
        date: document.getElementById('uploadDate').value,
        piece: document.getElementById('uploadPiece').value,
        duration_seconds: await getAudioDurationSeconds(file),
        bitrate: Number($('bitrate').value || 192)
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
    await Promise.all([loadPerformances(), loadSchedules(), loadAnnouncements()]);
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
    const data = await request('/api/recordings?limit=200');
    appState.recordings = data.files || [];
    appState.recordingsLoaded = true;
    renderRecordings();
}

async function ensureRecordingsLoaded(force = false) {
    if (appState.recordingsLoaded && !force) return;
    if (appState.recordingsLoading && !force) return appState.recordingsLoading;

    renderRecordingsLoading();
    appState.recordingsLoading = loadRecordings()
        .catch((error) => {
            console.error(error);
            appState.recordingsLoaded = false;
            showAlert(`録音一覧の読み込みに失敗しました: ${error.message}`, 'danger');
        })
        .finally(() => {
            appState.recordingsLoading = null;
        });
    return appState.recordingsLoading;
}

function renderRecordingsLoading() {
    ['songTreeAdmin', 'songTreeMember'].forEach((id) => {
        const container = $(id);
        if (container) {
            container.innerHTML = '<p class="text-muted mb-0">録音一覧を読み込み中...</p>';
        }
    });
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
    try {
        await runAdminOperation('addPerfBtn', '演奏会情報保存中', '入力内容を保存しています', async () => {
            updateAdminProgress(35, '演奏会情報保存中', 'サーバーへ送信中');
            await request(id ? `/api/performances/${id}` : '/api/performances', jsonOptions(id ? 'PUT' : 'POST', payload));
            updateAdminProgress(70, '演奏会情報保存中', '一覧を更新中');
            clearPerformanceForm();
            await loadPerformances();
        });
        showAlert('演奏会情報を保存しました', 'success');
    } catch (error) {
        console.error(error);
        showAlert(`演奏会情報の保存に失敗しました: ${error.message}`, 'danger');
    }
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
    try {
        await runAdminOperation('deletePerfBtn', '演奏会情報削除中', '削除しています', async () => {
            updateAdminProgress(35, '演奏会情報削除中', 'サーバーへ削除依頼中');
            await request(`/api/performances/${id}`, { method: 'DELETE' });
            updateAdminProgress(70, '演奏会情報削除中', '一覧を更新中');
            clearPerformanceForm();
            await loadPerformances();
        });
        showAlert('演奏会情報を削除しました', 'success');
    } catch (error) {
        console.error(error);
        showAlert(`演奏会情報の削除に失敗しました: ${error.message}`, 'danger');
    }
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
    if ($('perfPieceAlias')) $('perfPieceAlias').value = '';
    appState.performancePieces = [];
    renderPerformancePieceList();
}

function addPerformancePiece() {
    const composer = $('perfPieceComposer').value.trim();
    const title = $('perfPieceTitle').value.trim();
    const alias = $('perfPieceAlias') ? $('perfPieceAlias').value.trim() : '';
    if (!title) {
        showAlert('曲名を入力してください', 'warning');
        return;
    }

    appState.performancePieces.push({ composer, title, alias });
    $('perfPieceComposer').value = '';
    $('perfPieceTitle').value = '';
    if ($('perfPieceAlias')) $('perfPieceAlias').value = '';
    renderPerformancePieceList();
}

function removePerformancePiece(index) {
    appState.performancePieces.splice(index, 1);
    renderPerformancePieceList();
}

function movePerformancePiece(index, direction) {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= appState.performancePieces.length) return;
    const pieces = appState.performancePieces;
    [pieces[index], pieces[nextIndex]] = [pieces[nextIndex], pieces[index]];
    renderPerformancePieceList();
}

function currentPerformancePieces() {
    const composer = $('perfPieceComposer').value.trim();
    const title = $('perfPieceTitle').value.trim();
    const alias = $('perfPieceAlias') ? $('perfPieceAlias').value.trim() : '';
    const pieces = [...appState.performancePieces];
    if (title) {
        pieces.push({ composer, title, alias });
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
            title: piece.title || piece.name || '',
            alias: piece.alias || piece.short_name || piece.shortName || ''
        };
    }).filter((piece) => piece.title);
}

function performancePieceLabel(piece) {
    if (typeof piece === 'string') return piece;
    const base = piece.composer ? `${piece.composer}: ${piece.title}` : piece.title;
    return piece.alias ? `${base}（${piece.alias}）` : base;
}

function renderPerformancePieceList() {
    const list = $('perfPieceList');
    list.innerHTML = emptyText(appState.performancePieces, '曲目はまだありません');
    appState.performancePieces.forEach((piece, index) => {
        const item = document.createElement('li');
        item.className = 'list-group-item d-flex justify-content-between align-items-center gap-3';
        item.innerHTML = `
            <span><span class="text-muted me-2">${index + 1}.</span>${escapeHtml(performancePieceLabel(piece))}</span>
            <span class="piece-order-buttons">
                <button class="btn btn-sm btn-outline-secondary" type="button" data-action="up" ${index === 0 ? 'disabled' : ''}>↑</button>
                <button class="btn btn-sm btn-outline-secondary" type="button" data-action="down" ${index === appState.performancePieces.length - 1 ? 'disabled' : ''}>↓</button>
                <button class="btn btn-sm btn-outline-danger" type="button" data-action="delete">削除</button>
            </span>
        `;
        item.querySelector('[data-action="up"]').addEventListener('click', () => movePerformancePiece(index, -1));
        item.querySelector('[data-action="down"]').addEventListener('click', () => movePerformancePiece(index, 1));
        item.querySelector('[data-action="delete"]').addEventListener('click', () => removePerformancePiece(index));
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
        venue: currentScheduleVenue(),
        available_hours: formatTimeRange(availableStartTime, availableEndTime),
        available_start_time: availableStartTime,
        available_end_time: availableEndTime,
        pieces: $('schedPieces').value.trim(),
        notes: $('schedNotes').value.trim(),
        conductor_training: $('schedConductorTraining').checked
    };
    if (!payload.date || !payload.start_time || !payload.end_time) {
        showAlert('練習日と開始時間を入力してください', 'warning');
        return;
    }

    const id = $('schedId').value;
    try {
        await runAdminOperation('addSchedBtn', '練習予定保存中', '入力内容を保存しています', async () => {
            updateAdminProgress(35, '練習予定保存中', 'サーバーへ送信中');
            await request(id ? `/api/schedules/${id}` : '/api/schedules', jsonOptions(id ? 'PUT' : 'POST', payload));
            updateAdminProgress(70, '練習予定保存中', '一覧を更新中');
            clearScheduleForm();
            await loadSchedules();
        });
        showAlert('練習予定を保存しました', 'success');
    } catch (error) {
        console.error(error);
        showAlert(`練習予定の保存に失敗しました: ${error.message}`, 'danger');
    }
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
    setScheduleVenue(item.venue || '');
    $('schedAvailableStartTime').value = item.available_start_time || availableRange.start || '12:30';
    $('schedAvailableEndTime').value = item.available_end_time || availableRange.end || '16:30';
    $('schedPieces').value = item.pieces || '';
    $('schedNotes').value = item.notes || '';
    $('schedConductorTraining').checked = Boolean(item.conductor_training);
}

async function deleteSchedule() {
    const id = $('schedId').value;
    if (!id) {
        showAlert('削除する練習予定を一覧から選択してください', 'warning');
        return;
    }
    try {
        await runAdminOperation('deleteSchedBtn', '練習予定削除中', '削除しています', async () => {
            updateAdminProgress(35, '練習予定削除中', 'サーバーへ削除依頼中');
            await request(`/api/schedules/${id}`, { method: 'DELETE' });
            updateAdminProgress(70, '練習予定削除中', '一覧を更新中');
            clearScheduleForm();
            await loadSchedules();
        });
        showAlert('練習予定を削除しました', 'success');
    } catch (error) {
        console.error(error);
        showAlert(`練習予定の削除に失敗しました: ${error.message}`, 'danger');
    }
}

function clearScheduleForm() {
    $('schedId').value = '';
    $('schedDate').value = today();
    $('schedStartTime').value = '13:00';
    $('schedEndTime').value = '16:30';
    setScheduleVenue('');
    $('schedAvailableStartTime').value = '12:30';
    $('schedAvailableEndTime').value = '16:30';
    $('schedPieces').value = '';
    $('schedNotes').value = '';
    $('schedConductorTraining').checked = false;
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

function currentScheduleVenue() {
    const selected = $('schedVenue')?.value || '';
    if (selected === 'その他') {
        return $('schedVenueOther')?.value.trim() || '';
    }
    return selected.trim();
}

function setScheduleVenue(value) {
    const select = $('schedVenue');
    const other = $('schedVenueOther');
    if (!select) return;
    const options = Array.from(select.options || []).map((option) => option.value);
    if (!value) {
        select.value = '';
        if (other) other.value = '';
    } else if (options.includes(value)) {
        select.value = value;
        if (other) other.value = '';
    } else {
        select.value = 'その他';
        if (other) other.value = value;
    }
    syncScheduleVenueOther();
}

function syncScheduleVenueOther() {
    const other = $('schedVenueOther');
    if (!other) return;
    other.hidden = $('schedVenue')?.value !== 'その他';
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
    try {
        await runAdminOperation('addAnnBtn', 'お知らせ保存中', '入力内容を保存しています', async () => {
            updateAdminProgress(35, 'お知らせ保存中', 'サーバーへ送信中');
            await request(id ? `/api/announcements/${id}` : '/api/announcements', jsonOptions(id ? 'PUT' : 'POST', payload));
            updateAdminProgress(70, 'お知らせ保存中', '一覧を更新中');
            clearAnnouncementForm();
            await loadAnnouncements();
        });
        showAlert('お知らせを保存しました', 'success');
    } catch (error) {
        console.error(error);
        showAlert(`お知らせの保存に失敗しました: ${error.message}`, 'danger');
    }
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
    try {
        await runAdminOperation('deleteAnnBtn', 'お知らせ削除中', '削除しています', async () => {
            updateAdminProgress(35, 'お知らせ削除中', 'サーバーへ削除依頼中');
            await request(`/api/announcements/${id}`, { method: 'DELETE' });
            updateAdminProgress(70, 'お知らせ削除中', '一覧を更新中');
            clearAnnouncementForm();
            await loadAnnouncements();
        });
        showAlert('お知らせを削除しました', 'success');
    } catch (error) {
        console.error(error);
        showAlert(`お知らせの削除に失敗しました: ${error.message}`, 'danger');
    }
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
            <div class="small text-muted">${escapeHtml(formatDateWithWeekday(perf.date))} / ${escapeHtml(perf.venue || '会場未定')} / 指揮: ${escapeHtml(perf.conductor || '未定')}</div>
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
                <thead><tr><th>日付</th><th>時間</th><th>場所</th><th>指揮トレ</th><th>曲</th><th>備考</th></tr></thead>
                <tbody></tbody>
            </table>
        </div>
    `;
    const body = container.querySelector('tbody');
    [...appState.schedules]
        .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')) || String(scheduleTimeLabel(a)).localeCompare(String(scheduleTimeLabel(b))))
        .forEach((sched) => {
        const row = document.createElement('tr');
        row.className = 'clickable-row';
        row.innerHTML = `
            <td>${escapeHtml(formatDateWithWeekday(sched.date))}</td>
            <td>${escapeHtml(scheduleTimeLabel(sched))}</td>
            <td>${escapeHtml(sched.venue || '')}</td>
            <td>${sched.conductor_training ? '<span class="conductor-training-label">※指揮トレ</span>' : ''}</td>
            <td>${escapeHtml(sched.pieces || '')}</td>
            <td class="multiline-text">${escapeHtml(sched.notes || '')}</td>
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
    item.innerHTML = `<span class="small text-muted">${escapeHtml(formatDateWithWeekday(ann.date))}</span><br>${escapeHtml(ann.content)}`;
    if (selectable) item.addEventListener('click', () => selectAnnouncement(ann.id));
    return item;
}

function renderRecordings() {
    if (!appState.recordingsLoaded && !appState.recordingsLoading) {
        ['songTreeAdmin', 'songTreeMember'].forEach((id) => {
            const container = $(id);
            if (container) {
                container.innerHTML = '<button class="btn btn-outline-primary btn-sm load-recordings-btn" type="button">録音一覧を読み込む</button>';
                container.querySelector('.load-recordings-btn').addEventListener('click', () => ensureRecordingsLoaded());
            }
        });
        return;
    }
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
        .forEach(([date, dateFiles], dateIndex) => {
            const dateDetails = document.createElement('details');
            dateDetails.className = 'recording-date-group mb-3';
            // 団員メニューでは一番新しい練習日だけ開き、それ以外は折りたたむ。
            // 管理者メニューは従来どおり全件を開いた状態にする。
            dateDetails.open = canDelete || dateIndex === 0;

            const dateSummary = document.createElement('summary');
            dateSummary.className = 'recording-summary fw-bold';
            dateSummary.innerHTML = `
                <span>${escapeHtml(date || '未分類')}</span>
                <span class="small text-muted ms-2">${dateFiles.length}件</span>
            `;
            if (isMember) {
                dateSummary.appendChild(downloadGroupButton(dateFiles, `${date || '未分類'}_録音一括.zip`));
            } else {
                dateSummary.appendChild(deleteGroupButton(dateFiles, `${date || '未分類'} の録音 ${dateFiles.length}件`));
            }
            dateDetails.appendChild(dateSummary);

            const groupedByPiece = groupBy(dateFiles, 'piece');
            Object.entries(groupedByPiece)
                .sort(([a], [b]) => String(a).localeCompare(String(b), 'ja'))
                .forEach(([piece, pieceFiles]) => {
                    const pieceDetails = document.createElement('details');
                    pieceDetails.className = 'recording-piece-group ms-3 mt-2';
                    // 練習日を開いた直後は、最新日を含めて曲ごとの一覧は折りたたんだ状態にする。
                    pieceDetails.open = false;

                    const pieceSummary = document.createElement('summary');
                    pieceSummary.className = 'recording-summary';
                    pieceSummary.innerHTML = `
                        <span>${escapeHtml(piece || '未分類')}</span>
                        <span class="small text-muted ms-2">${pieceFiles.length}件</span>
                    `;
                    if (isMember) {
                        pieceSummary.appendChild(downloadGroupButton(pieceFiles, `${date || '未分類'}_${piece || '未分類'}_録音一括.zip`));
                    } else {
                        pieceSummary.appendChild(deleteGroupButton(pieceFiles, `${date || '未分類'} / ${piece || '未分類'} の録音 ${pieceFiles.length}件`));
                    }
                    pieceDetails.appendChild(pieceSummary);

                    const list = document.createElement('div');
                    list.className = 'list-group mt-2 mb-3';
                    pieceFiles.forEach((file) => {
                        const item = document.createElement('div');
                        item.className = 'list-group-item';
                        const downloadUrl = file.download_url || file.play_url || '#';
                        const durationLabel = formatDuration(recordingDurationSeconds(file));
                        const metaParts = [`サイズ: ${formatBytes(file.size)}`, `長さ: ${durationLabel || '未取得'}`];

                        const playUrl = normalizeMediaUrl(file.play_url || downloadUrl);
                        const safeDownloadUrl = normalizeMediaUrl(downloadUrl);
                        const actionButton = canDelete
                            ? '<button class="btn btn-sm btn-outline-danger delete-recording-btn" type="button">削除</button>'
                            : `
                                <button class="btn btn-sm btn-outline-success play-recording-btn" type="button">再生</button>
                                <a class="btn btn-sm btn-primary" href="${escapeHtml(safeDownloadUrl)}">DL</a>
                            `;

                        item.innerHTML = `
                            <div class="d-flex justify-content-between align-items-center gap-3 flex-wrap">
                                <span>
                                    <strong>${escapeHtml(file.name)}</strong>
                                    <span class="small text-muted d-block">${escapeHtml(metaParts.join(' / '))}</span>
                                </span>
                                <span class="d-flex gap-2">${actionButton}</span>
                            </div>
                            ${canDelete ? '' : `<div class="recording-player-slot mt-2" data-play-url="${escapeHtml(playUrl)}" hidden></div>`}
                        `;

                        if (canDelete) {
                            item.querySelector('.delete-recording-btn').addEventListener('click', (event) => deleteRecording(file, event.currentTarget));
                        } else {
                            item.querySelector('.play-recording-btn').addEventListener('click', () => toggleRecordingPlayback(item));
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

function deleteGroupButton(files, label) {
    const button = document.createElement('button');
    button.className = 'btn btn-sm btn-outline-danger ms-2';
    button.type = 'button';
    button.textContent = '配下一括削除';
    button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        deleteRecordingGroup(files, label, button);
    });
    return button;
}

async function deleteRecordingGroup(files, label, button) {
    if (!files.length) return;
    if (!confirm(`${label} を一括削除します。よろしいですか？`)) return;

    try {
        await runAdminOperation(button, '録音ファイル一括削除中', `${label} の削除を開始します`, async () => {
            for (const [index, file] of files.entries()) {
                const percent = Math.round(((index + 1) / files.length) * 90);
                updateAdminProgress(5 + percent, '録音ファイル一括削除中', `${index + 1}/${files.length} 件目を削除中: ${file.name}`);
                await request('/api/recordings', jsonOptions('DELETE', {
                    source: file.source || 'local',
                    object_name: file.object_name || file.id || '',
                    path: file.path || ''
                }));
            }
            updateAdminProgress(95, '録音ファイル一括削除中', '一覧を更新中');
            await loadRecordings();
        });
        showAlert(`${files.length} 件の録音ファイルを削除しました`, 'success');
    } catch (error) {
        console.error(error);
        showAlert(`録音ファイルの一括削除に失敗しました: ${error.message}`, 'danger');
    }
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

async function deleteRecording(file, button = null) {
    if (!confirm(`${file.name} を削除しますか？`)) return;

    try {
        await runAdminOperation(button, '録音ファイル削除中', `${file.name} を削除しています`, async () => {
            updateAdminProgress(35, '録音ファイル削除中', 'サーバーへ削除依頼中');
            await request('/api/recordings', jsonOptions('DELETE', {
                source: file.source || 'local',
                object_name: file.object_name || file.id || '',
                path: file.path || ''
            }));
            updateAdminProgress(75, '録音ファイル削除中', '一覧を更新中');
            await loadRecordings();
        });
        showAlert('録音ファイルを削除しました', 'success');
    } catch (error) {
        console.error(error);
        showAlert(`録音ファイルの削除に失敗しました: ${error.message}`, 'danger');
    }
}

function renderMemberViews() {
    renderMemberPerformances();
    renderMemberSchedules();
    renderAnnouncements();
    renderRecordings();
    renderMemberProfile();
    renderMemberSns();
    renderMemberConcertRecords();
}

function toggleRecordingPlayback(item) {
    const button = item.querySelector('.play-recording-btn');
    const slot = item.querySelector('.recording-player-slot');
    if (!slot || !button) return;

    let audio = slot.querySelector('.recording-player');
    if (!audio) {
        audio = document.createElement('audio');
        audio.className = 'recording-player w-100';
        audio.controls = true;
        audio.preload = 'auto';
        audio.src = normalizeMediaUrl(slot.dataset.playUrl || '');
        slot.appendChild(audio);
        audio.load();
    }

    document.querySelectorAll('.recording-player').forEach((otherAudio) => {
        if (otherAudio !== audio) {
            otherAudio.pause();
            const otherSlot = otherAudio.closest('.recording-player-slot');
            if (otherSlot) otherSlot.hidden = true;
            const otherButton = otherAudio.closest('.list-group-item')?.querySelector('.play-recording-btn');
            if (otherButton) otherButton.textContent = '再生';
        }
    });

    slot.hidden = false;
    if (audio.paused) {
        button.disabled = true;
        button.textContent = '読込中';
        audio.play()
            .then(() => {
                button.disabled = false;
                button.textContent = '停止';
            })
            .catch((error) => {
                button.disabled = false;
                button.textContent = '再生';
                slot.hidden = true;
                showAlert(`再生できませんでした: ${error.message}`, 'danger');
            });
    } else {
        audio.pause();
        button.textContent = '再生';
    }

    audio.onended = () => {
        button.textContent = '再生';
        slot.hidden = true;
    };
}

function normalizeMediaUrl(url) {
    const value = String(url || '').trim();
    if (!value || value === '#') return '#';
    try {
        const parsed = new URL(value, window.location.origin);
        return parsed.origin === window.location.origin
            ? `${parsed.pathname.split('/').map((part) => encodeURIComponent(decodeURIComponent(part))).join('/')}${parsed.search}${parsed.hash}`
            : parsed.href;
    } catch {
        return value;
    }
}


function externalLinkButton(url, label, variant = 'outline-primary') {
    return `
        <a class="btn btn-${variant} btn-lg external-link-button" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">
            ${escapeHtml(label)}
        </a>
    `;
}

function renderMemberProfile() {
    const container = $('memberProfileInfo');
    if (!container) return;
    const registeredSections = memberProfileSections();
    const sections = registeredSections.length ? registeredSections : KANADE_MEMBER_PROFILES;
    container.innerHTML = `
        <div class="profile-hero mb-3">
            <img class="profile-hero-icon" src="${escapeHtml(KANADE_PORTAL_ICON)}" alt="福岡奏オーケストラ">
            <div>
                <h4 class="mb-1">福岡奏オーケストラ 団員プロフィール</h4>
                <p class="text-muted mb-0">団員のパートやひとことを、ポータル内で見られるようにした紹介ページです。</p>
            </div>
        </div>
        <div class="profile-section-list">
            ${sections.map((section) => `
                <section class="profile-section">
                    <h5>${escapeHtml(section.section)}</h5>
                    <div class="profile-grid">
                        ${section.members.map((member) => `
                            <article class="profile-card">
                                ${member.photo_url
                                    ? `<img class="profile-photo" src="${escapeHtml(member.photo_url)}" alt="${escapeHtml(member.name)}">`
                                    : `<div class="profile-avatar">${escapeHtml((member.part || member.name || '?').slice(0, 1))}</div>`}
                                <div>
                                    <div class="profile-part">${escapeHtml(member.part)}</div>
                                    <h6>${escapeHtml(member.name)}</h6>
                                    <p class="profile-role">${escapeHtml(member.role)}</p>
                                    <p class="mb-0">${escapeHtml(member.message)}</p>
                                </div>
                            </article>
                        `).join('')}
                    </div>
                </section>
            `).join('')}
        </div>
    `;
}

function memberProfileSections() {
    const rows = (appState.members || []).map(portalData);
    if (!rows.length) return [];
    const grouped = groupBy(rows, 'part');
    return Object.entries(grouped).map(([part, members]) => ({
        section: part,
        members: members.map((member) => ({
            part: member.part || '',
            name: member.name || '',
            role: member.role || '団員',
            photo_url: member.photo_url || '',
            message: [
                member.comment,
                member.joined_at ? `入団年月: ${member.joined_at}` : '',
                member.instrument_history ? `楽器歴: ${member.instrument_history}` : '',
                member.previous_orchestras ? `過去所属オケ: ${member.previous_orchestras}` : '',
                member.introducer ? `紹介者: ${member.introducer}` : ''
            ].filter(Boolean).join('\n')
        }))
    }));
}

function renderMemberSns() {
    const container = $('memberSnsInfo');
    if (!container) return;
    container.innerHTML = `
        <p class="text-muted">奏オケの公式SNSを開きます。</p>
        <div class="external-link-list">
            <div class="external-link-card">
                <div>
                    <strong>X (Twitter)</strong>
                    <p class="text-muted mb-0">最新情報・お知らせ</p>
                </div>
                ${externalLinkButton(KANADE_EXTERNAL_LINKS.x, 'X (Twitter)を開く', 'outline-dark')}
            </div>
            <div class="external-link-card">
                <div>
                    <strong>Facebook</strong>
                    <p class="text-muted mb-0">演奏会情報・イベント情報</p>
                </div>
                ${externalLinkButton(KANADE_EXTERNAL_LINKS.facebook, 'Facebookを開く', 'outline-primary')}
            </div>
            <div class="external-link-card">
                <div>
                    <strong>Instagram</strong>
                    <p class="text-muted mb-0">写真・動画</p>
                </div>
                ${externalLinkButton(KANADE_EXTERNAL_LINKS.instagram, 'Instagramを開く', 'outline-danger')}
            </div>
        </div>
    `;
}

function renderMemberConcertRecords() {
    const container = $('memberConcertRecordsInfo');
    if (!container) return;
    container.innerHTML = `
        <p class="text-muted">奏オケの演奏会動画・記録を確認できます。</p>
        <div class="external-link-list">
            <div class="external-link-card">
                <div>
                    <strong>奏オケ公式YouTube</strong>
                    <p class="text-muted mb-0">演奏会動画・過去の記録</p>
                </div>
                ${externalLinkButton(KANADE_EXTERNAL_LINKS.youtube, 'YouTubeチャンネルを開く', 'outline-danger')}
            </div>
        </div>
    `;
}

function renderMemberPerformances() {
    const container = $('memberPerfInfo');
    if (!appState.performances.length) {
        container.innerHTML = '<p class="text-muted mb-0">演奏会情報はまだありません</p>';
        return;
    }
    const perf = upcomingPerformance();
    const countdownHtml = perf ? `
        <div class="portal-countdown mb-3">
            <strong>本番まであと${Math.max(0, Math.ceil((new Date(`${perf.date}T00:00:00`) - new Date(`${today()}T00:00:00`)) / 86400000))}日！</strong>
            <span>${escapeHtml(perf.title || '')}</span>
        </div>
    ` : '';
    container.innerHTML = countdownHtml + appState.performances.map((perf) => `
        <article class="info-block">
            <h5>${escapeHtml(perf.title)}</h5>
            <p>${escapeHtml(formatDateWithWeekday(perf.date))} ${escapeHtml(perf.open_time)}開場 / ${escapeHtml(perf.start_time)}開演</p>
            <p>${escapeHtml(perf.venue || '会場未定')} / 指揮: ${escapeHtml(perf.conductor || '未定')}</p>
            <ul class="mb-0">${(perf.pieces || []).map((piece) => `<li>${escapeHtml(performancePieceLabel(piece))}</li>`).join('')}</ul>
        </article>
    `).join('');
}

function renderMemberSchedules() {
    const container = $('memberSchedInfo');
    const todayValue = today();
    const upcomingSchedules = appState.schedules
        .filter((sched) => String(sched.date || '') >= todayValue)
        .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')) || String(scheduleTimeLabel(a)).localeCompare(String(scheduleTimeLabel(b))));

    if (!upcomingSchedules.length) {
        container.innerHTML = '<p class="text-muted mb-0">今後の練習予定はまだありません</p>';
        return;
    }
    container.innerHTML = upcomingSchedules.map((sched, index) => `
        <article class="info-block">
            <div class="d-flex flex-wrap justify-content-between align-items-start gap-2">
                <div>
                    <h5>${escapeHtml(formatDateWithWeekday(sched.date))} ${escapeHtml(scheduleTimeLabel(sched))}</h5>
                    <p>${escapeHtml(sched.venue || '')} / 利用可能: ${escapeHtml(scheduleAvailableLabel(sched))}</p>
                    ${sched.conductor_training ? '<p class="conductor-training-label mb-1">※指揮トレ</p>' : ''}
                    <p>${escapeHtml(sched.pieces || '')}</p>
                    <p class="mb-0 text-muted multiline-text">${escapeHtml(sched.notes || '')}</p>
                </div>
                <button class="btn btn-outline-primary btn-sm add-google-calendar-btn" type="button" data-schedule-index="${index}">Googleカレンダーに追加</button>
            </div>
        </article>
    `).join('');
    container.querySelectorAll('.add-google-calendar-btn').forEach((button) => {
        button.addEventListener('click', () => {
            const schedule = upcomingSchedules[Number(button.dataset.scheduleIndex)];
            const url = buildGoogleCalendarUrl(schedule);
            window.open(url, '_blank', 'noopener');
        });
    });
}

function buildGoogleCalendarUrl(sched) {
    const titleParts = ['奏オケ 練習'];
    if (sched.conductor_training) titleParts.push('指揮トレ');
    if (sched.pieces) titleParts.push(sched.pieces);

    const details = [
        sched.conductor_training ? '※指揮トレ' : '',
        sched.pieces ? `練習曲: ${sched.pieces}` : '',
        sched.notes || '',
        scheduleAvailableLabel(sched) ? `利用可能時間: ${scheduleAvailableLabel(sched)}` : ''
    ].filter(Boolean).join('\n');

    const params = new URLSearchParams({
        action: 'TEMPLATE',
        text: titleParts.join(' / '),
        dates: googleCalendarDateRange(sched),
        location: sched.venue || '',
        details
    });
    return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

function googleCalendarDateRange(sched) {
    const date = String(sched.date || '').replace(/-/g, '');
    const start = String(sched.start_time || splitTimeRange(sched.time).start || '').replace(':', '');
    const end = String(sched.end_time || splitTimeRange(sched.time).end || '').replace(':', '');
    if (date && start && end) {
        return `${date}T${start.padEnd(6, '0')}/${date}T${end.padEnd(6, '0')}`;
    }
    return `${date}/${date}`;
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

function recordingDurationSeconds(file) {
    return Number(
        file.duration_seconds
        ?? file.durationSeconds
        ?? file.duration
        ?? file.audio_duration_seconds
        ?? file.metadata?.duration_seconds
        ?? 0
    ) || 0;
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

const PORTAL_ADMIN_PASSWORD = 'kanadeadmin';
const PORTAL_COLLECTIONS = [
    'absences',
    'sheet_library',
    'payments',
    'rosters',
    'events',
    'event_responses',
    'song_info',
    'albums',
    'members'
];
let portalExtensionReady = false;

Object.assign(appState, {
    absences: [],
    sheetLibrary: [],
    payments: [],
    rosters: [],
    events: [],
    eventResponses: [],
    songInfo: [],
    albums: [],
    members: [],
    portalLoaded: false
});

function showAdminPanel() {
    if (!portalExtensionReady) {
        $('adminPanel').hidden = true;
        $('memberPanel').hidden = false;
        localStorage.setItem('userRole', 'member');
        return;
    }

    if (sessionStorage.getItem('adminUnlocked') !== 'true') {
        const password = prompt('管理者パスワードを入力してください');
        if (password !== PORTAL_ADMIN_PASSWORD) {
            showAlert('管理者パスワードが違います', 'warning');
            showMemberPanel();
            return;
        }
        sessionStorage.setItem('adminUnlocked', 'true');
    }

    $('adminPanel').hidden = false;
    $('memberPanel').hidden = true;
    localStorage.setItem('userRole', 'admin');
}

function setupPortalExtension() {
    const toolbar = document.querySelector('#memberPanel .toolbar');
    if (!toolbar || $('memberAbsenceTab')) return;

    [
        ['member-absence', '欠席連絡'],
        ['member-sheets', '楽譜ライブラリ'],
        ['member-payments', '支払状況'],
        ['member-roster', '乗り番表'],
        ['member-events', 'イベント調整'],
        ['member-song-info', '楽曲情報'],
        ['member-album', 'アルバム']
    ].forEach(([tab, label]) => {
        const button = document.createElement('button');
        button.className = 'btn btn-sm btn-outline-secondary';
        button.dataset.tab = tab;
        button.type = 'button';
        button.textContent = label;
        toolbar.appendChild(button);
    });

    const panel = $('memberPanel');
    panel.insertAdjacentHTML('beforeend', `
        <div id="memberAbsenceTab" class="tab-content" hidden><div class="card"><div class="card-header">欠席連絡</div><div class="card-body" id="memberAbsenceInfo"></div></div></div>
        <div id="memberSheetsTab" class="tab-content" hidden><div class="card"><div class="card-header">楽譜ライブラリ</div><div class="card-body" id="memberSheetsInfo"></div></div></div>
        <div id="memberPaymentsTab" class="tab-content" hidden><div class="card"><div class="card-header">支払状況</div><div class="card-body" id="memberPaymentsInfo"></div></div></div>
        <div id="memberRosterTab" class="tab-content" hidden><div class="card"><div class="card-header">乗り番表</div><div class="card-body" id="memberRosterInfo"></div></div></div>
        <div id="memberEventsTab" class="tab-content" hidden><div class="card"><div class="card-header">イベント調整</div><div class="card-body" id="memberEventsInfo"></div></div></div>
        <div id="memberSongInfoTab" class="tab-content" hidden><div class="card"><div class="card-header">楽曲情報</div><div class="card-body" id="memberSongInfoInfo"></div></div></div>
        <div id="memberAlbumTab" class="tab-content" hidden><div class="card"><div class="card-header">アルバム</div><div class="card-body" id="memberAlbumInfo"></div></div></div>
    `);
}

function setupPortalShell() {
    const brand = document.querySelector('.navbar-brand');
    if (brand) {
        brand.innerHTML = `
            <img class="portal-brand-icon" src="${escapeHtml(KANADE_PORTAL_ICON)}" alt="福岡奏オーケストラ">
            <span>福岡奏オーケストラ ポータル</span>
        `;
    }

    const reloadButton = $('portalReloadBtn');
    if (reloadButton) {
        reloadButton.textContent = '更新';
    }

    const memberButton = $('memberMenuBtn');
    if (memberButton) {
        memberButton.hidden = true;
    }

    const adminButton = $('adminMenuBtn');
    const memberToolbar = document.querySelector('#memberPanel .toolbar');
    if (adminButton && memberToolbar && adminButton.parentElement !== memberToolbar) {
        adminButton.textContent = '管理メニュー';
        adminButton.className = 'btn btn-sm btn-outline-secondary portal-admin-menu-btn';
        memberToolbar.appendChild(adminButton);
    }

    setupAdminEnhancements();
}

function setupAdminEnhancements() {
    setupPerformanceAliasInput();
    setupScheduleVenueSelect();
    setupMemberRegistrationTab();
}

function setupPerformanceAliasInput() {
    const titleInput = $('perfPieceTitle');
    if (!titleInput || $('perfPieceAlias')) return;
    titleInput.placeholder = '例: 交響曲第5番';
    const composerInput = $('perfPieceComposer');
    if (composerInput) composerInput.placeholder = '例: チャイコフスキー';
    const titleColumn = titleInput.closest('[class*="col-"]');
    titleColumn?.insertAdjacentHTML('afterend', `
        <div class="col-md-2">
            <label class="form-label" for="perfPieceAlias">略称</label>
            <input type="text" class="form-control" id="perfPieceAlias" placeholder="例: チャイ5">
        </div>
    `);
}

function setupScheduleVenueSelect() {
    const venueInput = $('schedVenue');
    if (!venueInput || venueInput.tagName === 'SELECT') return;
    const select = document.createElement('select');
    select.id = 'schedVenue';
    select.className = 'form-select';
    select.innerHTML = `
        <option value="">選択してください</option>
        <option value="千早音楽練習場　大練習室">千早音楽練習場　大練習室</option>
        <option value="千早音楽練習場　中練習室">千早音楽練習場　中練習室</option>
        <option value="パピオ">パピオ</option>
        <option value="その他">その他</option>
    `;
    const other = document.createElement('input');
    other.id = 'schedVenueOther';
    other.className = 'form-control mt-2';
    other.placeholder = '練習場所を入力';
    other.hidden = true;
    venueInput.replaceWith(select);
    select.insertAdjacentElement('afterend', other);
}

function setupMemberRegistrationTab() {
    const adminToolbar = document.querySelector('#adminPanel .toolbar');
    const adminPanel = $('adminPanel');
    if (!adminToolbar || !adminPanel || $('memberRegistrationTab')) return;

    const button = document.createElement('button');
    button.className = 'btn btn-sm btn-outline-primary';
    button.dataset.tab = 'member-registration';
    button.type = 'button';
    button.textContent = '団員登録';
    adminToolbar.appendChild(button);

    adminPanel.insertAdjacentHTML('beforeend', `
        <div id="memberRegistrationTab" class="tab-content" hidden>
            <div class="card">
                <div class="card-header">団員登録</div>
                <div class="card-body" id="memberRegistrationInfo"></div>
            </div>
        </div>
    `);
}

function renderAdminMemberRegistration() {
    const container = $('memberRegistrationInfo');
    if (!container) return;
    container.innerHTML = `
        <form id="memberRegistrationForm" class="row g-3 mb-3">
            <div class="col-md-3">
                <label class="form-label" for="memberPhoto">写真</label>
                <input id="memberPhoto" name="photo" type="file" accept="image/*" class="form-control">
            </div>
            <div class="col-md-3">
                <label class="form-label" for="memberName">名前</label>
                <input id="memberName" name="name" class="form-control" required>
            </div>
            <div class="col-md-2">
                <label class="form-label" for="memberPart">パート</label>
                <input id="memberPart" name="part" class="form-control" placeholder="例: Vn">
            </div>
            <div class="col-md-2">
                <label class="form-label" for="memberJoinedAt">入団年月</label>
                <input id="memberJoinedAt" name="joined_at" type="month" class="form-control">
            </div>
            <div class="col-md-2">
                <label class="form-label" for="memberIntroducer">紹介者</label>
                <input id="memberIntroducer" name="introducer" class="form-control">
            </div>
            <div class="col-md-3">
                <label class="form-label" for="memberRole">役割</label>
                <input id="memberRole" name="role" class="form-control" placeholder="例: 団員 / 係">
            </div>
            <div class="col-md-3">
                <label class="form-label" for="memberInstrumentHistory">楽器歴</label>
                <input id="memberInstrumentHistory" name="instrument_history" class="form-control">
            </div>
            <div class="col-md-3">
                <label class="form-label" for="memberPreviousOrchestras">過去所属オケ</label>
                <input id="memberPreviousOrchestras" name="previous_orchestras" class="form-control">
            </div>
            <div class="col-md-3 d-flex align-items-end">
                <button class="btn btn-primary w-100" type="submit">登録</button>
            </div>
            <div class="col-12">
                <label class="form-label" for="memberComment">コメント</label>
                <textarea id="memberComment" name="comment" class="form-control" rows="3"></textarea>
            </div>
        </form>
        <div class="profile-grid">
            ${(appState.members || []).map((item) => memberAdminCard(portalData(item))).join('') || '<p class="text-muted">団員登録はまだありません</p>'}
        </div>
    `;
    $('memberRegistrationForm').addEventListener('submit', savePortalMember);
}

async function savePortalMember(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const name = form.elements.name.value.trim();
    if (!name) {
        showAlert('名前を入力してください', 'warning');
        return;
    }
    await request('/api/portal-members', { method: 'POST', body: new FormData(form) });
    await loadPortalData();
    renderAdminMemberRegistration();
    renderMemberProfile();
    showAlert('団員を登録しました', 'success');
}

function memberAdminCard(member) {
    return `
        <article class="profile-card">
            ${member.photo_url
                ? `<img class="profile-photo" src="${escapeHtml(member.photo_url)}" alt="${escapeHtml(member.name || '')}">`
                : `<div class="profile-avatar">${escapeHtml((member.part || member.name || '?').slice(0, 1))}</div>`}
            <div>
                <div class="profile-part">${escapeHtml(member.part || '')}</div>
                <h6>${escapeHtml(member.name || '')}</h6>
                <p class="profile-role">${escapeHtml([member.role, member.joined_at].filter(Boolean).join(' / '))}</p>
                <p class="mb-0 multiline-text">${escapeHtml(member.comment || '')}</p>
            </div>
        </article>
    `;
}

async function loadPortalData() {
    const results = await Promise.all(PORTAL_COLLECTIONS.map((name) =>
        request(`/api/portal/${name}`).catch(() => ({ items: [] }))
    ));
    appState.absences = results[0].items || [];
    appState.sheetLibrary = results[1].items || [];
    appState.payments = results[2].items || [];
    appState.rosters = results[3].items || [];
    appState.events = results[4].items || [];
    appState.eventResponses = results[5].items || [];
    appState.songInfo = results[6].items || [];
    appState.albums = results[7].items || [];
    appState.members = results[8].items || [];
    appState.portalLoaded = true;
}

async function savePortalItem(collection, data) {
    const saved = await request(`/api/portal/${collection}`, jsonOptions('POST', { data }));
    await loadPortalData();
    return saved;
}

function portalData(item) {
    return item?.data || {};
}

function renderPortalTab(tab) {
    const renderers = {
        'member-absence': renderAbsences,
        'member-sheets': renderSheets,
        'member-payments': renderPayments,
        'member-roster': renderRosters,
        'member-events': renderEvents,
        'member-song-info': renderSongInfo,
        'member-album': renderAlbum
    };
    renderers[tab]?.();
}

function upcomingPerformance() {
    const todayValue = today();
    return [...appState.performances]
        .filter((perf) => String(perf.date || '') >= todayValue)
        .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')))[0] || null;
}

function scheduleOptions() {
    return appState.schedules
        .slice()
        .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')))
        .map((sched) => `<option value="${escapeHtml(sched.date)}">${escapeHtml(formatDateWithWeekday(sched.date))} ${escapeHtml(sched.venue || '')}</option>`)
        .join('');
}

function performanceOptions() {
    return appState.performances
        .map((perf) => `<option value="${escapeHtml(perf.title)}">${escapeHtml(perf.title)} (${escapeHtml(formatDateWithWeekday(perf.date || ''))})</option>`)
        .join('');
}

function renderAbsences() {
    const grouped = groupBy(appState.absences.map(portalData), 'practice_date');
    $('memberAbsenceInfo').innerHTML = `
        <div class="row g-2 mb-3">
            <div class="col-md-4"><input id="absenceName" class="form-control" placeholder="名前"></div>
            <div class="col-md-4"><select id="absenceDate" class="form-select">${scheduleOptions()}</select></div>
            <div class="col-md-4"><button id="absenceSubmit" class="btn btn-primary w-100" type="button">欠席を登録</button></div>
        </div>
        ${Object.entries(grouped).map(([date, people]) => `
            <div class="info-block">
                <h6>${escapeHtml(formatDateWithWeekday(date))}</h6>
                <p class="mb-0">${people.map((item) => escapeHtml(item.name)).join('、') || '欠席者なし'}</p>
            </div>
        `).join('') || '<p class="text-muted mb-0">欠席連絡はまだありません</p>'}
    `;
    $('absenceSubmit').addEventListener('click', async () => {
        const name = $('absenceName').value.trim();
        const practiceDate = $('absenceDate').value;
        if (!name || !practiceDate) return showAlert('名前と練習日を入力してください', 'warning');
        await savePortalItem('absences', { name, practice_date: practiceDate });
        renderAbsences();
        showAlert('欠席連絡を登録しました', 'success');
    });
}

function renderSheets() {
    $('memberSheetsInfo').innerHTML = `
        <form id="sheetUploadForm" class="row g-2 mb-3">
            <div class="col-md-3"><select name="performance" class="form-select">${performanceOptions()}</select></div>
            <div class="col-md-3"><input name="piece" class="form-control" placeholder="曲名"></div>
            <div class="col-md-4"><input name="file" type="file" accept="application/pdf,.pdf" class="form-control"></div>
            <div class="col-md-2"><button class="btn btn-primary w-100" type="submit">PDF登録</button></div>
        </form>
        <div class="portal-grid">${appState.sheetLibrary.map((item) => fileCard(portalData(item), true)).join('') || '<p class="text-muted">楽譜はまだありません</p>'}</div>
    `;
    $('sheetUploadForm').addEventListener('submit', async (event) => {
        event.preventDefault();
        await uploadPortalFile('sheets', event.currentTarget);
        renderSheets();
    });
}

function renderPayments() {
    const members = [...new Set(appState.payments.map((item) => portalData(item).member).filter(Boolean))];
    $('memberPaymentsInfo').innerHTML = `
        <div class="row g-2 mb-3">
            <div class="col-md-4"><input id="paymentMember" class="form-control" list="paymentMembers" placeholder="団員名"></div>
            <datalist id="paymentMembers">${members.map((name) => `<option value="${escapeHtml(name)}"></option>`).join('')}</datalist>
            <div class="col-md-2"><select id="membershipFee" class="form-select"><option value="未払い">団費 未払い</option><option value="支払済">団費 支払済</option></select></div>
            <div class="col-md-2"><select id="concertFee" class="form-select"><option value="未払い">演奏会費 未払い</option><option value="支払済">演奏会費 支払済</option></select></div>
            <div class="col-md-2"><button id="paymentSave" class="btn btn-primary w-100" type="button">登録</button></div>
        </div>
        <div id="paymentResult">${paymentRows(appState.payments.map(portalData))}</div>
    `;
    $('paymentSave').addEventListener('click', async () => {
        const member = $('paymentMember').value.trim();
        if (!member) return showAlert('団員名を入力してください', 'warning');
        await savePortalItem('payments', { member, membership_fee: $('membershipFee').value, concert_fee: $('concertFee').value });
        renderPayments();
    });
}

function paymentRows(rows) {
    if (!rows.length) return '<p class="text-muted">支払状況はまだありません</p>';
    return `<table class="table table-sm"><thead><tr><th>団員</th><th>団費</th><th>演奏会費</th></tr></thead><tbody>${rows.map((row) => `<tr><td>${escapeHtml(row.member)}</td><td>${escapeHtml(row.membership_fee)}</td><td>${escapeHtml(row.concert_fee)}</td></tr>`).join('')}</tbody></table>`;
}

function renderRosters() {
    $('memberRosterInfo').innerHTML = `
        <div class="row g-2 mb-3">
            <div class="col-md-3"><select id="rosterPerformance" class="form-select">${performanceOptions()}</select></div>
            <div class="col-md-3"><input id="rosterPart" class="form-control" placeholder="パート"></div>
            <div class="col-md-4"><input id="rosterMembers" class="form-control" placeholder="乗り番（カンマ区切り）"></div>
            <div class="col-md-2"><button id="rosterSave" class="btn btn-primary w-100" type="button">登録</button></div>
        </div>
        ${groupedPortalBlocks(appState.rosters.map(portalData), 'performance', (row) => `${escapeHtml(row.part || '')}: ${escapeHtml(row.members || '')}`)}
    `;
    $('rosterSave').addEventListener('click', async () => {
        await savePortalItem('rosters', { performance: $('rosterPerformance').value, part: $('rosterPart').value, members: $('rosterMembers').value });
        renderRosters();
    });
}

function renderEvents() {
    const selectedEvent = appState.events.find((item) => Number(item.id) === Number(appState.selectedEventId));
    $('memberEventsInfo').innerHTML = `
        <div class="row g-2 mb-3">
            <div class="col-md-5"><input id="eventTitle" class="form-control" placeholder="イベント名"></div>
            <div class="col-md-3"><input id="eventDate" type="date" class="form-control" value="${today()}"></div>
            <div class="col-md-2"><button id="eventCreate" class="btn btn-outline-primary w-100" type="button">イベント登録</button></div>
        </div>
        <div class="list-group mb-3">
            ${appState.events.map((eventItem) => eventSelectItem(eventItem)).join('') || '<p class="text-muted">イベントはまだありません</p>'}
        </div>
        <div id="eventResponsePanel">
            ${selectedEvent ? eventResponsePanel(selectedEvent) : '<p class="text-muted mb-0">イベントを選択すると出欠登録画面が表示されます</p>'}
        </div>
    `;
    $('eventCreate').addEventListener('click', async () => {
        const title = $('eventTitle').value.trim();
        if (!title) return showAlert('イベント名を入力してください', 'warning');
        const saved = await savePortalItem('events', { title, date: $('eventDate').value });
        appState.selectedEventId = saved.id;
        renderEvents();
    });
    document.querySelectorAll('[data-select-event-id]').forEach((button) => {
        button.addEventListener('click', () => {
            appState.selectedEventId = Number(button.dataset.selectEventId);
            renderEvents();
        });
    });
    document.querySelectorAll('[data-event-response-submit]').forEach((button) => {
        button.addEventListener('click', async () => {
            const name = $('eventName').value.trim();
            if (!name) return showAlert('名前を入力してください', 'warning');
            await savePortalItem('event_responses', { event_id: Number(button.dataset.eventId), name, status: $('eventStatus').value });
            renderEvents();
        });
    });
}

function eventSelectItem(eventItem) {
    const event = portalData(eventItem);
    const active = Number(eventItem.id) === Number(appState.selectedEventId);
    return `
        <button class="list-group-item list-group-item-action ${active ? 'active' : ''}" type="button" data-select-event-id="${eventItem.id}">
            <strong>${escapeHtml(event.title || '')}</strong>
            <span class="small ${active ? '' : 'text-muted'} ms-2">${escapeHtml(formatDateWithWeekday(event.date || ''))}</span>
        </button>
    `;
}

function eventResponsePanel(eventItem) {
    const event = portalData(eventItem);
    const responses = appState.eventResponses.map(portalData).filter((row) => Number(row.event_id) === Number(eventItem.id));
    return `
        <div class="info-block">
            <h6>${escapeHtml(event.title)} <span class="text-muted small">${escapeHtml(formatDateWithWeekday(event.date || ''))}</span></h6>
            <div class="row g-2 mb-2">
                <div class="col-md-5"><input id="eventName" class="form-control" placeholder="名前"></div>
                <div class="col-md-3">
                    <select id="eventStatus" class="form-select">
                        <option value="参加">参加</option>
                        <option value="不参加">不参加</option>
                    </select>
                </div>
                <div class="col-md-2"><button class="btn btn-primary w-100" data-event-id="${eventItem.id}" data-event-response-submit type="button">登録</button></div>
            </div>
            <p class="mb-0">${responses.map((row) => `${escapeHtml(row.name)}: ${escapeHtml(row.status)}`).join(' / ') || '回答なし'}</p>
        </div>
    `;
}

function renderSongInfo() {
    $('memberSongInfoInfo').innerHTML = `
        <div class="row g-2 mb-3">
            <div class="col-md-3"><select id="songPerformance" class="form-select">${performanceOptions()}</select></div>
            <div class="col-md-3"><input id="songTitle" class="form-control" placeholder="曲名"></div>
            <div class="col-md-4"><input id="songMemo" class="form-control" placeholder="作曲者、参考情報、注意点など"></div>
            <div class="col-md-2"><button id="songSave" class="btn btn-primary w-100" type="button">登録</button></div>
        </div>
        ${groupedPortalBlocks(appState.songInfo.map(portalData), 'performance', (row) => `<strong>${escapeHtml(row.title || '')}</strong><br>${escapeHtml(row.memo || '')}`)}
    `;
    $('songSave').addEventListener('click', async () => {
        await savePortalItem('song_info', { performance: $('songPerformance').value, title: $('songTitle').value, memo: $('songMemo').value });
        renderSongInfo();
    });
}

function renderAlbum() {
    $('memberAlbumInfo').innerHTML = `
        <form id="albumUploadForm" class="row g-2 mb-3">
            <div class="col-md-3"><input name="title" class="form-control" placeholder="写真タイトル"></div>
            <div class="col-md-5"><input name="file" type="file" accept="image/*" class="form-control"></div>
            <div class="col-md-2"><button class="btn btn-primary w-100" type="submit">写真登録</button></div>
        </form>
        <div class="album-grid">${appState.albums.map((item) => imageCard(portalData(item))).join('') || '<p class="text-muted">写真はまだありません</p>'}</div>
    `;
    $('albumUploadForm').addEventListener('submit', async (event) => {
        event.preventDefault();
        await uploadPortalFile('albums', event.currentTarget);
        renderAlbum();
    });
}

async function uploadPortalFile(kind, form) {
    const formData = new FormData(form);
    const response = await request(`/api/portal-files/${kind}`, { method: 'POST', body: formData });
    await loadPortalData();
    showAlert('登録しました', 'success');
    return response;
}

function fileCard(file, isPdf = false) {
    return `
        <div class="portal-file-card">
            <strong>${escapeHtml(file.title || file.name || '')}</strong>
            <p class="text-muted mb-2">${escapeHtml([file.performance, file.piece].filter(Boolean).join(' / '))}</p>
            <div class="d-flex gap-2 flex-wrap">
                <a class="btn btn-sm btn-outline-primary" href="${escapeHtml(file.url || '#')}" target="_blank" rel="noopener">閲覧</a>
                <a class="btn btn-sm btn-primary" href="${escapeHtml(file.download_url || file.url || '#')}">DL</a>
            </div>
        </div>
    `;
}

function imageCard(file) {
    return `
        <figure class="album-card">
            <img src="${escapeHtml(file.url || '')}" alt="${escapeHtml(file.title || file.name || '写真')}" loading="lazy">
            <figcaption><strong>${escapeHtml(file.title || file.name || '')}</strong></figcaption>
        </figure>
    `;
}

function groupedPortalBlocks(rows, key, renderRow) {
    if (!rows.length) return '<p class="text-muted">登録はまだありません</p>';
    const grouped = groupBy(rows, key);
    return Object.entries(grouped).map(([group, items]) => `
        <div class="info-block">
            <h6>${escapeHtml(group)}</h6>
            ${items.map((row) => `<p class="mb-1">${renderRow(row)}</p>`).join('')}
        </div>
    `).join('');
}

