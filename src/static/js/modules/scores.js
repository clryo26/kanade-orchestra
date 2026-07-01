// This file was split from main.js during frontend refactor.
// scores.js now stays as a thin compatibility loader.

var appState = window.portalRuntimeContext.appState;
var $ = window.portalRuntimeContext.getById;

// ポータル入場後の初期表示シーケンス。
// 先に画面骨格を見せ、データは段階的に読み込む。


async function loadSheets() {
    const data = await request('/api/sheets');
    appState.sheetLibrary = data.files || [];
    renderSheetAdmin();
    renderSheetLibraryView();
}


async function ensureSheetsLoaded() {
    if (appState.sheetsLoaded) {
        renderSheetAdmin();
        renderSheetLibraryView();
        return;
    }
    const container = $('memberSheetInfo');
    if (container && !container.innerHTML.trim()) container.innerHTML = '<p class="text-muted mb-0">楽譜一覧を読み込み中です...</p>';
    await loadSheets();
    appState.sheetsLoaded = true;
}


function renderSheetLibraryView() {
    const c = $('memberSheetInfo');
    if (!c) return;
    if (!appState.sheetLibrary.length) {
        c.innerHTML = '<p class="text-muted mb-0">登録された楽譜はありません</p>';
        return;
    }

    const filters = appState.sheetFilters || { performanceId: '', piece: '', part: '' };
    const visibleSheets = appState.sheetLibrary.filter((sheet) => {
        return (!filters.performanceId || String(sheet.performance_id || '') === String(filters.performanceId))
            && (!filters.piece || String(sheet.piece || '') === filters.piece)
            && (!filters.part || String(sheet.part || '') === filters.part);
    });
    const performanceOptions = sheetFilterPerformanceOptions(filters.performanceId);
    const pieceOptions = sheetFilterPieceOptions(filters.piece, filters.performanceId);
    const partOptions = sheetFilterPartOptions(filters.part, filters.performanceId, filters.piece);
    const filterHtml = `
        <div class="row g-2 align-items-end mb-3">
            <div class="col-md-4">
                <label class="form-label" for="memberSheetPerformanceFilter">演奏会</label>
                <select class="form-select" id="memberSheetPerformanceFilter">${performanceOptions}</select>
            </div>
            <div class="col-md-4">
                <label class="form-label" for="memberSheetPieceFilter">曲名</label>
                <select class="form-select" id="memberSheetPieceFilter">${pieceOptions}</select>
            </div>
            <div class="col-md-3">
                <label class="form-label" for="memberSheetPartFilter">パート</label>
                <select class="form-select" id="memberSheetPartFilter">${partOptions}</select>
            </div>
            <div class="col-md-1">
                <button class="btn btn-outline-secondary w-100" id="memberSheetFilterClearBtn" type="button">解除</button>
            </div>
        </div>
    `;
    if (!visibleSheets.length) {
        c.innerHTML = filterHtml + '<p class="text-muted mb-0">条件に一致する楽譜はありません</p>';
        bindSheetLibraryFilters();
        return;
    }

    const performanceGroups = groupBy(visibleSheets, 'performance_id');
    c.innerHTML = filterHtml + Object.entries(performanceGroups).map(([performanceId, sheets]) => {
        const performance = appState.performances.find((perf) => String(perf.id) === String(performanceId));
        const performanceTitle = performance?.title || sheets[0]?.performance_title || '未設定の演奏会';
        const pieceGroups = groupBy(sheets, 'piece');
        return `
            <details class="mb-3 sheet-library-details sheet-performance-details" open>
                <summary class="d-flex flex-wrap justify-content-between align-items-center gap-2">
                    <strong class="sheet-library-heading">${escapeHtml(performanceTitle)}</strong>
                    <a class="btn btn-sm btn-primary" href="${escapeHtml(sheetZipUrl(performanceId, '', filters.part))}">演奏会一括DL</a>
                </summary>
                <div class="mt-2">
                    ${Object.entries(pieceGroups).map(([piece, pieceSheets]) => `
                        <details class="mb-2 ms-md-3 sheet-library-details sheet-piece-details">
                            <summary class="d-flex flex-wrap justify-content-between align-items-center gap-2">
                                <span class="sheet-library-heading">${escapeHtml(piece || '未設定の曲名')}</span>
                                <a class="btn btn-sm btn-outline-primary" href="${escapeHtml(sheetZipUrl(performanceId, piece, filters.part))}">曲一括DL</a>
                            </summary>
                            <div class="list-group mt-2">
                                ${pieceSheets.map((sheet) => `
                                    <div class="list-group-item d-flex flex-wrap justify-content-between align-items-center gap-2">
                                        <span>${escapeHtml(displayNameWithoutExtension(sheet.name || '楽譜'))}<span class="badge text-bg-secondary ms-2">${escapeHtml(sheet.part || 'パート未設定')}</span></span>
                                        <span class="d-flex gap-2">
                                            <button class="btn btn-sm btn-outline-primary" type="button" data-sheet-view="${escapeHtml(String(sheet.id || ''))}">表示</button>
                                            <a class="btn btn-sm btn-primary" href="${escapeHtml(sheet.download_url || sheet.url || '#')}" download>DL</a>
                                        </span>
                                    </div>
                                `).join('')}
                            </div>
                        </details>
                    `).join('')}
                </div>
            </details>
        `;
    }).join('');
    bindSheetLibraryFilters();
    c.querySelectorAll('[data-sheet-view]').forEach((button) => {
        button.addEventListener('click', () => showSheetViewer(button.dataset.sheetView || ''));
    });
}


