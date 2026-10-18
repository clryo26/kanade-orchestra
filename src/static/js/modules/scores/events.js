// Sheet events/actions split from modules/scores.js.
// Keep global names for compatibility with legacy non-module loading.
//
// The list is synchronized by scores/sync.js; the viewer is scores/pdf_viewer.js;
// saving is scores/save_dialog.js; registering is scores/upload_batch.js.
// Changes send the revision the user saw and an operation ID
// (docs/SHEET_LIBRARY_RELIABILITY_DESIGN.md, section 1).

var appState = window.portalRuntimeContext.appState;
var $ = window.portalRuntimeContext.getById;

// Compatibility name: a full reload of the list (waits for the result).
async function loadSheets() {
    const result = await refreshSheetLibrary({ force: true, reason: 'load' });
    if (!result.ok && result.reason !== 'account' && result.reason !== 'signed-out') {
        throw new Error(result.message || '楽譜一覧を取得できませんでした');
    }
    return result;
}

// A library tab is shown: draw what is known at once (bootstrap), then check
// the server's version (always, also when the list came with the bootstrap).
async function ensureSheetsLoaded() {
    const container = $('memberSheetInfo');
    if (appState.sheetLibrary?.length || appState.sheetsLoaded) {
        renderSheetLibraryView();
        if ($('sheetAdminList')) renderSheetAdmin();
    } else if (container && !container.innerHTML.trim()) {
        container.innerHTML = '<p class="text-muted mb-0">楽譜一覧を読み込み中です...</p>';
    }
    if (typeof renderSheetUploadResume === 'function') renderSheetUploadResume();
    if ($('sheetUploadCancelBtn') && !$('sheetUploadCancelBtn').dataset.bound) {
        $('sheetUploadCancelBtn').dataset.bound = '1';
        $('sheetUploadCancelBtn').addEventListener('click', () => cancelSheetUpload());
    }
    return startSheetLibrarySync();
}

function showSheetViewer(sheetId, returnTo = null) {
    const sheet = appState.sheetLibrary.find((item) => String(item.id || '') === String(sheetId));
    if (!sheet) { showAlert('表示する楽譜が見つかりません。一覧を更新してください', 'warning'); return; }
    const viewUrl = sheet.view_url || sheet.url || '';
    if (!viewUrl) { showAlert('楽譜の表示URLが見つかりません', 'warning'); return; }
    const title = $('sheetViewerTitle');
    if (title) title.textContent = displayNameWithoutExtension(sheet.name || '楽譜表示');
    appState.sheetViewerContext = { kind: 'sheet', sheetId: sheet.id };
    appState.sheetViewerReturn = returnTo;
    if ($('sheetViewerBackBtn')) $('sheetViewerBackBtn').hidden = false;
    switchTab('memberPanel', 'member-sheet-viewer', false);
    renderPdfViewer(viewUrl);
}

// DL of a single sheet, a piece or a concert: the common save dialog.
function openSheetFileSave(sheetId, opener) {
    const sheet = appState.sheetLibrary.find((item) => String(item.id || '') === String(sheetId));
    if (!sheet) { showAlert('楽譜が見つかりません。一覧を更新してください', 'warning'); return; }
    openSheetSave({ kind: 'file', sheet }, opener);
}

// scope: 'performance' (all pieces) or 'piece' (this piece, also an unnamed one).
function openSheetZipSave(performanceId, piece, part, opener, scope = piece ? 'piece' : 'performance') {
    const sheets = appState.sheetLibrary.filter((s) => String(s.performance_id || '') === String(performanceId)
        && (scope !== 'piece' || String(s.piece || '') === String(piece || '')) && (!part || String(s.part || '') === part));
    const performance = appState.performances.find((perf) => String(perf.id) === String(performanceId));
    openSheetSave({
        kind: 'zip', performanceId, piece: piece || '', part: part || '', scope, count: sheets.length,
        title: performance?.title || sheets[0]?.performance_title || '楽譜',
    }, opener);
}

function bindSheetLibraryFilters() {
    const performance = $('memberSheetPerformanceFilter');
    const piece = $('memberSheetPieceFilter');
    const part = $('memberSheetPartFilter');
    if (performance) performance.addEventListener('change', () => { appState.sheetFilters.performanceId = performance.value; appState.sheetFilters.piece = ''; appState.sheetFilters.part = ''; renderSheetLibraryView(); });
    if (piece) piece.addEventListener('change', () => { appState.sheetFilters.piece = piece.value; appState.sheetFilters.part = ''; renderSheetLibraryView(); });
    if (part) part.addEventListener('change', () => { appState.sheetFilters.part = part.value; renderSheetLibraryView(); });
    if ($('memberSheetFilterClearBtn')) $('memberSheetFilterClearBtn').addEventListener('click', () => { appState.sheetFilters = { performanceId: '', piece: '', part: '' }; renderSheetLibraryView(); });
}

