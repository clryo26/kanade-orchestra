// Album module.

var appState = window.portalRuntimeContext.appState;
var $ = window.portalRuntimeContext.getById;

function renderAlbumView() {
    const c = $('memberAlbumInfo');
    if (!c) return;

    // アルバム一覧を作成日の新しい順にソート
    const albums = [...(appState.albums || [])].sort((a, b) =>
        String(b.created_at || '').localeCompare(String(a.created_at || ''))
    );

    const isAdmin = isAdmin_Portal();
    const currentUserId = appState.currentUserMemberId;
    const currentUserName = currentUserMemberName();

    // アルバムイベント一覧HTML を構築
    let albumsHTML = '';
    if (albums.length) {
        albumsHTML = albums.map((album) => {
            const photos = album.photos || [];
            const canDeleteEvent = isAdmin || String(album.created_by_member_id || '') === String(currentUserId);
            
            // 写真ギャラリーHTML を構築
            let photosHTML = '';
            if (photos.length) {
                photosHTML = `<div class="row g-3">${photos.map((photo) => {
                    const photoUrl = (photo.id && album.id)
                        ? `/api/albums/${encodeURIComponent(String(album.id || ''))}/photos/${encodeURIComponent(String(photo.id || ''))}`
                        : String(photo.url || '#');
                    const deleteBtn = isAdmin ? `<button class="btn btn-sm btn-outline-danger album-delete-photo-btn mt-1" type="button" data-album-id="${escapeHtml(String(album.id || ''))}" data-photo-id="${escapeHtml(String(photo.id || ''))}">削除</button>` : '';
                    return `<div class="col-6 col-md-4 col-lg-3 position-relative">
                        <button class="album-photo-open-btn" type="button" data-album-photo-url="${escapeHtml(photoUrl)}" data-album-photo-title="${escapeHtml(photo.filename || '写真')}">
                            <img src="${escapeHtml(photoUrl)}" class="album-photo" alt="${escapeHtml(photo.filename || '写真')}" loading="lazy">
                        </button>
                        <div class="small mt-1 text-muted">${escapeHtml(photo.filename || '写真')}</div>
                        <div class="small text-muted">
                            <div>${escapeHtml(photo.uploaded_by_member_name || '不明')}</div>
                            <div>${escapeHtml(formatDateTimeLabel(photo.uploaded_at || ''))}</div>
                        </div>
                        ${deleteBtn}
                    </div>`;
                }).join('')}</div>`;
            } else {
                photosHTML = '<p class="text-muted">写真はまだアップロードされていません</p>';
            }

            const deleteEventBtn = canDeleteEvent ? `<button class="btn btn-sm btn-outline-danger album-delete-event-btn" type="button" data-album-id="${escapeHtml(String(album.id || ''))}">イベント削除</button>` : '';
            
            return `<section class="mb-4">
                <div class="d-flex justify-content-between align-items-center mb-3">
                    <h6 class="mb-0">${escapeHtml(album.event_name || 'イベント')}</h6>
                    ${deleteEventBtn}
                </div>
                <div class="small text-muted mb-3">
                    <div>作成者: ${escapeHtml(album.created_by_member_name || '不明')}</div>
                    <div>作成日: ${escapeHtml(formatDateTimeLabel(album.created_at || ''))}</div>
                </div>

                <!-- 写真アップロード -->
                <div class="mb-3 p-2 border rounded bg-light">
                    <label class="form-label small mb-2">写真をアップロード</label>
                    <div class="d-flex gap-2">
                        <input type="file" class="form-control album-photo-file" data-album-id="${escapeHtml(String(album.id || ''))}" accept="image/*" multiple>
                        <button class="btn btn-outline-primary album-upload-photo-btn" type="button" data-album-id="${escapeHtml(String(album.id || ''))}">アップロード</button>
                    </div>
                </div>

                <!-- 写真ギャラリー -->
                <div class="mb-3">
                    ${photosHTML}
                </div>
            </section>`;
        }).join('');
    } else {
        albumsHTML = '<p class="text-muted">アルバムイベントが登録されていません</p>';
    }

    c.innerHTML = `
        <!-- アルバムイベント作成フォーム -->
        <div class="info-block mb-4">
            <h6>アルバムイベントを作成</h6>
            <div class="row g-2 align-items-end">
                <div class="col-md-8">
                    <label class="form-label" for="albumEventName">イベント名</label>
                    <input type="text" id="albumEventName" class="form-control" placeholder="例: 2026年夏合宿">
                </div>
                <div class="col-md-4">
                    <button class="btn btn-primary w-100" id="albumCreateEventBtn" type="button">イベントを作成</button>
                </div>
            </div>
        </div>

        <!-- アルバムイベント一覧 -->
        <div id="memberAlbumEventList">
            ${albumsHTML}
        </div>
    `;

    // イベント作成ボタン
    const createBtn = $('albumCreateEventBtn');
    if (createBtn) {
        createBtn.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '作成中...', () => createAlbumEvent()));
    }

    // イベント削除ボタン
    c.querySelectorAll('.album-delete-event-btn').forEach((button) => {
        button.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', () => deleteAlbumEvent(button.dataset.albumId || '')));
    });

    // 写真アップロードボタン
    c.querySelectorAll('.album-upload-photo-btn').forEach((button) => {
        button.addEventListener('click', (event) => withButtonStatus(event.currentTarget, 'アップロード中...', () => uploadAlbumPhotos(button.dataset.albumId || '')));
    });

    // 写真削除ボタン
    c.querySelectorAll('.album-delete-photo-btn').forEach((button) => {
        button.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', () => deleteAlbumPhoto(button.dataset.albumId || '', button.dataset.photoId || '')));
    });

    c.querySelectorAll('.album-photo-open-btn').forEach((button) => {
        button.addEventListener('click', () => openAlbumPhotoViewer(
            button.dataset.albumPhotoUrl || '',
            button.dataset.albumPhotoTitle || '写真'
        ));
    });
}