function showSheetViewer(sheetId) {
    const sheet = appState.sheetLibrary.find((item) => String(item.id || '') === String(sheetId));
    if (!sheet) {
        showAlert('表示する楽譜が見つかりません', 'warning');
        return;
    }
    const viewUrl = sheet.view_url || sheet.url || '';
    if (!viewUrl) {
        showAlert('楽譜の表示URLが見つかりません', 'warning');
        return;
    }
    const title = $('sheetViewerTitle');
    const download = $('sheetViewerDownload');
    if (title) title.textContent = displayNameWithoutExtension(sheet.name || '楽譜表示');
    if (download) download.href = sheet.download_url || sheet.url || viewUrl;
    switchTab('memberPanel', 'member-sheet-viewer', false);
    renderPdfViewer(viewUrl);
}


function clearSheetViewer() {
    appState.sheetPdfUrl = '';
    appState.sheetPdfRendering = false;
    const pages = $('sheetViewerPages');
    const status = $('sheetViewerStatus');
    if (pages) pages.innerHTML = '';
    if (status) status.textContent = '';
}

// PDF.js は楽譜ビューを開くまで遅延ロードし、通常利用時の初期コストを避ける。


function zoomSheetViewer(delta) {
    if (!appState.sheetPdfUrl || appState.sheetPdfRendering) return;
    const nextScale = Math.max(0.35, Math.min(3, appState.sheetPdfScale + delta));
    renderPdfViewer(appState.sheetPdfUrl, nextScale);
}


async function fitSheetViewerWidth() {
    if (!appState.sheetPdfUrl || appState.sheetPdfRendering) return;
    renderPdfViewer(appState.sheetPdfUrl, null);
}


function sheetViewerFitScale(page) {
    const body = $('sheetViewerPages');
    const viewport = page.getViewport({ scale: 1 });
    const availableWidth = Math.max((body?.clientWidth || window.innerWidth) - 24, 280);
    return Math.max(0.35, Math.min(2.5, availableWidth / viewport.width));
}


function bindSheetLibraryFilters() {
    const performance = $('memberSheetPerformanceFilter');
    const piece = $('memberSheetPieceFilter');
    const part = $('memberSheetPartFilter');
    if (performance) performance.addEventListener('change', () => {
        appState.sheetFilters.performanceId = performance.value;
        appState.sheetFilters.piece = '';
        appState.sheetFilters.part = '';
        renderSheetLibraryView();
    });
    if (piece) piece.addEventListener('change', () => {
        appState.sheetFilters.piece = piece.value;
        appState.sheetFilters.part = '';
        renderSheetLibraryView();
    });
    if (part) part.addEventListener('change', () => {
        appState.sheetFilters.part = part.value;
        renderSheetLibraryView();
    });
    if ($('memberSheetFilterClearBtn')) $('memberSheetFilterClearBtn').addEventListener('click', () => {
        appState.sheetFilters = { performanceId: '', piece: '', part: '' };
        renderSheetLibraryView();
    });
}


function renderSheetAdmin() {
    const performanceSelect = $('sheetPerformanceSelect');
    const list = $('sheetAdminList');
    if (!performanceSelect || !list) return;

    const selectedPerformance = performanceSelect.value;
    performanceSelect.innerHTML = ['<option value="">選択してください</option>'].concat(
        appState.performances.map((perf) => `<option value="${escapeHtml(String(perf.id))}" ${String(perf.id) === selectedPerformance ? 'selected' : ''}>${escapeHtml(perf.title || '')}</option>`)
    ).join('');
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
    pieceSelect.innerHTML = pieces.length
        ? ['<option value="">選択してください</option>'].concat(pieces.map((piece) => `<option value="${escapeHtml(piece)}" ${piece === selectedPiece ? 'selected' : ''}>${escapeHtml(piece)}</option>`)).join('')
        : '<option value="">曲目が登録されていません</option>';
}


