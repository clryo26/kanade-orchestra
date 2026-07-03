// Performance module.

async function savePerformance() {
    const flyerFile = $('perfFlyerFile')?.files?.[0];
    const flyerImage = flyerFile ? await fileToDataUrl(flyerFile) : ($('perfFlyerImage')?.value || '');
    const payload = {
        title: $('perfTitle').value.trim(),
        date: $('perfDate').value,
        open_time: $('perfOpenTime').value,
        start_time: $('perfStartTime').value,
        venue: $('perfVenue').value.trim(),
        conductor: $('perfConductor').value.trim(),
        flyer_image: flyerImage,
        pieces: currentPerformancePieces()
    };
    if (!payload.title || !payload.date) {
        showAlert('タイトルと開催日を入力してください', 'warning');
        return;
    }

    const id = $('perfId').value;
    await request(id ? `/api/performances/${id}` : '/api/performances', jsonOptions(id ? 'PUT' : 'POST', payload));
    clearPerformanceForm();
    await loadPerformances();
    showAlert('演奏会情報を保存しました', 'success');
}

function selectPerformance(id) {
    const item = appState.performances.find((perf) => perf.id === id);
    if (!item) return;
    $('perfId').value = item.id;
    $('perfTitle').value = item.title || '';
    $('perfDate').value = item.date || today();
    $('perfOpenTime').value = item.open_time || '18:00';
    $('perfStartTime').value = item.start_time || '19:00';
    if ($('perfVenue')) $('perfVenue').innerHTML = venueSelectOptionsHtml('performance', item.venue || '');
    $('perfVenue').value = item.venue || '';
    $('perfConductor').value = item.conductor || '';
    if ($('perfFlyerImage')) $('perfFlyerImage').value = item.flyer_image || '';
    renderPerformanceFlyerPreview(item.flyer_image || '');
    if ($('perfFlyerFile')) $('perfFlyerFile').value = '';
    appState.performancePieces = normalizePerformancePieces(item.pieces || []);
    renderPerformancePieceList();
}

async function deletePerformance() {
    const id = $('perfId').value;
    if (!id) {
        showAlert('削除する演奏会を一覧から選択してください', 'warning');
        return;
    }
    if (!confirmDelete()) return;
    await request(`/api/performances/${id}`, { method: 'DELETE' });
    clearPerformanceForm();
    await loadPerformances();
    showAlert('演奏会情報を削除しました', 'success');
}

function clearPerformanceForm() {
    $('perfId').value = '';
    $('perfTitle').value = '';
    $('perfDate').value = today();
    $('perfOpenTime').value = '18:00';
    $('perfStartTime').value = '19:00';
    if ($('perfVenue')) $('perfVenue').innerHTML = venueSelectOptionsHtml('performance', '');
    $('perfVenue').value = '';
    $('perfConductor').value = '';
    if ($('perfFlyerFile')) $('perfFlyerFile').value = '';
    if ($('perfFlyerImage')) $('perfFlyerImage').value = '';
    renderPerformanceFlyerPreview('');
    $('perfPieceComposer').value = '';
    $('perfPieceTitle').value = '';
    if ($('perfPieceAlias')) $('perfPieceAlias').value = '';
    if ($('perfPieceDuration')) $('perfPieceDuration').value = '';
    appState.performancePieces = [];
    appState.performancePieceEditIndex = null;
    $('addPieceBtn').textContent = '曲を追加';
    renderPerformancePieceList();
}

function addPerformancePiece() {
    const composer = $('perfPieceComposer').value.trim();
    const title = $('perfPieceTitle').value.trim();
    const alias = $('perfPieceAlias') ? $('perfPieceAlias').value.trim() : '';
    const duration = $('perfPieceDuration') ? $('perfPieceDuration').value.trim() : '';
    const isEncore = $('perfPieceEncore') ? $('perfPieceEncore').checked : false;
    if (!title) {
        showAlert('曲名を入力してください', 'warning');
        return;
    }

    const piece = { composer, title, alias, duration, is_encore: isEncore };
    if (appState.performancePieceEditIndex !== null) {
        appState.performancePieces[appState.performancePieceEditIndex] = piece;
        appState.performancePieceEditIndex = null;
        $('addPieceBtn').textContent = '曲を追加';
    } else {
        appState.performancePieces.push(piece);
    }
    $('perfPieceComposer').value = '';
    $('perfPieceTitle').value = '';
    if ($('perfPieceAlias')) $('perfPieceAlias').value = '';
    if ($('perfPieceDuration')) $('perfPieceDuration').value = '';
    if ($('perfPieceEncore')) $('perfPieceEncore').checked = false;
    renderPerformancePieceList();
}

function editPerformancePiece(index) {
    const piece = appState.performancePieces[index];
    if (!piece) return;
    $('perfPieceComposer').value = piece.composer || '';
    $('perfPieceTitle').value = piece.title || '';
    if ($('perfPieceAlias')) $('perfPieceAlias').value = piece.alias || '';
    if ($('perfPieceDuration')) $('perfPieceDuration').value = piece.duration || '';
    if ($('perfPieceEncore')) $('perfPieceEncore').checked = Boolean(piece.is_encore || piece.encore);
    appState.performancePieceEditIndex = index;
    $('addPieceBtn').textContent = '曲を更新';
}