// One operation ID per user action. When its answer was lost, pressing the
// button again for the same change resends the same ID (the server returns
// the stored result instead of applying it twice).
var sheetPendingOperations = {};

async function sendSheetChange(kind, url, method, payload) {
    const key = kind + ':' + JSON.stringify(payload);
    const operationId = sheetPendingOperations[key] || portalSheetApi.newOperationId();
    sheetPendingOperations[key] = operationId;
    let result;
    try {
        result = await portalSheetApi.call(url, { method, json: payload, headers: { 'Idempotency-Key': operationId } });
    } catch (error) {
        if (error?.kind === 'account') throw error;
        throw new Error('結果を確認できませんでした。もう一度押すと、同じ操作として送り直します（二重には実行されません）。');
    }
    if (result.status === 202) {
        throw new Error('処理中です。少し待ってからもう一度押すと結果を確認します。');
    }
    delete sheetPendingOperations[key];
    if (result.status === 409 && result.data?.detail?.code === 'sheet_revision_conflict') {
        await refreshSheetLibrary({ force: true, reason: 'conflict' });
        throw new Error(result.data.detail.message);
    }
    if (result.status === 428) {
        throw new Error('画面が古いため保存できませんでした。登録や保存が終わったら、画面を再読み込みしてください。');
    }
    if (result.status !== 200) {
        throw new Error(portalSheetApi.detailMessage(result.data, `保存できませんでした（${result.status}）`));
    }
    await refreshSheetLibrary({ force: true, reason: kind });
    return result.data;
}

function sheetItems(sheets) {
    return sheets.map((sheet) => ({ id: Number(sheet.id), expected_revision: Number(sheet.revision || 1) }));
}

// scope: { sheetId } | { performanceId, piece? } — expanded to the sheets
// shown now. Sheets added meanwhile on another device are never included.
async function deleteSheets(scope) {
    const sheets = scope.sheetId
        ? appState.sheetLibrary.filter((s) => String(s.id) === String(scope.sheetId))
        : appState.sheetLibrary.filter((s) => String(s.performance_id || '') === String(scope.performanceId)
            // A piece without a name ('') is a piece of its own, not "all pieces".
            && (!Object.prototype.hasOwnProperty.call(scope, 'piece') || String(s.piece || '') === String(scope.piece)));
    if (!sheets.length) { showAlert('削除する楽譜がありません。一覧を更新してください', 'warning'); return; }
    const message = sheets.length === 1
        ? `「${displayNameWithoutExtension(sheets[0].name || '楽譜')}」を削除しますか？`
        : `表示中の楽譜 ${sheets.length} 件を削除しますか？（一覧を読み込んだ後にほかの端末で追加された楽譜は削除されません）`;
    if (!window.confirm(message)) return;
    try {
        const data = await sendSheetChange('delete', '/api/sheets', 'DELETE', { items: sheetItems(sheets) });
        showAlert(`楽譜を ${data.deleted} 件削除しました`, 'success');
    } catch (error) {
        showAlert(error.message, 'danger');
    }
}

async function saveSheetPart(sheetId) {
    if (!sheetId) return;
    const sheet = appState.sheetLibrary.find((s) => String(s.id) === String(sheetId));
    if (!sheet) { showAlert('楽譜が見つかりません。一覧を更新してください', 'warning'); return; }
    const select = [...document.querySelectorAll('.sheet-part-assign-select')].find((item) => String(item.dataset.sheetId || '') === String(sheetId));
    const part = select ? select.value : '';
    try {
        await sendSheetChange('part', `/api/sheets/${encodeURIComponent(sheetId)}/part`, 'PUT', { part, expected_revision: Number(sheet.revision || 1) });
        showAlert('楽譜のパートを保存しました', 'success');
    } catch (error) {
        showAlert(error.message, 'danger');
    }
}

async function bulkSaveSheetParts() {
    const part = $('bulkPartSelect')?.value.trim() || '';
    if (!part) { showAlert('パートを選択してください', 'warning'); return; }
    const selected = new Set(appState.selectedSheetIds.map(String));
    const sheets = appState.sheetLibrary.filter((s) => selected.has(String(s.id)));
    if (!sheets.length) { showAlert('楽譜を選択してください', 'warning'); return; }
    try {
        const data = await sendSheetChange('bulk_part', '/api/sheets/parts', 'PUT', { part, items: sheetItems(sheets) });
        appState.selectedSheetIds = [];
        renderSheetAdminList();
        showAlert(`${data.updated_count} 件の楽譜のパートを一括更新しました`, 'success');
    } catch (error) {
        showAlert(error.message, 'danger');
    }
}
