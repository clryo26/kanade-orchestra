// Sheet render functions split from modules/scores.js.
// Keep global names for compatibility with legacy non-module loading.
//
// Sections carry data-sheet-key so an automatic update keeps them open or
// closed (scores/sync.js). DL buttons open the common save dialog instead of
// navigating (an iPhone home-screen app could not come back from a file).

var appState = window.portalRuntimeContext.appState;
var $ = window.portalRuntimeContext.getById;

function renderSheetLibraryView() {
    const c = $('memberSheetInfo');
    if (!c) return;
    if (!appState.sheetLibrary.length) {
        c.innerHTML = '<p class="text-muted mb-0">登録された楽譜はありません</p>';
        return;
    }
    const filters = appState.sheetFilters || { performanceId: '', piece: '', part: '' };
    const visibleSheets = appState.sheetLibrary.filter((sheet) => (!filters.performanceId || String(sheet.performance_id || '') === String(filters.performanceId)) && (!filters.piece || String(sheet.piece || '') === filters.piece) && (!filters.part || String(sheet.part || '') === filters.part));
    const filterHtml = `
        <div class="row g-2 align-items-end mb-3">
            <div class="col-md-4"><label class="form-label" for="memberSheetPerformanceFilter">演奏会</label><select class="form-select" id="memberSheetPerformanceFilter">${sheetFilterPerformanceOptions(filters.performanceId)}</select></div>
            <div class="col-md-4"><label class="form-label" for="memberSheetPieceFilter">曲名</label><select class="form-select" id="memberSheetPieceFilter">${sheetFilterPieceOptions(filters.piece, filters.performanceId)}</select></div>
            <div class="col-md-3"><label class="form-label" for="memberSheetPartFilter">パート</label><select class="form-select" id="memberSheetPartFilter">${sheetFilterPartOptions(filters.part, filters.performanceId, filters.piece)}</select></div>
            <div class="col-md-1"><button class="btn btn-outline-secondary w-100" id="memberSheetFilterClearBtn" type="button">解除</button></div>
        </div>
    `;
    if (!visibleSheets.length) {
        c.innerHTML = filterHtml + '<p class="text-muted mb-0">条件に一致する楽譜はありません</p>';
        bindSheetLibraryFilters();
        return;
    }
    const performanceGroups = groupBy(visibleSheets, 'performance_id');
    c.innerHTML = filterHtml + sortedSheetPerformanceIds(Object.keys(performanceGroups)).map((performanceId, index) => {
        const sheets = performanceGroups[performanceId];
        const performance = appState.performances.find((perf) => String(perf.id) === String(performanceId));
        const performanceTitle = performance?.title || sheets[0]?.performance_title || '未設定の演奏会';
        const pieceGroups = groupBy(sheets, 'piece');
        const perfKey = escapeHtml('p:' + performanceId);
        return `<details class="mb-3 sheet-library-details sheet-performance-details" data-sheet-key="${perfKey}"${index === 0 ? ' open' : ''}><summary class="d-flex flex-wrap justify-content-between align-items-center gap-2"><strong class="sheet-library-heading">${escapeHtml(performanceTitle)}</strong><button class="btn btn-sm btn-primary" type="button" data-sheet-zip="${escapeHtml(performanceId)}" data-sheet-zip-scope="performance" data-sheet-zip-piece="">演奏会一括DL</button></summary><div class="mt-2">${Object.entries(pieceGroups).map(([piece, pieceSheets]) => `<details class="mb-2 ms-md-3 sheet-library-details sheet-piece-details" data-sheet-key="${escapeHtml('p:' + performanceId + ':' + piece)}"><summary class="d-flex flex-wrap justify-content-between align-items-center gap-2"><span class="sheet-library-heading">${escapeHtml(piece || '未設定の曲名')}</span><button class="btn btn-sm btn-outline-primary" type="button" data-sheet-zip="${escapeHtml(performanceId)}" data-sheet-zip-scope="piece" data-sheet-zip-piece="${escapeHtml(piece)}">曲一括DL</button></summary><div class="list-group mt-2">${sortedSheetsByPart(pieceSheets).map((sheet) => `<div class="list-group-item d-flex flex-wrap justify-content-between align-items-center gap-2"><span>${escapeHtml(displayNameWithoutExtension(sheet.name || '楽譜'))}<span class="badge text-bg-secondary ms-2">${escapeHtml(sheet.part || 'パート未設定')}</span></span><span class="d-flex gap-2"><button class="btn btn-sm btn-outline-primary" type="button" data-sheet-view="${escapeHtml(String(sheet.id || ''))}">表示</button><button class="btn btn-sm btn-primary" type="button" data-sheet-save="${escapeHtml(String(sheet.id || ''))}">DL</button></span></div>`).join('')}</div></details>`).join('')}</div></details>`;
    }).join('');
    bindSheetLibraryFilters();
    c.querySelectorAll('[data-sheet-view]').forEach((button) => button.addEventListener('click', () => showSheetViewer(button.dataset.sheetView || '')));
    c.querySelectorAll('[data-sheet-save]').forEach((button) => button.addEventListener('click', () => openSheetFileSave(button.dataset.sheetSave || '', button)));
    c.querySelectorAll('[data-sheet-zip]').forEach((button) => button.addEventListener('click', (event) => {
        // Inside <summary>: do not toggle the section.
        event.preventDefault();
        event.stopPropagation();
        openSheetZipSave(button.dataset.sheetZip || '', button.dataset.sheetZipPiece || '', filters.part, button, button.dataset.sheetZipScope || 'performance');
    }));
}