function removePerformancePiece(index) {
    if (!confirmDelete()) return;
    appState.performancePieces.splice(index, 1);
    if (appState.performancePieceEditIndex === index) {
        appState.performancePieceEditIndex = null;
        $('addPieceBtn').textContent = '曲を追加';
        $('perfPieceComposer').value = '';
        $('perfPieceTitle').value = '';
        if ($('perfPieceAlias')) $('perfPieceAlias').value = '';
        if ($('perfPieceDuration')) $('perfPieceDuration').value = '';
        if ($('perfPieceEncore')) $('perfPieceEncore').checked = false;
    } else if (appState.performancePieceEditIndex !== null && appState.performancePieceEditIndex > index) {
        appState.performancePieceEditIndex -= 1;
    }
    renderPerformancePieceList();
}

function movePerformancePiece(index, direction) {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= appState.performancePieces.length) return;
    const [piece] = appState.performancePieces.splice(index, 1);
    appState.performancePieces.splice(nextIndex, 0, piece);
    if (appState.performancePieceEditIndex === index) {
        appState.performancePieceEditIndex = nextIndex;
    } else if (appState.performancePieceEditIndex === nextIndex) {
        appState.performancePieceEditIndex = index;
    }
    renderPerformancePieceList();
}

function currentPerformancePieces() {
    const composer = $('perfPieceComposer').value.trim();
    const title = $('perfPieceTitle').value.trim();
    const alias = $('perfPieceAlias') ? $('perfPieceAlias').value.trim() : '';
    const duration = $('perfPieceDuration') ? $('perfPieceDuration').value.trim() : '';
    const pieces = [...appState.performancePieces];
    if (title) {
        pieces.push({ composer, title, alias, duration, is_encore: $('perfPieceEncore') ? $('perfPieceEncore').checked : false });
    }
    return pieces;
}

function normalizePerformancePieces(pieces) {
    return (pieces || []).map((piece) => {
        if (typeof piece === 'string') {
            return { composer: '', title: piece };
        }
        return {
            composer: piece.composer || '',
            title: piece.title || piece.name || '',
            alias: piece.alias || piece.short_name || '',
            duration: piece.duration || '',
            is_encore: Boolean(piece.is_encore || piece.encore)
        };
    }).filter((piece) => piece.title);
}

function performancePieceDurationText(piece) {
    const value = String(piece?.duration || '').trim();
    return value ? `演奏時間: ${value}分` : '';
}

function performancePieceLabel(piece) {
    if (typeof piece === 'string') return piece;
    // 曲名表示や保存フォルダ名は、登録済みの略称を優先して短く揃える。
    const label = piece.alias || piece.short_name || (piece.composer ? `${piece.composer}: ${piece.title}` : piece.title);
    return (piece.is_encore || piece.encore) ? `(${label})` : label;
}

function performancePieceFormalLabel(piece) {
    if (typeof piece === 'string') return piece;
    // 録音アップロードの選択肢では、略称ではなく登録された正式な曲名を見せる。
    const label = piece.composer ? `${piece.composer}: ${piece.title}` : piece.title;
    return (piece.is_encore || piece.encore) ? `(${label})` : label;
}

function performancePieceLookupLabels(piece) {
    // DB移行前の紹介/指示データは、曲名・略称・「作曲者: 曲名」のいずれかで保存されていることがある。
    if (typeof piece === 'string') return [piece].filter(Boolean);
    return [
        performancePieceLabel(piece),
        performancePieceFormalLabel(piece),
        piece.title,
        piece.alias,
        piece.short_name,
        piece.composer && piece.title ? `${piece.composer}: ${piece.title}` : ''
    ].map((value) => String(value || '').trim()).filter((value, index, array) => value && array.indexOf(value) === index);
}

function findPieceScopedItem(items, performanceId, piece) {
    const labels = performancePieceLookupLabels(piece);
    return (items || []).find((item) =>
        String(item.performance_id || '') === String(performanceId || '')
        && labels.includes(String(item.piece || item.title || '').trim())
    );
}

function pieceScopedRows(performances, scopedItems) {
    return (performances || []).map((perf) => {
        const normalizedPieces = normalizePerformancePieces(perf.pieces || []);
        const labels = new Set(normalizedPieces.flatMap(performancePieceLookupLabels));
        (scopedItems || []).forEach((item) => {
            if (String(item.performance_id || '') !== String(perf.id || '')) return;
            const itemPiece = String(item.piece || item.title || '').trim();
            if (!itemPiece || labels.has(itemPiece)) return;
            normalizedPieces.push({ composer: '', title: itemPiece, alias: '' });
            labels.add(itemPiece);
        });
        return {
            performanceId: String(perf.id || ''),
            title: String(perf.title || ''),
            date: String(perf.date || ''),
            pieces: normalizedPieces
        };
    });
}