function sheetPieceOptions(performance) {
    return normalizePerformancePieces(performance?.pieces || []).map(performancePieceLabel).filter(Boolean);
}


function sheetFilterPerformanceOptions(selected = '') {
    const ids = [...new Set(appState.sheetLibrary.map((sheet) => String(sheet.performance_id || '')).filter(Boolean))];
    return ['<option value="">すべて</option>'].concat(ids.map((id) => {
        const performance = appState.performances.find((perf) => String(perf.id) === id);
        const fallback = appState.sheetLibrary.find((sheet) => String(sheet.performance_id || '') === id)?.performance_title || '未設定の演奏会';
        return `<option value="${escapeHtml(id)}" ${id === String(selected) ? 'selected' : ''}>${escapeHtml(performance?.title || fallback)}</option>`;
    })).join('');
}


function sheetFilterPieceOptions(selected = '', performanceId = '') {
    const performance = appState.performances.find((perf) => String(perf.id) === String(performanceId));
    const performancePieceOrder = performance ? (performance.pieces || []).map(performancePieceLabel) : [];
    
    const pieces = [...new Set(appState.sheetLibrary
        .filter((sheet) => !performanceId || String(sheet.performance_id || '') === String(performanceId))
        .map((sheet) => String(sheet.piece || ''))
        .filter(Boolean))];
    
    // Sort by performance piece order
    const sortedPieces = pieces.sort((a, b) => {
        const aIndex = performancePieceOrder.indexOf(a);
        const bIndex = performancePieceOrder.indexOf(b);
        if (aIndex >= 0 && bIndex >= 0) return aIndex - bIndex;
        if (aIndex >= 0) return -1;
        if (bIndex >= 0) return 1;
        return a.localeCompare(b, 'ja');
    });
    
    return ['<option value="">すべて</option>'].concat(sortedPieces.map((piece) => `<option value="${escapeHtml(piece)}" ${piece === selected ? 'selected' : ''}>${escapeHtml(piece)}</option>`)).join('');
}


function sheetFilterPartOptions(selected = '', performanceId = '', piece = '') {
    const parts = [...new Set(appState.sheetLibrary
        .filter((sheet) => !performanceId || String(sheet.performance_id || '') === String(performanceId))
        .filter((sheet) => !piece || String(sheet.piece || '') === piece)
        .map((sheet) => String(sheet.part || ''))
        .filter(Boolean))].sort((a, b) => partSortIndex(a) - partSortIndex(b) || a.localeCompare(b, 'ja'));
    return ['<option value="">すべて</option>'].concat(parts.map((part) => `<option value="${escapeHtml(part)}" ${part === selected ? 'selected' : ''}>${escapeHtml(part)}</option>`)).join('');
}

// bindSheetLibraryFilters moved to feature module.


async function uploadSheets() {
    const performanceId = $('sheetPerformanceSelect')?.value || '';
    const piece = $('sheetPieceSelect')?.value || '';
    const files = Array.from($('sheetFileInput')?.files || []);
    const performance = appState.performances.find((perf) => String(perf.id) === String(performanceId));
    if (!performanceId || !performance || !piece) {
        showAlert('演奏会と曲名を選択してください', 'warning');
        return;
    }
    if (!files.length) {
        showAlert('PDFファイルを選択してください', 'warning');
        return;
    }
    const pdfFiles = files.filter((file) => file.name.toLowerCase().endsWith('.pdf') || file.type === 'application/pdf');
    if (pdfFiles.length !== files.length) {
        showAlert('PDFファイルのみ登録できます', 'warning');
        return;
    }

    let completed = 0;
    setOperationStatus('sheetUploadProgress', `楽譜を登録しています。0 / ${pdfFiles.length} 件`);
    try {
        for (const file of pdfFiles) {
            const formData = new FormData();
            formData.append('file', file);
            formData.append('performance_id', performanceId);
            formData.append('performance_title', performance.title || '');
            formData.append('piece', piece);
            setOperationStatus('sheetUploadProgress', `登録中: ${file.name}（${completed + 1} / ${pdfFiles.length} 件）`);
            await request('/api/sheets/upload', { method: 'POST', body: formData });
            completed += 1;
            setOperationStatus('sheetUploadProgress', `登録完了: ${completed} / ${pdfFiles.length} 件`);
        }
        $('sheetFileInput').value = '';
        await loadSheets();
        setOperationStatus('sheetUploadProgress', `登録が完了しました。${completed} 件の楽譜を一覧に反映しました。`);
        showAlert(`${completed}件の楽譜を登録しました`, 'success');
    } catch (error) {
        setOperationStatus('sheetUploadProgress', `登録に失敗しました。${completed} / ${pdfFiles.length} 件まで完了しています。`, 'danger');
        throw error;
    }
}

