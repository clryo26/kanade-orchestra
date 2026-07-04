// Practice/casting helpers split from modules/practice_casting.js.
// Keep global names for compatibility with legacy non-module loading.

var appState = window.portalRuntimeContext.appState;

function partOptionHtml(selected = '') {
    return ['<option value="">選択してください</option>']
        .concat(sheetPartOptions().map((part) => `<option value="${escapeHtml(part)}" ${part === selected ? 'selected' : ''}>${escapeHtml(part)}</option>`))
        .join('');
}

function populateCastingForm() {
    if ($('castingPieceInput')) $('castingPieceInput').value = appState.castingEditingPiece || '';
    renderCastingMembersList();
    renderCastingExtrasList();
}

function setCastingEditor(casting, fallbackPerformanceId = null) {
    if (casting) {
        appState.castingEditingId = casting.id || null;
        appState.castingEditingPerformanceId = casting.performance_id || fallbackPerformanceId || null;
        appState.castingEditingPiece = casting.piece || '';
        appState.castingEditingMembers = Array.isArray(casting.members) ? casting.members.map((m) => ({ ...m })) : [];
        appState.castingEditingExtras = Array.isArray(casting.extras) ? casting.extras.map((e) => ({ ...e })) : [];
    } else {
        appState.castingEditingId = null;
        appState.castingEditingPerformanceId = fallbackPerformanceId || null;
        appState.castingEditingPiece = '';
        appState.castingEditingMembers = [];
        appState.castingEditingExtras = [];
    }
    populateCastingForm();
}

function loadCastingRecord(casting) {
    setCastingEditor(casting, casting?.performance_id || null);
}

function loadCastingById(performanceId) {
    if (!performanceId) {
        setCastingEditor(null, null);
        return;
    }
    const casting = appState.castings.find((c) => String(c.performance_id || '') === String(performanceId));
    setCastingEditor(casting || null, performanceId);
}

function clearCastingForm() {
    appState.castingEditingId = null;
    appState.castingEditingPerformanceId = Number($('castingPerformanceSelect')?.value || 0) || null;
    appState.castingEditingPiece = '';
    appState.castingEditingMembers = [];
    appState.castingEditingExtras = [];
    populateCastingForm();
}