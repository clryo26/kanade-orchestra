// Sheet helpers split from modules/scores.js.
// Keep global names for compatibility with legacy non-module loading.

var appState = window.portalRuntimeContext.appState;

function canManageSheets() {
    return canAccessAdmin() || appState.currentUserIsSheetManager;
}

function sheetViewerFitScale(page) {
    const body = $('sheetViewerPages');
    const viewport = page.getViewport({ scale: 1 });
    const availableWidth = Math.max((body?.clientWidth || window.innerWidth) - 24, 280);
    return Math.max(0.35, Math.min(2.5, availableWidth / viewport.width));
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
    const pieces = [...new Set(appState.sheetLibrary.filter((sheet) => !performanceId || String(sheet.performance_id || '') === String(performanceId)).map((sheet) => String(sheet.piece || '')).filter(Boolean))];
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
    const parts = [...new Set(appState.sheetLibrary.filter((sheet) => !performanceId || String(sheet.performance_id || '') === String(performanceId)).filter((sheet) => !piece || String(sheet.piece || '') === piece).map((sheet) => String(sheet.part || '')).filter(Boolean))].sort((a, b) => partSortIndex(a) - partSortIndex(b) || a.localeCompare(b, 'ja'));
    return ['<option value="">すべて</option>'].concat(parts.map((part) => `<option value="${escapeHtml(part)}" ${part === selected ? 'selected' : ''}>${escapeHtml(part)}</option>`)).join('');
}

function sheetPartOptions() {
    return currentPartNames();
}

function sheetZipUrl(performanceId, piece = '', part = '') {
    const params = new URLSearchParams({ performance_id: String(performanceId || '') });
    if (piece) params.set('piece', piece);
    if (part) params.set('part', part);
    return `/api/sheets/download-zip?${params.toString()}`;
}