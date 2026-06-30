// 録音一覧、再生、削除の機能を app.js から分離したモジュール。

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

    const grouped = groupRecordingsByDateAndPiece(appState.recordings);
    const latestDate = grouped[0]?.date || '';
    container.innerHTML = '';
    if (!canDelete) {
        const controls = document.createElement('div');
        controls.className = 'recording-controls';
        controls.innerHTML = `
            <label class="form-check recording-continuous-check">
                <input class="form-check-input" id="continuousPlaybackCheck" type="checkbox" ${appState.continuousPlayback ? 'checked' : ''}>
                <span class="form-check-label">連続再生</span>
            </label>
        `;
        controls.querySelector('#continuousPlaybackCheck').addEventListener('change', (event) => {
            appState.continuousPlayback = event.currentTarget.checked;
        });
        container.appendChild(controls);
    }
    grouped.forEach((dateGroup) => {
        const dateOpen = canDelete || dateGroup.date === latestDate;
        const dateDetails = document.createElement('details');
        dateDetails.className = 'recording-date-group';
        dateDetails.open = dateOpen;
        dateDetails.innerHTML = `
                <summary class="recording-summary recording-date-summary">
                    <span>${escapeHtml(formatDateWithWeekday(dateGroup.date, '未分類'))}</span>
                    ${canDelete ? '<button class="btn btn-sm btn-outline-danger recording-bulk-delete-btn" type="button">練習日を一括削除</button>' : `<a class="btn btn-sm btn-primary recording-bulk-download-btn" href="${escapeHtml(recordingZipUrl(dateGroup.date, ''))}">練習日一括DL</a>`}
                </summary>
            `;
        if (canDelete) {
            dateDetails.querySelector('.recording-bulk-delete-btn').addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                withButtonStatus(event.currentTarget, '削除中...', () => deleteRecordingGroup(dateGroup.pieces.flatMap((pieceGroup) => pieceGroup.files), `${formatDateWithWeekday(dateGroup.date, '未分類')} の録音`));
            });
        } else {
            dateDetails.querySelectorAll('.recording-bulk-download-btn').forEach((link) => {
                link.addEventListener('click', (event) => event.stopPropagation());
            });
        }
        dateGroup.pieces.forEach((pieceGroup) => {
            const pieceDetails = document.createElement('details');
            pieceDetails.className = 'recording-piece-group';
            pieceDetails.open = canDelete || dateGroup.date === latestDate;
            pieceDetails.innerHTML = `
                <summary class="recording-summary recording-piece-summary">
                    <span>${escapeHtml(pieceGroup.piece || '未分類')}</span>
                    ${canDelete ? '<button class="btn btn-sm btn-outline-danger recording-bulk-delete-btn" type="button">曲を一括削除</button>' : `<a class="btn btn-sm btn-outline-primary recording-bulk-download-btn" href="${escapeHtml(recordingZipUrl(dateGroup.date, pieceGroup.piece))}">曲一括DL</a>`}
                </summary>
            `;
            if (canDelete) {
                pieceDetails.querySelector('.recording-bulk-delete-btn').addEventListener('click', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    withButtonStatus(event.currentTarget, '削除中...', () => deleteRecordingGroup(pieceGroup.files, `${formatDateWithWeekday(dateGroup.date, '未分類')} / ${pieceGroup.piece || '未分類'} の録音`));
                });
            }
            if (!canDelete) {
                pieceDetails.querySelectorAll('.recording-bulk-download-btn').forEach((link) => {
                    link.addEventListener('click', (event) => event.stopPropagation());
                });
            }
            const list = document.createElement('div');
            list.className = 'list-group mb-3';
            if (!canDelete && dateGroup.date === latestDate) {
                pieceDetails.classList.add('files-collapsed');
                list.hidden = true;
                const summary = pieceDetails.querySelector('summary');
                summary.addEventListener('click', (event) => {
                    event.preventDefault();
                    list.hidden = !list.hidden;
                    pieceDetails.open = true;
                    pieceDetails.classList.toggle('files-collapsed', list.hidden);
                });
            }
            pieceGroup.files.forEach((file) => {
                list.appendChild(recordingFileItem(file, canDelete));
            });
            pieceDetails.appendChild(list);
            dateDetails.appendChild(pieceDetails);
        });
        container.appendChild(dateDetails);
    });
}