function openAlbumPhotoViewer(photoUrl, title = '写真') {
    if (!photoUrl) return;
    let viewer = $('albumPhotoViewer');
    if (!viewer) {
        viewer = document.createElement('div');
        viewer.id = 'albumPhotoViewer';
        viewer.className = 'album-photo-viewer';
        viewer.innerHTML = `
            <div class="album-photo-viewer-toolbar">
                <button class="btn btn-outline-light btn-sm" id="albumPhotoViewerCloseBtn" type="button">アルバムに戻る</button>
                <span class="album-photo-viewer-title" id="albumPhotoViewerTitle"></span>
            </div>
            <div class="album-photo-viewer-body">
                <img id="albumPhotoViewerImage" alt="">
            </div>
        `;
        document.body.appendChild(viewer);
        $('albumPhotoViewerCloseBtn')?.addEventListener('click', closeAlbumPhotoViewer);
        viewer.addEventListener('click', (event) => {
            if (event.target === viewer) closeAlbumPhotoViewer();
        });
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && !viewer.hidden) closeAlbumPhotoViewer();
        });
    }
    const image = $('albumPhotoViewerImage');
    const titleElement = $('albumPhotoViewerTitle');
    if (image) {
        image.src = photoUrl;
        image.alt = title;
    }
    if (titleElement) titleElement.textContent = title;
    viewer.hidden = false;
    document.body.classList.add('album-photo-viewer-open');
}

function closeAlbumPhotoViewer() {
    const viewer = $('albumPhotoViewer');
    if (!viewer) return;
    viewer.hidden = true;
    document.body.classList.remove('album-photo-viewer-open');
}

async function createAlbumEvent() {
    const eventName = $('albumEventName')?.value.trim() || '';
    if (!eventName) {
        showAlert('イベント名を入力してください', 'warning');
        return;
    }

    const payload = {
        event_name: eventName,
        created_by_member_id: appState.currentUserMemberId || '',
        created_by_member_name: currentUserMemberName(),
        photos: []
    };

    await saveExtra('albums', payload);
    $('albumEventName').value = '';
    await loadExtraData();
    showAlert('アルバムイベントを作成しました', 'success');
}

async function deleteAlbumEvent(albumId) {
    if (!albumId) return;
    if (!confirmDelete()) return;

    await request(`/api/extra/albums/${encodeURIComponent(albumId)}`, { method: 'DELETE' });
    await loadExtraData();
    showAlert('アルバムイベントを削除しました', 'success');
}

async function uploadAlbumPhotos(albumId) {
    if (!albumId) return;

    const fileInput = document.querySelector(`.album-photo-file[data-album-id="${CSS.escape(albumId)}"]`);
    if (!fileInput || !fileInput.files.length) {
        showAlert('アップロードするファイルを選択してください', 'warning');
        return;
    }

    const files = Array.from(fileInput.files);
    const albumIdNum = Number(albumId) || 0;

    let uploadedCount = 0;
    for (const file of files) {
        try {
            const formData = new FormData();
            formData.append('file', file);

            await request(`/api/extra/albums/${encodeURIComponent(albumIdNum)}/photos`, {
                method: 'POST',
                body: formData
            });
            uploadedCount += 1;
        } catch (error) {
            console.error(`Upload failed for ${file.name}:`, error);
        }
    }

    fileInput.value = '';
    await loadExtraData();
    showAlert(`${uploadedCount}件の写真をアップロードしました`, 'success');
}

async function deleteAlbumPhoto(albumId, photoId) {
    if (!albumId || !photoId) return;
    if (!confirmDelete()) return;

    const albumIdNum = Number(albumId) || 0;
    const photoIdNum = Number(photoId) || 0;

    await request(`/api/extra/albums/${encodeURIComponent(albumIdNum)}/photos/${encodeURIComponent(photoIdNum)}`, {
        method: 'DELETE'
    });
    await loadExtraData();
    showAlert('写真を削除しました', 'success');
}
