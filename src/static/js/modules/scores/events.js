// Sheet events/actions split from modules/scores.js.
// Keep global names for compatibility with legacy non-module loading.

var appState = window.portalRuntimeContext.appState;
var $ = window.portalRuntimeContext.getById;

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

function showSheetViewer(sheetId) {
    const sheet = appState.sheetLibrary.find((item) => String(item.id || '') === String(sheetId));
    if (!sheet) { showAlert('表示する楽譜が見つかりません', 'warning'); return; }
    const viewUrl = sheet.view_url || sheet.url || '';
    if (!viewUrl) { showAlert('楽譜の表示URLが見つかりません', 'warning'); return; }
    const title = $('sheetViewerTitle');
    const download = $('sheetViewerDownload');
    if (title) title.textContent = displayNameWithoutExtension(sheet.name || '楽譜表示');
    if (download) download.href = sheet.download_url || sheet.url || viewUrl;
    if ($('sheetViewerBackBtn')) $('sheetViewerBackBtn').hidden = false;
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

function zoomSheetViewer(delta) {
    if (!appState.sheetPdfUrl || appState.sheetPdfRendering) return;
    const nextScale = Math.max(0.35, Math.min(3, appState.sheetPdfScale + delta));
    renderPdfViewer(appState.sheetPdfUrl, nextScale);
}

async function fitSheetViewerWidth() {
    if (!appState.sheetPdfUrl || appState.sheetPdfRendering) return;
    renderPdfViewer(appState.sheetPdfUrl, null);
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

async function uploadSheets() {
    const performanceId = $('sheetPerformanceSelect')?.value || '';
    const piece = $('sheetPieceSelect')?.value || '';
    const files = Array.from($('sheetFileInput')?.files || []);
    const performance = appState.performances.find((perf) => String(perf.id) === String(performanceId));
    if (!performanceId || !performance || !piece) { showAlert('演奏会と曲名を選択してください', 'warning'); return; }
    if (!files.length) { showAlert('PDFファイルを選択してください', 'warning'); return; }
    const pdfFiles = files.filter((file) => file.name.toLowerCase().endsWith('.pdf') || file.type === 'application/pdf');
    if (pdfFiles.length !== files.length) { showAlert('PDFファイルのみ登録できます', 'warning'); return; }
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

async function deleteSheets(payload) {
    if (!confirmDelete()) return;
    await request('/api/sheets', jsonOptions('DELETE', payload));
    await loadSheets();
    showAlert('楽譜を削除しました', 'success');
}

async function saveSheetPart(sheetId) {
    if (!sheetId) return;
    const select = [...document.querySelectorAll('.sheet-part-assign-select')].find((item) => String(item.dataset.sheetId || '') === String(sheetId));
    const part = select ? select.value : '';
    await request(`/api/sheets/${encodeURIComponent(sheetId)}/part`, jsonOptions('PUT', { part }));
    await loadSheets();
    showAlert('楽譜のパートを保存しました', 'success');
}

async function bulkSaveSheetParts() {
    const part = $('bulkPartSelect')?.value.trim() || '';
    if (!part) { showAlert('パートを選択してください', 'warning'); return; }
    if (!appState.selectedSheetIds.length) { showAlert('楽譜を選択してください', 'warning'); return; }
    const sheetIds = appState.selectedSheetIds.map((id) => Number(id) || 0).filter((id) => id > 0);
    await request('/api/sheets/parts', jsonOptions('PUT', { sheet_ids: sheetIds, part }));
    const count = sheetIds.length;
    appState.selectedSheetIds = [];
    await loadSheets();
    showAlert(`${count} 件の楽譜のパートを一括更新しました`, 'success');
}
