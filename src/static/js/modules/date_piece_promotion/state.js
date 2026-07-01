// Date/piece/promotion shared state helpers split from modules/date_piece_promotion.js.
// Keep global names for legacy non-module loading.

var appState = (typeof window.getAppState === 'function')
    ? window.getAppState()
    : window.portalRuntimeContext.appState;
var $ = window.portalRuntimeContext.getById;

function desiredPieceCurrentVoterKey() {
    return String(appState.currentUserMemberId || currentUserMemberName() || '');
}

function desiredPieceVotes(item) {
    return Array.isArray(item.votes) ? item.votes : [];
}

function desiredPieceHasVoted(item) {
    const key = desiredPieceCurrentVoterKey();
    const name = currentUserMemberName();
    return desiredPieceVotes(item).some((vote) => String(vote.member_id || vote.name || vote) === key || (name && String(vote.name || vote) === name));
}

function desiredPieceIsOwner(item) {
    const memberId = String(appState.currentUserMemberId || '');
    const name = currentUserMemberName();
    return (memberId && String(item.member_id || '') === memberId) || (name && String(item.registered_by || item.name || '') === name);
}

function clearDesiredPieceForm() {
    ['desiredPieceId', 'desiredPieceTitle', 'desiredPieceComposer', 'desiredPieceDuration', 'desiredPieceFormation', 'desiredPieceNotes'].forEach((id) => { if ($(id)) $(id).value = ''; });
    if ($('desiredPieceGenre')) $('desiredPieceGenre').value = 'クラシック';
}

function fillDesiredPieceForm(id) {
    const item = appState.desiredPieces.find((piece) => String(piece.id || '') === String(id));
    if (!item) return;
    $('desiredPieceId').value = item.id || '';
    $('desiredPieceTitle').value = item.title || item.piece || '';
    $('desiredPieceComposer').value = item.composer || '';
    $('desiredPieceDuration').value = item.duration || '';
    $('desiredPieceGenre').value = item.genre || 'クラシック';
    $('desiredPieceFormation').value = item.formation || '';
    $('desiredPieceNotes').value = item.notes || '';
    $('desiredPieceTitle').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function promotionIsOwner(item) {
    const currentId = String(appState.currentUserMemberId || '');
    const currentName = currentUserMemberName();
    return (currentId && String(item?.member_id || '') === currentId)
        || (currentName && String(item?.registered_by || '') === currentName);
}

function fillPromotionForm(id) {
    const item = appState.promotions.find((promotion) => String(promotion.id || '') === String(id));
    if (!item) return;
    if ($('promotionId')) $('promotionId').value = item.id || '';
    if ($('promotionTitle')) $('promotionTitle').value = item.title || '';
    if ($('promotionSummary')) $('promotionSummary').value = item.summary || item.description || '';
    if ($('promotionImageFile')) $('promotionImageFile').value = '';
    if ($('promotionImagePreview')) $('promotionImagePreview').innerHTML = item.image_url ? `<img src="${escapeHtml(item.image_url)}" class="img-fluid rounded border" alt="宣伝画像">` : '';
}

function clearPromotionForm() {
    if ($('promotionId')) $('promotionId').value = '';
    if ($('promotionTitle')) $('promotionTitle').value = '';
    if ($('promotionSummary')) $('promotionSummary').value = '';
    if ($('promotionImageFile')) $('promotionImageFile').value = '';
    if ($('promotionImagePreview')) $('promotionImagePreview').innerHTML = '';
}
