// Concert record management split from admin/system modules.
// Keep global names for legacy handlers.

var appState = window.portalRuntimeContext.appState;
var $ = window.portalRuntimeContext.getById;

function concertRecordVideoById(videoId) {
    return (appState.concertRecordVideos || []).find((item) => String(item.id || '') === String(videoId || '')) || null;
}

function concertRecordSelectedPerformanceId() {
    return String($('concertRecordPerformance')?.value || '');
}

function concertRecordPerformanceOptionsHtml(selectedValue = '') {
    const current = String(selectedValue || '');
    return [
        '<option value="">演奏会を選択</option>',
        ...(appState.performances || []).map((performance) => {
            const value = String(performance.id || '');
            return `<option value="${escapeHtml(value)}" ${value === current ? 'selected' : ''}>${escapeHtml(performance.title || '')}</option>`;
        })
    ].join('');
}

function concertRecordAdminRows(performanceId) {
    return [...(appState.concertRecordVideos || [])]
        .filter((video) => String(video.performance_id || '') === String(performanceId || ''))
        .sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0) || Number(a.id || 0) - Number(b.id || 0));
}

function renderConcertRecordAdminForm() {
    const currentId = String($('concertRecordVideoId')?.value || '');
    const current = currentId ? concertRecordVideoById(currentId) : null;
    const selectedPerformanceId = current
        ? String(current.performance_id || '')
        : concertRecordSelectedPerformanceId();

    if ($('concertRecordPerformance')) {
        const currentValue = String($('concertRecordPerformance').value || '');
        $('concertRecordPerformance').innerHTML = concertRecordPerformanceOptionsHtml(selectedPerformanceId || currentValue);
        $('concertRecordPerformance').value = selectedPerformanceId || currentValue || '';
    }
    if ($('concertRecordYoutubeUrl') && current && !$('concertRecordYoutubeUrl').value) {
        $('concertRecordYoutubeUrl').value = current.youtube_url || '';
    }
    if ($('concertRecordSaveBtn')) {
        $('concertRecordSaveBtn').textContent = current ? '更新' : '登録';
    }
    if ($('concertRecordCancelBtn')) {
        $('concertRecordCancelBtn').hidden = !current;
    }
}