// 楽譜管理一覧。
// 単票更新と一括更新を同じ一覧の中で扱えるよう、選択状態を appState に保持している。


function renderSheetAdminList() {
    const list = $('sheetAdminList');
    if (!list) return;
    if (!appState.sheetLibrary.length) {
        list.innerHTML = '<p class="text-muted mb-0">登録済みの楽譜はありません</p>';
        return;
    }

    const selectedCount = appState.selectedSheetIds.length;
    const selectedSheetIdSet = new Set(appState.selectedSheetIds.map(String));
    const selectionHtml = selectedCount > 0 ? `
        <div class="alert alert-info mb-3">
            <div class="d-flex flex-wrap justify-content-between align-items-center gap-2">
                <span><strong>${selectedCount} 件の楽譜を選択中</strong></span>
                <div class="d-flex flex-wrap gap-2">
                    <select class="form-select form-select-sm" id="bulkPartSelect" style="width: 12rem;">
                        ${partOptionHtml('')}
                    </select>
                    <button class="btn btn-sm btn-success" id="bulkPartSaveBtn" type="button">一括パート設定</button>
                    <button class="btn btn-sm btn-outline-secondary" id="clearSelectionBtn" type="button">選択解除</button>
                </div>
            </div>
        </div>
    ` : '';

    const performanceGroups = groupBy(appState.sheetLibrary, 'performance_id');
    list.innerHTML = selectionHtml + Object.entries(performanceGroups).map(([performanceId, sheets]) => {
        const performance = appState.performances.find((perf) => String(perf.id) === String(performanceId));
        const performanceTitle = performance?.title || sheets[0]?.performance_title || '未設定の演奏会';
        const pieceGroups = groupBy(sheets, 'piece');
        return `
            <section class="mb-4">
                <div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-2">
                    <h5 class="mb-0">${escapeHtml(performanceTitle)}</h5>
                    <button class="btn btn-sm btn-outline-danger sheet-delete-performance-btn" type="button" data-performance-id="${escapeHtml(performanceId)}">演奏会配下を削除</button>
                </div>
                ${Object.entries(pieceGroups).map(([piece, pieceSheets]) => `
                    <div class="list-group mb-3">
                        <div class="list-group-item d-flex flex-wrap justify-content-between align-items-center gap-2">
                            <strong>${escapeHtml(piece || '未設定の曲名')}</strong>
                            <button class="btn btn-sm btn-outline-danger sheet-delete-piece-btn" type="button" data-performance-id="${escapeHtml(performanceId)}" data-piece="${escapeHtml(piece)}">曲名配下を削除</button>
                        </div>
                        ${pieceSheets.map((sheet) => {
                            const isSelected = selectedSheetIdSet.has(String(sheet.id || ''));
                            return `
                            <div class="list-group-item d-flex flex-wrap justify-content-between align-items-center gap-2">
                                <div class="d-flex align-items-center gap-2">
                                    <input type="checkbox" class="form-check-input sheet-select-checkbox" data-sheet-id="${escapeHtml(String(sheet.id || ''))}" ${isSelected ? 'checked' : ''} style="cursor: pointer; margin: 0;">
                                    <span>${escapeHtml(displayNameWithoutExtension(sheet.name || '楽譜'))}<span class="badge text-bg-secondary ms-2">${escapeHtml(sheet.part || 'パート未設定')}</span></span>
                                </div>
                                <span class="d-flex flex-wrap gap-2 align-items-center">
                                    <select class="form-select form-select-sm sheet-part-assign-select" data-sheet-id="${escapeHtml(String(sheet.id || ''))}" style="width: 12rem;">
                                        ${partOptionHtml(sheet.part || '')}
                                    </select>
                                    <button class="btn btn-sm btn-outline-success sheet-part-save-btn" type="button" data-sheet-id="${escapeHtml(String(sheet.id || ''))}">パート保存</button>
                                    <a class="btn btn-sm btn-outline-primary" href="${escapeHtml(sheet.url || '#')}" target="_blank">閲覧</a>
                                    <a class="btn btn-sm btn-primary" href="${escapeHtml(sheet.download_url || sheet.url || '#')}" download>DL</a>
                                    <button class="btn btn-sm btn-outline-danger sheet-delete-file-btn" type="button" data-performance-id="${escapeHtml(performanceId)}" data-sheet-id="${escapeHtml(String(sheet.id || ''))}">削除</button>
                                </span>
                            </div>
                            `;
                        }).join('')}
                    </div>
                `).join('')}
            </section>
        `;
    }).join('');

    list.querySelectorAll('.sheet-select-checkbox').forEach((checkbox) => {
        checkbox.addEventListener('change', (event) => {
            const sheetId = event.currentTarget.dataset.sheetId || '';
            if (event.currentTarget.checked) {
                if (!appState.selectedSheetIds.includes(sheetId)) {
                    appState.selectedSheetIds.push(sheetId);
                }
            } else {
                appState.selectedSheetIds = appState.selectedSheetIds.filter((id) => id !== sheetId);
            }
            renderSheetAdminList();
        });
    });

    if ($('bulkPartSaveBtn')) {
        $('bulkPartSaveBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '保存中...', () => bulkSaveSheetParts()));
    }

    if ($('clearSelectionBtn')) {
        $('clearSelectionBtn').addEventListener('click', () => {
            appState.selectedSheetIds = [];
            renderSheetAdminList();
        });
    }

    list.querySelectorAll('.sheet-part-save-btn').forEach((button) => {
        button.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '保存中...', () => saveSheetPart(button.dataset.sheetId || '')));
    });
    list.querySelectorAll('.sheet-delete-file-btn').forEach((button) => {
        button.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', () => deleteSheets({
            performance_id: button.dataset.performanceId || '',
            sheet_id: Number(button.dataset.sheetId || 0)
        }, 'この楽譜を削除しますか？')));
    });
    list.querySelectorAll('.sheet-delete-piece-btn').forEach((button) => {
        button.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', () => deleteSheets({
            performance_id: button.dataset.performanceId || '',
            piece: button.dataset.piece || ''
        }, 'この曲名配下の楽譜を一括削除しますか？')));
    });
    list.querySelectorAll('.sheet-delete-performance-btn').forEach((button) => {
        button.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', () => deleteSheets({
            performance_id: button.dataset.performanceId || ''
        }, 'この演奏会配下の楽譜を一括削除しますか？')));
    });
}