function recordingZipUrl(date = '', piece = '') {
    const params = new URLSearchParams();
    if (date) params.set('date', date);
    if (piece) params.set('piece', piece);
    return `/api/recordings/download-zip?${params.toString()}`;
}

function groupRecordingsByDateAndPiece(recordings) {
    const dates = new Map();
    [...recordings]
        .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(a.piece || '').localeCompare(String(b.piece || '')) || String(a.name || '').localeCompare(String(b.name || '')))
        .forEach((file) => {
            const date = file.date || '未分類';
            const piece = file.piece || '未分類';
            if (!dates.has(date)) dates.set(date, new Map());
            if (!dates.get(date).has(piece)) dates.get(date).set(piece, []);
            dates.get(date).get(piece).push(file);
        });
    return Array.from(dates.entries()).map(([date, pieces]) => ({
        date,
        pieces: Array.from(pieces.entries()).map(([piece, files]) => ({ piece, files }))
    }));
}

function recordingFileItem(file, canDelete) {
    const item = document.createElement('div');
    item.className = 'list-group-item recording-list-item';
    const playUrl = file.play_url || file.download_url;
    const downloadUrl = file.download_url || playUrl;
    item.recordingPlayUrl = playUrl;
    item.recordingCanDelete = canDelete;
    const actionButton = canDelete
        ? '<button class="btn btn-sm btn-outline-danger delete-recording-btn" type="button">削除</button>'
        : `<a class="btn btn-sm btn-primary" href="${escapeHtml(downloadUrl)}">DL</a>`;
    item.innerHTML = `
        <div class="recording-row">
            <span class="recording-meta">
                <strong class="recording-file-name">${escapeHtml(displayNameWithoutExtension(file.name))}</strong>
                <span class="recording-duration">${formatDurationLabel(file)}</span>
            </span>
            <span class="recording-actions">
                <button class="btn btn-sm btn-outline-primary play-recording-btn" type="button">再生</button>
                ${actionButton}
            </span>
        </div>
        <div class="recording-player-area mt-2"></div>
    `;
    bindRecordingFileItem(item, file, playUrl, canDelete);
    if (canDelete) {
        item.querySelector('.delete-recording-btn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', () => deleteRecording(file)));
    }
    return item;
}

function bindRecordingFileItem(item, file, playUrl, canDelete) {
    const playButton = item.querySelector('.play-recording-btn');
    playButton.disabled = !playUrl;
    if (!playUrl) return;
    playButton.addEventListener('click', () => toggleRecordingPlayback(item));
}

async function toggleRecordingPlayback(item) {
    const audio = appState.currentAudio;
    if (audio && appState.currentRecordingItem === item && !audio.paused) {
        stopCurrentRecording();
        return;
    }
    await startRecordingPlayback(item);
}

async function startRecordingPlayback(item) {
    const playUrl = item?.recordingPlayUrl;
    const playButton = item?.querySelector('.play-recording-btn');
    const playerArea = item?.querySelector('.recording-player-area');
    if (!playUrl || !playButton || !playerArea) return false;

    const audio = ensureRecordingAudio();
    const previousItem = appState.currentRecordingItem;
    if (previousItem && previousItem !== item) {
        resetRecordingItemPlaybackUi(previousItem);
    }

    try {
        if (audio.parentElement !== playerArea) {
            playerArea.innerHTML = '';
            playerArea.appendChild(audio);
        }
        audio.hidden = true;
        audio.dataset.switchingTrack = '1';
        audio.src = withCacheBuster(playUrl);
        audio.load();
        appState.currentAudio = audio;
        appState.currentPlayButton = playButton;
        appState.currentRecordingItem = item;
        await audio.play();
        audio.dataset.switchingTrack = '';
        audio.hidden = false;
        playButton.textContent = '停止';
        return true;
    } catch (error) {
        audio.dataset.switchingTrack = '';
        clearCurrentRecordingAudio(audio);
        showAlert(`再生できませんでした: ${error.message}`, 'danger');
        return false;
    }
}