function renderConcertRecordAdminList() {
    const list = $('concertRecordAdminList');
    if (!list) return;

    const performanceId = concertRecordSelectedPerformanceId();
    if (!appState.performances.length) {
        list.innerHTML = '<p class="text-muted mb-0">演奏会がまだ登録されていません</p>';
        return;
    }
    if (!performanceId) {
        list.innerHTML = '<p class="text-muted mb-0">一覧を表示する演奏会を選択してください</p>';
        return;
    }

    const rows = concertRecordAdminRows(performanceId);
    if (!rows.length) {
        list.innerHTML = '<p class="text-muted mb-0">この演奏会の記録動画はまだ登録されていません</p>';
        return;
    }

    list.innerHTML = `<div class="list-group">${rows.map((video, index) => {
        const prevDisabled = index === 0;
        const nextDisabled = index === rows.length - 1;
        return `
            <div class="list-group-item" data-concert-record-video-id="${escapeHtml(String(video.id || ''))}">
                <div class="row g-3 align-items-center">
                    <div class="col-12 col-md-3">
                        ${video.thumbnail_url
                            ? `<img src="${escapeHtml(video.thumbnail_url)}" alt="${escapeHtml(video.title || 'YouTube動画')}" class="img-fluid rounded border w-100" loading="lazy">`
                            : '<div class="bg-light border rounded d-flex align-items-center justify-content-center text-muted" style="aspect-ratio: 16 / 9;">サムネイルなし</div>'
                        }
                    </div>
                    <div class="col-12 col-md-6">
                        <div class="fw-bold">${escapeHtml(video.title || 'YouTube動画')}</div>
                        <div class="small text-muted">順番: ${escapeHtml(String(video.sort_order || ''))}</div>
                    </div>
                    <div class="col-12 col-md-3">
                        <div class="d-flex flex-wrap gap-2 justify-content-md-end">
                            <button class="btn btn-sm btn-outline-secondary concert-record-move-up-btn" type="button" ${prevDisabled ? 'disabled' : ''}>↑</button>
                            <button class="btn btn-sm btn-outline-secondary concert-record-move-down-btn" type="button" ${nextDisabled ? 'disabled' : ''}>↓</button>
                            <button class="btn btn-sm btn-outline-primary concert-record-edit-btn" type="button">編集</button>
                            <button class="btn btn-sm btn-outline-danger concert-record-delete-btn" type="button">削除</button>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }).join('')}</div>`;

    list.querySelectorAll('.concert-record-edit-btn').forEach((button) => {
        button.addEventListener('click', () => startConcertRecordVideoEdit(button.closest('[data-concert-record-video-id]')?.dataset.concertRecordVideoId || ''));
    });
    list.querySelectorAll('.concert-record-delete-btn').forEach((button) => {
        button.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', () => deleteConcertRecordVideo(button.closest('[data-concert-record-video-id]')?.dataset.concertRecordVideoId || '')));
    });
    list.querySelectorAll('.concert-record-move-up-btn').forEach((button) => {
        button.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '移動中...', () => moveConcertRecordVideo(button.closest('[data-concert-record-video-id]')?.dataset.concertRecordVideoId || '', -1)));
    });
    list.querySelectorAll('.concert-record-move-down-btn').forEach((button) => {
        button.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '移動中...', () => moveConcertRecordVideo(button.closest('[data-concert-record-video-id]')?.dataset.concertRecordVideoId || '', 1)));
    });
}

function renderConcertRecordAdminView() {
    if (!$('concertRecordAdminTab')) return;
    renderConcertRecordAdminForm();
    renderConcertRecordAdminList();
    if ($('concertRecordPerformance')) {
        $('concertRecordPerformance').onchange = () => renderConcertRecordAdminList();
    }
    if ($('concertRecordSaveBtn')) $('concertRecordSaveBtn').onclick = () => void saveConcertRecordVideo();
    if ($('concertRecordCancelBtn')) $('concertRecordCancelBtn').onclick = () => {
        clearConcertRecordVideoForm();
        renderConcertRecordAdminList();
    };
}

function clearConcertRecordVideoForm() {
    if ($('concertRecordVideoId')) $('concertRecordVideoId').value = '';
    if ($('concertRecordYoutubeUrl')) $('concertRecordYoutubeUrl').value = '';
    if ($('concertRecordPerformance')) $('concertRecordPerformance').value = '';
    if ($('concertRecordSaveBtn')) $('concertRecordSaveBtn').textContent = '登録';
    if ($('concertRecordCancelBtn')) $('concertRecordCancelBtn').hidden = true;
}

function startConcertRecordVideoEdit(videoId) {
    const video = concertRecordVideoById(videoId);
    if (!video) {
        showAlert('編集対象の記録動画が見つかりません', 'warning');
        return;
    }
    if ($('concertRecordVideoId')) $('concertRecordVideoId').value = String(video.id || '');
    if ($('concertRecordPerformance')) $('concertRecordPerformance').value = String(video.performance_id || '');
    if ($('concertRecordYoutubeUrl')) $('concertRecordYoutubeUrl').value = video.youtube_url || '';
    if ($('concertRecordSaveBtn')) $('concertRecordSaveBtn').textContent = '更新';
    if ($('concertRecordCancelBtn')) $('concertRecordCancelBtn').hidden = false;
    renderConcertRecordAdminList();
}

async function saveConcertRecordVideo() {
    const performanceId = String($('concertRecordPerformance')?.value || '').trim();
    const youtubeUrl = String($('concertRecordYoutubeUrl')?.value || '').trim();
    if (!performanceId) {
        showAlert('演奏会を選択してください', 'warning');
        return;
    }
    if (!youtubeUrl) {
        showAlert('YouTube URLを入力してください', 'warning');
        return;
    }

    const currentId = String($('concertRecordVideoId')?.value || '');
    const current = currentId ? concertRecordVideoById(currentId) : null;
    const payload = {
        performance_id: Number(performanceId),
        youtube_url: youtubeUrl,
    };

    if (currentId && current) {
        payload.sort_order = Number(current.sort_order || 0);
        await request(`/api/extra/concert_record_videos/${encodeURIComponent(currentId)}`, jsonOptions('PUT', {
            payload,
            expected_updated_at: current.updated_at || '',
        }));
    } else {
        await saveExtra('concert_record_videos', payload);
    }

    await loadExtraData(['concertRecordVideos']);
    clearConcertRecordVideoForm();
    renderConcertRecordAdminView();
    showAlert(currentId ? '記録動画を更新しました' : '記録動画を登録しました', 'success');
}

async function deleteConcertRecordVideo(videoId) {
    const video = concertRecordVideoById(videoId);
    if (!video) {
        showAlert('削除対象の記録動画が見つかりません', 'warning');
        return;
    }
    if (!confirmDelete()) return;
    await request(`/api/extra/concert_record_videos/${encodeURIComponent(videoId)}`, { method: 'DELETE' });
    await loadExtraData(['concertRecordVideos']);
    if (String($('concertRecordVideoId')?.value || '') === String(videoId || '')) {
        clearConcertRecordVideoForm();
    }
    renderConcertRecordAdminView();
    showAlert('記録動画を削除しました', 'success');
}

async function moveConcertRecordVideo(videoId, delta) {
    const video = concertRecordVideoById(videoId);
    if (!video) {
        showAlert('移動対象の記録動画が見つかりません', 'warning');
        return;
    }
    const rows = concertRecordAdminRows(video.performance_id);
    const currentIndex = rows.findIndex((item) => String(item.id || '') === String(videoId || ''));
    const nextIndex = currentIndex + delta;
    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= rows.length) {
        return;
    }
    const targetOrder = nextIndex + 1;
    await request(`/api/extra/concert_record_videos/${encodeURIComponent(videoId)}`, jsonOptions('PUT', {
        payload: {
            performance_id: Number(video.performance_id || 0),
            youtube_url: video.youtube_url || '',
            sort_order: targetOrder,
        },
        expected_updated_at: video.updated_at || '',
    }));
    await loadExtraData(['concertRecordVideos']);
    renderConcertRecordAdminView();
}
