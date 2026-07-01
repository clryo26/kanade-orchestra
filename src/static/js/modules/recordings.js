// This file was split from main.js during frontend refactor.
// It depends on shared globals declared in main.js (appState, $, request, helpers).

var appState = window.portalRuntimeContext.appState;
var $ = window.portalRuntimeContext.getById;

function canManageRecordings() {
    return canAccessAdmin() || appState.currentUserIsRecordingManager;
}

// 楽譜管理権限の判定（管理者または楽譜担当）。
// canManageSheets moved to feature module.


async function loadRecordings() {
    const data = await request('/api/recordings');
    appState.recordings = data.files || [];
    appState.recordingsLoaded = true;
    renderRecordings();
}

// loadSheets moved to feature module.


async function ensureRecordingsLoaded() {
    if (appState.recordingsLoaded) {
        renderRecordings();
        return;
    }
    ['songTreeMember', 'songTreeAdmin'].forEach((id) => {
        const container = $(id);
        if (container && !container.innerHTML.trim()) container.innerHTML = '<p class="text-muted mb-0">録音一覧を読み込み中です...</p>';
    });
    await loadRecordings();
    appState.recordingsLoaded = true;
    renderRecordings();
}

// ensureSheetsLoaded moved to feature module.