function renderSheetAdmin() {
    const performanceSelect = $('sheetPerformanceSelect');
    const list = $('sheetAdminList');
    if (!performanceSelect || !list) return;
    const selectedPerformance = performanceSelect.value;
    performanceSelect.innerHTML = ['<option value="">選択してください</option>'].concat(sortedSheetPerformanceIds(appState.performances.map((perf) => String(perf.id))).map((id) => appState.performances.find((perf) => String(perf.id) === id)).map((perf) => `<option value="${escapeHtml(String(perf.id))}" ${String(perf.id) === selectedPerformance ? 'selected' : ''}>${escapeHtml(perf.title || '')}</option>`)).join('');
    if (selectedPerformance && !performanceSelect.value) performanceSelect.value = selectedPerformance;
    updateSheetPieceOptions();
    renderSheetAdminList();
}

function updateSheetPieceOptions() {
    const performanceSelect = $('sheetPerformanceSelect');
    const pieceSelect = $('sheetPieceSelect');
    if (!performanceSelect || !pieceSelect) return;
    const selectedPiece = pieceSelect.value;
    const performance = appState.performances.find((perf) => String(perf.id) === String(performanceSelect.value));
    const pieces = sheetPieceOptions(performance);
    pieceSelect.innerHTML = pieces.length ? ['<option value="">選択してください</option>'].concat(pieces.map((piece) => `<option value="${escapeHtml(piece)}" ${piece === selectedPiece ? 'selected' : ''}>${escapeHtml(piece)}</option>`)).join('') : '<option value="">曲目が登録されていません</option>';
}