function selectedUploadPerformance() {
    const value = $('uploadPerformance')?.value || '';
    if (!value) return null;
    return appState.performances.find((perf) => String(perf.id) === value) || null;
}

function uploadPieceOptions(performance) {
    if (!performance) return [];

    const options = normalizePerformancePieces(performance?.pieces || [])
        .map((piece) => ({
            value: performancePieceLabel(piece),
            label: performancePieceFormalLabel(piece)
        }))
        .filter((option) => option.value);
    options.push({
        value: WHOLE_PRACTICE_RECORDING_PIECE,
        label: WHOLE_PRACTICE_RECORDING_PIECE
    });

    const seen = new Set();
    return options.filter((option) => {
        if (seen.has(option.value)) return false;
        seen.add(option.value);
        return true;
    });
}

function renderUploadPerformanceOptions() {
    const select = $('uploadPerformance');
    if (!select) return;
    const current = select.value;
    select.innerHTML = '<option value="">演奏会を選択</option>' + appState.performances.map((perf) =>
        `<option value="${escapeHtml(String(perf.id))}">${escapeHtml(perf.title || '')}</option>`
    ).join('');
    if ([...select.options].some((option) => option.value === current)) {
        select.value = current;
    }
    renderUploadPieceOptions();
}

function renderUploadPieceOptions() {
    const select = $('uploadPiece');
    if (!select) return;
    const current = select.value;
    const pieces = uploadPieceOptions(selectedUploadPerformance());
    select.innerHTML = pieces.length
        ? '<option value="">曲を選択</option>' + pieces.map((piece) => `<option value="${escapeHtml(piece.value)}">${escapeHtml(piece.label)}</option>`).join('')
        : '<option value="">演奏会に登録済みの曲がありません</option>';
    if (pieces.some((piece) => piece.value === current)) {
        select.value = current;
    }
    updateSavePath();
}

function renderPerformancePieceList() {
    const list = $('perfPieceList');
    list.innerHTML = emptyText(appState.performancePieces, '曲目はまだありません');
    appState.performancePieces.forEach((piece, index) => {
        const item = document.createElement('li');
        item.className = 'list-group-item d-flex flex-wrap justify-content-between align-items-center gap-3';
        const formalLabel = performancePieceFormalLabel(piece);
        const alias = piece.alias || piece.short_name || '';
        const aliasHtml = alias ? `<div class="small text-muted">略称: ${escapeHtml(alias)}</div>` : '';
        const durationText = performancePieceDurationText(piece);
        const durationHtml = durationText ? `<div class="small text-muted">${escapeHtml(durationText)}</div>` : '';
        item.innerHTML = `
            <span>
                <span>${escapeHtml(formalLabel)}</span>
                ${aliasHtml}
                ${durationHtml}
            </span>
            <span class="d-flex flex-wrap gap-2">
                <button class="btn btn-sm btn-outline-secondary move-piece-up-btn" type="button" ${index === 0 ? 'disabled' : ''}>↑</button>
                <button class="btn btn-sm btn-outline-secondary move-piece-down-btn" type="button" ${index === appState.performancePieces.length - 1 ? 'disabled' : ''}>↓</button>
                <button class="btn btn-sm btn-outline-primary edit-piece-btn" type="button">編集</button>
                <button class="btn btn-sm btn-outline-danger delete-piece-btn" type="button">削除</button>
            </span>
        `;
        item.querySelector('.move-piece-up-btn').addEventListener('click', () => movePerformancePiece(index, -1));
        item.querySelector('.move-piece-down-btn').addEventListener('click', () => movePerformancePiece(index, 1));
        item.querySelector('.edit-piece-btn').addEventListener('click', () => editPerformancePiece(index));
        item.querySelector('.delete-piece-btn').addEventListener('click', () => removePerformancePiece(index));
        list.appendChild(item);
    });
}


function renderPerformances() {
    const list = $('perfListItems');
    list.innerHTML = emptyText(appState.performances, '演奏会情報はまだありません');
    appState.performances.forEach((perf) => {
        const pieces = normalizePerformancePieces(perf.pieces || []).map(performancePieceFormalLabel).filter(Boolean);
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'list-group-item list-group-item-action';
        item.innerHTML = `
            <strong>${escapeHtml(perf.title)}</strong>
            <div class="small text-muted">${escapeHtml(formatDateWithWeekday(perf.date))} / ${escapeHtml(perf.venue || '会場未定')} / 指揮: ${escapeHtml(perf.conductor || '未定')}</div>
            ${pieces.length ? `<div class="small mt-1">${pieces.map((piece) => `<div>${escapeHtml(piece)}</div>`).join('')}</div>` : ''}
        `;
        item.addEventListener('click', () => selectPerformance(perf.id));
        list.appendChild(item);
    });
    if (!appState.suppressDerivedRender) {
        renderMemberPerformances();
        renderMemberSchedules();
        renderSchedulePerformanceOptions();
        updateSchedulePieceOptions();
        renderPortalHome();
    }
}

