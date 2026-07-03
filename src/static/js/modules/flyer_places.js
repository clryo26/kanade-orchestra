// Flyer place management module.

var appState = window.portalRuntimeContext.appState;
var $ = window.portalRuntimeContext.getById;

function flyerPlacesCollection() {
    return Array.isArray(appState.flyerPlaces) ? appState.flyerPlaces : [];
}

function normalizeFlyerPlaceName(value) {
    return String(value || '').trim().replace(/\s+/g, '').toLowerCase();
}

function flyerPlaceRegisteredByLabel(record) {
    return record.registered_by || record.created_by || '未設定';
}

function flyerPlaceDuplicateCountMap(records) {
    const counts = new Map();
    records.forEach((record) => {
        const key = normalizeFlyerPlaceName(record.place_name || '');
        if (key) counts.set(key, (counts.get(key) || 0) + 1);
    });
    return counts;
}

function flyerPlaceStatusClass(record, duplicateCountMap) {
    const key = normalizeFlyerPlaceName(record.place_name || '');
    return (duplicateCountMap.get(key) || 0) > 1 ? 'flyer-place-duplicate' : '';
}

function renderFlyerPlacesAdmin() {
    const list = $('flyerPlaceList');
    if (!list) return;

    if (!appState.flyerPlaceFormInitialized) {
        clearFlyerPlaceForm();
        appState.flyerPlaceFormInitialized = true;
    }

    const saveButton = $('saveFlyerPlaceBtn');
    if (saveButton) saveButton.onclick = (event) => withButtonStatus(event.currentTarget, '保存中...', saveFlyerPlace);
    const clearButton = $('clearFlyerPlaceBtn');
    if (clearButton) clearButton.onclick = clearFlyerPlaceForm;

    const records = flyerPlacesCollection()
        .slice()
        .sort((a, b) => {
            return String(a.place_name || '').localeCompare(String(b.place_name || ''))
                || String(a.area || '').localeCompare(String(b.area || ''))
                || String(a.registered_at || '').localeCompare(String(b.registered_at || ''));
        });

    if (!records.length) {
        list.innerHTML = '<p class="text-muted mb-0">チラシ配布マスタはまだ登録されていません</p>';
        return;
    }

    const duplicateCountMap = flyerPlaceDuplicateCountMap(records);
    list.innerHTML = `
        <div class="table-responsive">
            <table class="table table-sm table-striped align-middle mb-0">
                <thead>
                    <tr>
                        <th style="width: 24%;">施設名・店舗名</th>
                        <th style="width: 18%;">エリア・住所</th>
                        <th>備考</th>
                        <th style="width: 150px;">操作</th>
                    </tr>
                </thead>
                <tbody>
                    ${records.map((record) => {
                        const duplicateClass = flyerPlaceStatusClass(record, duplicateCountMap);
                        const duplicateBadge = duplicateClass ? '<span class="badge text-bg-warning flyer-place-duplicate-badge ms-2">重複の可能性あり</span>' : '';
                        return `
                            <tr class="${duplicateClass}">
                                <td>
                                    <div class="fw-semibold">${escapeHtml(record.place_name || '未設定')}${duplicateBadge}</div>
                                </td>
                                <td>${escapeHtml(record.area || '未設定')}</td>
                                <td class="small">${escapeHtml(record.note || '') || '<span class="text-muted">-</span>'}</td>
                                <td>
                                    <div class="d-flex flex-wrap gap-2">
                                        <button class="btn btn-sm btn-outline-primary flyer-place-edit-btn" type="button" data-flyer-place-id="${escapeHtml(String(record.id || ''))}">編集</button>
                                        <button class="btn btn-sm btn-outline-danger flyer-place-delete-btn" type="button" data-flyer-place-id="${escapeHtml(String(record.id || ''))}">削除</button>
                                    </div>
                                </td>
                            </tr>
                        `;
                    }).join('')}
                </tbody>
            </table>
        </div>
    `;

    list.querySelectorAll('.flyer-place-edit-btn').forEach((button) => {
        button.addEventListener('click', () => selectFlyerPlaceRecord(button.dataset.flyerPlaceId || ''));
    });
    list.querySelectorAll('.flyer-place-delete-btn').forEach((button) => {
        button.addEventListener('click', async () => {
            const id = button.dataset.flyerPlaceId || '';
            if (!id) return;
            if (!confirmDelete()) return;
            await request(`/api/extra/flyer_places/${encodeURIComponent(id)}`, { method: 'DELETE' });
            await loadExtraData();
            clearFlyerPlaceForm();
            showAlert('チラシ設置場所を削除しました', 'success');
        });
    });
}

function selectFlyerPlaceRecord(id) {
    const record = flyerPlacesCollection().find((item) => String(item.id || '') === String(id || ''));
    if (!record) return;
    $('flyerPlaceId').value = String(record.id || '');
    $('flyerPlaceName').value = record.place_name || '';
    $('flyerPlaceArea').value = record.area || '';
    $('flyerPlaceNote').value = record.note || '';
}

function clearFlyerPlaceForm() {
    if (!$('flyerPlaceId')) return;
    $('flyerPlaceId').value = '';
    $('flyerPlaceName').value = '';
    $('flyerPlaceArea').value = '';
    $('flyerPlaceNote').value = '';
}

async function saveFlyerPlace() {
    const placeName = $('flyerPlaceName')?.value.trim() || '';
    if (!placeName) {
        showAlert('施設名・店舗名を入力してください', 'warning');
        return;
    }
    const payload = {
        performance_id: '',
        performance_title: '',
        place_name: placeName,
        area: $('flyerPlaceArea')?.value.trim() || '',
        note: $('flyerPlaceNote')?.value.trim() || '',
    };
    const id = $('flyerPlaceId')?.value || '';
    const saved = id
        ? await request(`/api/extra/flyer_places/${encodeURIComponent(id)}`, jsonOptions('PUT', payload))
        : await saveExtra('flyer_places', payload);
    await loadExtraData();
    selectFlyerPlaceRecord(saved?.id || id || '');
    showAlert('チラシ設置場所を保存しました', 'success');
}