function renderSheetAdminList() {
    const list = $('sheetAdminList');
    if (!list) return;
    if (!appState.sheetLibrary.length) {
        list.innerHTML = '<p class="text-muted mb-0">登録済みの楽譜はありません</p>';
        return;
    }
    const selectedCount = appState.selectedSheetIds.length;
    const selectedSheetIdSet = new Set(appState.selectedSheetIds.map(String));
    const selectionHtml = selectedCount > 0 ? `<div class="alert alert-info mb-3"><div class="d-flex flex-wrap justify-content-between align-items-center gap-2"><span><strong>${selectedCount} 件の楽譜を選択中</strong></span><div class="d-flex flex-wrap gap-2"><select class="form-select form-select-sm" id="bulkPartSelect" style="width: 12rem;">${partOptionHtml('')}</select><button class="btn btn-sm btn-success" id="bulkPartSaveBtn" type="button">一括パート設定</button><button class="btn btn-sm btn-outline-secondary" id="clearSelectionBtn" type="button">選択解除</button></div></div></div>` : '';
    const performanceGroups = groupBy(appState.sheetLibrary, 'performance_id');
    list.innerHTML = selectionHtml + sortedSheetPerformanceIds(Object.keys(performanceGroups)).map((performanceId) => {
        const sheets = performanceGroups[performanceId];
        const performance = appState.performances.find((perf) => String(perf.id) === String(performanceId));
        const performanceTitle = performance?.title || sheets[0]?.performance_title || '未設定の演奏会';
        const pieceGroups = groupBy(sheets, 'piece');
        return `<section class="mb-4"><div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-2"><h5 class="mb-0">${escapeHtml(performanceTitle)}</h5><button class="btn btn-sm btn-outline-danger sheet-delete-performance-btn" type="button" data-performance-id="${escapeHtml(performanceId)}">演奏会配下を削除</button></div>${Object.entries(pieceGroups).map(([piece, pieceSheets]) => `<div class="list-group mb-3"><div class="list-group-item d-flex flex-wrap justify-content-between align-items-center gap-2"><strong>${escapeHtml(piece || '未設定の曲名')}</strong><button class="btn btn-sm btn-outline-danger sheet-delete-piece-btn" type="button" data-performance-id="${escapeHtml(performanceId)}" data-piece="${escapeHtml(piece)}">曲名配下を削除</button></div>${sortedSheetsByPart(pieceSheets).map((sheet) => { const isSelected = selectedSheetIdSet.has(String(sheet.id || '')); return `<div class="list-group-item d-flex flex-wrap justify-content-between align-items-center gap-2"><div class="d-flex align-items-center gap-2"><input type="checkbox" class="form-check-input sheet-select-checkbox" data-sheet-id="${escapeHtml(String(sheet.id || ''))}" ${isSelected ? 'checked' : ''} aria-label="選択" style="cursor: pointer; margin: 0;"><span>${escapeHtml(displayNameWithoutExtension(sheet.name || '楽譜'))}<span class="badge text-bg-secondary ms-2">${escapeHtml(sheet.part || 'パート未設定')}</span></span></div><span class="d-flex flex-wrap gap-2 align-items-center"><select class="form-select form-select-sm sheet-part-assign-select" data-sheet-id="${escapeHtml(String(sheet.id || ''))}" style="width: 12rem;">${partOptionHtml(sheet.part || '')}</select><button class="btn btn-sm btn-outline-success sheet-part-save-btn" type="button" data-sheet-id="${escapeHtml(String(sheet.id || ''))}">パート保存</button><button class="btn btn-sm btn-outline-primary sheet-admin-view-btn" type="button" data-sheet-id="${escapeHtml(String(sheet.id || ''))}">閲覧</button><button class="btn btn-sm btn-primary sheet-admin-save-btn" type="button" data-sheet-id="${escapeHtml(String(sheet.id || ''))}">DL</button><button class="btn btn-sm btn-outline-danger sheet-delete-file-btn" type="button" data-sheet-id="${escapeHtml(String(sheet.id || ''))}">削除</button></span></div>`; }).join('')}</div>`).join('')}</section>`;
    }).join('');
    list.querySelectorAll('.sheet-select-checkbox').forEach((checkbox) => {
        checkbox.addEventListener('change', (event) => {
            const sheetId = event.currentTarget.dataset.sheetId || '';
            if (event.currentTarget.checked) {
                if (!appState.selectedSheetIds.includes(sheetId)) appState.selectedSheetIds.push(sheetId);
            } else {
                appState.selectedSheetIds = appState.selectedSheetIds.filter((id) => id !== sheetId);
            }
            renderSheetAdminList();
        });
    });
    if ($('bulkPartSaveBtn')) $('bulkPartSaveBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '保存中...', () => bulkSaveSheetParts()));
    if ($('clearSelectionBtn')) $('clearSelectionBtn').addEventListener('click', () => { appState.selectedSheetIds = []; renderSheetAdminList(); });
    list.querySelectorAll('.sheet-part-save-btn').forEach((button) => button.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '保存中...', () => saveSheetPart(button.dataset.sheetId || ''))));
    list.querySelectorAll('.sheet-admin-view-btn').forEach((button) => button.addEventListener('click', () => showSheetViewer(button.dataset.sheetId || '', { panel: 'adminPanel', tab: 'sheet-admin' })));
    list.querySelectorAll('.sheet-admin-save-btn').forEach((button) => button.addEventListener('click', () => openSheetFileSave(button.dataset.sheetId || '', button)));
    list.querySelectorAll('.sheet-delete-file-btn').forEach((button) => button.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', () => deleteSheets({ sheetId: button.dataset.sheetId || '' }))));
    list.querySelectorAll('.sheet-delete-piece-btn').forEach((button) => button.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', () => deleteSheets({ performanceId: button.dataset.performanceId || '', piece: button.dataset.piece || '' }))));
    list.querySelectorAll('.sheet-delete-performance-btn').forEach((button) => button.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', () => deleteSheets({ performanceId: button.dataset.performanceId || '' }))));
}