function ensureRecordingAudio() {
    if (appState.currentAudio) return appState.currentAudio;

    const audio = document.createElement('audio');
    audio.controls = true;
    audio.preload = 'auto';
    audio.playsInline = true;
    audio.className = 'w-100';
    audio.hidden = true;
    audio.addEventListener('pause', () => {
        if (audio.ended || audio.dataset.switchingTrack === '1') return;
        clearCurrentRecordingAudio(audio);
    });
    audio.addEventListener('ended', async () => {
        const finishedItem = appState.currentRecordingItem;
        resetRecordingItemPlaybackUi(finishedItem);
        if (finishedItem && !finishedItem.recordingCanDelete && appState.continuousPlayback) {
            const started = await playNextRecording(finishedItem);
            if (started) return;
        }
        clearCurrentRecordingAudio(audio);
    });
    audio.addEventListener('error', () => {
        showAlert('音声ファイルを読み込めませんでした。再デプロイ後の場合は更新して再試行してください。', 'danger');
        clearCurrentRecordingAudio(audio);
    });
    appState.currentAudio = audio;
    return audio;
}

function resetRecordingItemPlaybackUi(item) {
    if (!item) return;
    const button = item.querySelector('.play-recording-btn');
    const area = item.querySelector('.recording-player-area');
    if (button) button.textContent = '再生';
    if (area) area.innerHTML = '';
}

function clearCurrentRecordingAudio(audio = appState.currentAudio) {
    resetRecordingItemPlaybackUi(appState.currentRecordingItem);
    if (audio?.parentElement) {
        audio.parentElement.innerHTML = '';
    }
    appState.currentAudio = null;
    appState.currentPlayButton = null;
    appState.currentRecordingItem = null;
}

function stopCurrentRecording(exceptAudio = null) {
    const audio = appState.currentAudio;
    if (audio && audio !== exceptAudio) {
        audio.pause();
        try {
            audio.currentTime = 0;
        } catch {
            // Some streaming sources cannot seek until enough data has loaded.
        }
        resetRecordingItemPlaybackUi(appState.currentRecordingItem);
    }
    if (audio !== exceptAudio) {
        appState.currentAudio = null;
        appState.currentPlayButton = null;
        appState.currentRecordingItem = null;
    }
}

async function playNextRecording(currentItem) {
    const items = Array.from(document.querySelectorAll('#songTreeMember .recording-list-item'));
    const currentIndex = items.indexOf(currentItem);
    for (let index = currentIndex + 1; index < items.length; index += 1) {
        const nextItem = items[index];
        const nextButton = nextItem?.querySelector('.play-recording-btn:not(:disabled)');
        if (nextButton) {
            return startRecordingPlayback(nextItem);
        }
    }
    return false;
}

function withCacheBuster(url) {
    if (!url) return url;
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}t=${Date.now()}`;
}

async function deleteRecording(file) {
    if (!confirmDelete()) return;

    await deleteRecordingFile(file);
    await loadRecordings();
    showAlert('録音ファイルを削除しました', 'success');
}

async function deleteRecordingGroup(files, label) {
    const targets = (files || []).filter(Boolean);
    if (!targets.length) return;
    if (!confirmDelete()) return;

    for (const file of targets) {
        await deleteRecordingFile(file);
    }
    await loadRecordings();
    showAlert(`${targets.length}件の録音ファイルを削除しました`, 'success');
}

async function deleteRecordingFile(file) {
    await request('/api/recordings', jsonOptions('DELETE', {
        source: file.source || 'local',
        object_name: file.object_name || file.id || '',
        path: file.path || ''
    }));
}