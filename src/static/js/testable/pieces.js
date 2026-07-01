(function (globalObj) {
    function resolveOrgShortName(org) {
        return String(org?.short_name || org?.shortName || org?.abbreviation || org?.short || org?.organization_abbreviation || org?.organizationAbbreviation || org?.name || org?.organization_name || org?.organizationName || org?.organization_name_full || org?.organizationNameFull || '楽団').trim() || '楽団';
    }
    function portalTitleTextFromOrg(org) { return `${resolveOrgShortName(org)}ポータル`; }
    function performancePieceLabel(piece) {
        if (typeof piece === 'string') return piece;
        const label = piece?.alias || piece?.short_name || (piece?.composer ? `${piece.composer}: ${piece.title}` : piece?.title);
        return (piece?.is_encore || piece?.encore) ? `(${label})` : label;
    }
    function performancePieceFormalLabel(piece) {
        if (typeof piece === 'string') return piece;
        const label = piece?.composer ? `${piece.composer}: ${piece.title}` : piece?.title;
        return (piece?.is_encore || piece?.encore) ? `(${label})` : label;
    }
    function performancePieceLookupLabels(piece) {
        if (typeof piece === 'string') return [piece].filter(Boolean);
        return [performancePieceLabel(piece), performancePieceFormalLabel(piece), piece?.title, piece?.alias, piece?.short_name, piece?.composer && piece?.title ? `${piece.composer}: ${piece.title}` : ''].map((value) => String(value || '').trim()).filter((value, index, array) => value && array.indexOf(value) === index);
    }
    function findPieceScopedItem(items, performanceId, piece) {
        const labels = performancePieceLookupLabels(piece);
        return (items || []).find((item) => String(item.performance_id || '') === String(performanceId || '') && labels.includes(String(item.piece || item.title || '').trim()));
    }
    const api = { resolveOrgShortName, portalTitleTextFromOrg, performancePieceLabel, performancePieceFormalLabel, performancePieceLookupLabels, findPieceScopedItem };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    globalObj.FrontendTestablePieces = api;
})(typeof window !== 'undefined' ? window : globalThis);