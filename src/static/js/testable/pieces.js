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
        const partPrefix = String(piece?.part || piece?.section || '').trim();
        return [performancePieceLabel(piece), performancePieceFormalLabel(piece), partPrefix, partPrefix && piece?.title ? `${partPrefix} ${piece.title}` : '', partPrefix && piece?.alias ? `${partPrefix} ${piece.alias}` : '', partPrefix && piece?.composer && piece?.title ? `${partPrefix} ${piece.composer}: ${piece.title}` : '', piece?.title, piece?.alias, piece?.short_name, piece?.composer && piece?.title ? `${piece.composer}: ${piece.title}` : ''].map((value) => String(value || '').trim()).filter((value, index, array) => value && array.indexOf(value) === index);
    }
    function findPieceScopedItem(items, performanceId, piece) {
        const labels = performancePieceLookupLabels(piece);
        return (items || []).find((item) => String(item.performance_id || '') === String(performanceId || '') && labels.includes(String(item.piece || item.title || '').trim()));
    }
    function normalizePerformancePieces(pieces) {
        return (pieces || []).map((piece) => {
            if (typeof piece === 'string') return { composer: '', title: piece, part: '' };
            return {
                composer: piece?.composer || '',
                title: piece?.title || piece?.name || '',
                alias: piece?.alias || piece?.short_name || '',
                part: piece?.part || piece?.section || '',
                duration: piece?.duration || '',
                is_encore: Boolean(piece?.is_encore || piece?.encore),
            };
        }).filter((piece) => piece.title);
    }
    function performancePieceDurationText(piece) {
        const value = String(piece?.duration || '').trim();
        return value ? `演奏時間: ${value}分` : '';
    }
    function pieceScopedRows(performances, scopedItems) {
        return (performances || []).map((perf) => {
            const normalizedPieces = normalizePerformancePieces(perf?.pieces || []);
            const labels = new Set(normalizedPieces.flatMap(performancePieceLookupLabels));
            (scopedItems || []).forEach((item) => {
                if (String(item?.performance_id || '') !== String(perf?.id || '')) return;
                const itemPiece = String(item?.piece || item?.title || '').trim();
                if (!itemPiece || labels.has(itemPiece)) return;
                normalizedPieces.push({ composer: '', title: itemPiece, alias: '' });
                labels.add(itemPiece);
            });
            return {
                performanceId: String(perf?.id || ''),
                title: String(perf?.title || ''),
                date: String(perf?.date || ''),
                pieces: normalizedPieces,
            };
        });
    }
    function uploadPieceOptions(performance, wholePracticeLabel = '練習全体の通し') {
        if (!performance) return [];
        const options = normalizePerformancePieces(performance?.pieces || [])
            .map((piece) => ({ value: performancePieceLabel(piece), label: performancePieceFormalLabel(piece) }))
            .filter((option) => option.value);
        options.push({ value: wholePracticeLabel, label: wholePracticeLabel });
        const seen = new Set();
        return options.filter((option) => {
            if (seen.has(option.value)) return false;
            seen.add(option.value);
            return true;
        });
    }
    const api = {
        resolveOrgShortName,
        portalTitleTextFromOrg,
        performancePieceLabel,
        performancePieceFormalLabel,
        performancePieceLookupLabels,
        findPieceScopedItem,
        normalizePerformancePieces,
        performancePieceDurationText,
        pieceScopedRows,
        uploadPieceOptions,
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    globalObj.FrontendTestablePieces = api;
})(typeof window !== 'undefined' ? window : globalThis);