function sheetPartOptions() {
    return currentPartNames();
}


async function deleteSheets(payload) {
    if (!confirmDelete()) return;
    await request('/api/sheets', jsonOptions('DELETE', payload));
    await loadSheets();
    showAlert('楽譜を削除しました', 'success');
}


async function saveSheetPart(sheetId) {
    if (!sheetId) return;
    const select = [...document.querySelectorAll('.sheet-part-assign-select')]
        .find((item) => String(item.dataset.sheetId || '') === String(sheetId));
    const part = select ? select.value : '';
    await request(`/api/sheets/${encodeURIComponent(sheetId)}/part`, jsonOptions('PUT', { part }));
    await loadSheets();
    showAlert('楽譜のパートを保存しました', 'success');
}


async function bulkSaveSheetParts() {
    const part = $('bulkPartSelect')?.value.trim() || '';
    if (!part) {
        showAlert('パートを選択してください', 'warning');
        return;
    }
    if (!appState.selectedSheetIds.length) {
        showAlert('楽譜を選択してください', 'warning');
        return;
    }
    const sheetIds = appState.selectedSheetIds.map((id) => Number(id) || 0).filter((id) => id > 0);
    await request('/api/sheets/parts', jsonOptions('PUT', { sheet_ids: sheetIds, part }));
    const count = sheetIds.length;
    appState.selectedSheetIds = [];
    await loadSheets();
    showAlert(`${count} 件の楽譜のパートを一括更新しました`, 'success');
}

// function renderPaymentView() moved to modules/payments.js.


function sheetZipUrl(performanceId, piece = '', part = '') {
    const params = new URLSearchParams({ performance_id: String(performanceId || '') });
    if (piece) params.set('piece', piece);
    if (part) params.set('part', part);
    return `/api/sheets/download-zip?${params.toString()}`;
}

// 楽譜管理画面の入口。
// 演奏会・曲目選択の状態を保ちながら一覧と操作部品を組み直す。

