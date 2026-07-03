// Flyer distribution planning module.

var appState = window.portalRuntimeContext.appState;
var $ = window.portalRuntimeContext.getById;

function flyerDistributionCollection() {
    return Array.isArray(appState.flyerDistributions) ? appState.flyerDistributions : [];
}

function flyerDistributionPlaceCollection() {
    return Array.isArray(appState.flyerPlaces) ? appState.flyerPlaces : [];
}

function flyerDistributionMemberCollection() {
    return Array.isArray(appState.members) ? appState.members : [];
}

function flyerDistributionPerformanceCollection() {
    return Array.isArray(appState.performances) ? appState.performances : [];
}

function flyerDistributionPerformanceLabel(performance) {
    return `${performance.title || '未設定'}${performance.date ? ` (${formatDateWithWeekday(performance.date, '')})` : ''}`;
}

function flyerDistributionMemberLabel(member) {
    if (typeof memberDisplayName === 'function') {
        const label = memberDisplayName(member);
        return label || member?.name || '';
    }
    return member?.name || '';
}

function flyerDistributionSortedMembers() {
    if (typeof sortedMembersByPartAndKana === 'function') {
        return sortedMembersByPartAndKana(flyerDistributionMemberCollection());
    }
    return flyerDistributionMemberCollection().slice().sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'ja'));
}

function flyerDistributionSelectedPerformanceId() {
    const hiddenValue = $('flyerDistributionSelectedPerformanceId')?.value || '';
    const stateValue = appState.flyerDistributionSelectedPerformanceId || '';
    return hiddenValue || stateValue || '';
}

function flyerDistributionPerformanceOptionsHtml(selected = '') {
    const current = String(selected || '');
    const performances = flyerDistributionPerformanceCollection().slice().sort((a, b) =>
        String(a.date || '').localeCompare(String(b.date || '')) || String(a.title || '').localeCompare(String(b.title || ''))
    );
    if (!performances.length) {
        return '<option value="">演奏会がまだありません</option>';
    }
    const options = performances.map((performance) => {
        const value = String(performance.id || '');
        const label = flyerDistributionPerformanceLabel(performance);
        return `<option value="${escapeHtml(value)}" ${value === current ? 'selected' : ''}>${escapeHtml(label)}</option>`;
    }).join('');
    return `<option value="">演奏会を選択</option>${options}`;
}

function flyerDistributionMemberOptionsHtml(selected = '') {
    const members = flyerDistributionSortedMembers();
    if (!members.length) {
        return '<option value="">団員がまだ登録されていません</option>';
    }
    return ['<option value="">選択してください</option>'].concat(members.map((member) => {
        const value = String(member.id || '');
        const part = member.part ? ` (${member.part})` : '';
        return `<option value="${escapeHtml(value)}" ${value === String(selected || '') ? 'selected' : ''}>${escapeHtml((flyerDistributionMemberLabel(member) || '未設定') + part)}</option>`;
    })).join('');
}

function flyerDistributionRecordMap(performanceId) {
    const map = new Map();
    flyerDistributionCollection().forEach((record) => {
        if (String(record.performance_id || '') !== String(performanceId || '')) return;
        map.set(String(record.flyer_place_id || ''), record);
    });
    return map;
}

function flyerDistributionPlaceLabel(place) {
    return place?.place_name || place?.name || '未設定';
}

function flyerDistributionResolvePerformanceId() {
    const select = $('flyerDistributionPerformanceId');
    const current = String(select?.value || flyerDistributionSelectedPerformanceId() || '');
    if (current) return current;
    const first = flyerDistributionPerformanceCollection()[0];
    return String(first?.id || '');
}

function renderFlyerDistributionAdmin() {
    const performanceSelect = $('flyerDistributionPerformanceId');
    const list = $('flyerDistributionList');
    if (!performanceSelect || !list) return;

    const selectedPerformanceId = flyerDistributionResolvePerformanceId();
    performanceSelect.innerHTML = flyerDistributionPerformanceOptionsHtml(selectedPerformanceId);
    if ([...performanceSelect.options].some((option) => option.value === selectedPerformanceId)) {
        performanceSelect.value = selectedPerformanceId;
    }
    $('flyerDistributionSelectedPerformanceId').value = performanceSelect.value || '';
    appState.flyerDistributionSelectedPerformanceId = performanceSelect.value || '';

    performanceSelect.onchange = () => {
        appState.flyerDistributionSelectedPerformanceId = performanceSelect.value || '';
        $('flyerDistributionSelectedPerformanceId').value = performanceSelect.value || '';
        renderFlyerDistributionAdmin();
    };

    if (!flyerDistributionPerformanceCollection().some((item) => String(item.id || '') === String(performanceSelect.value || ''))) {
        list.innerHTML = '<p class="text-muted mb-0">演奏会を選択すると、施設ごとの配布予定を編集できます。</p>';
        return;
    }

    const places = flyerDistributionPlaceCollection().slice().sort((a, b) =>
        String(a.place_name || '').localeCompare(String(b.place_name || '')) || String(a.area || '').localeCompare(String(b.area || ''))
    );
    if (!places.length) {
        list.innerHTML = '<p class="text-muted mb-0">先にチラシ配布マスタを登録してください。</p>';
        return;
    }

    const records = flyerDistributionRecordMap(performanceSelect.value || '');
    list.innerHTML = `
        <div class="table-responsive">
            <table class="table table-sm table-striped align-middle mb-0">
                <thead>
                    <tr>
                        <th style="width: 18%;">施設名・店舗名</th>
                        <th style="width: 16%;">エリア・住所</th>
                        <th style="width: 18%;">備考</th>
                        <th style="width: 14%;">配布予定者</th>
                        <th style="width: 12%;">実施予定日</th>
                        <th style="width: 14%;">実施者</th>
                        <th style="width: 12%;">実施日</th>
                        <th style="width: 110px;">操作</th>
                    </tr>
                </thead>
                <tbody>
                    ${places.map((place) => {
                        const placeId = String(place.id || '');
                        const record = records.get(placeId) || null;
                        const rowClass = record ? 'table-success-subtle' : '';
                        return `
                            <tr class="${rowClass}" data-flyer-place-id="${escapeHtml(placeId)}" data-flyer-record-id="${escapeHtml(String(record?.id || ''))}">
                                <td>
                                    <div class="fw-semibold">${escapeHtml(flyerDistributionPlaceLabel(place))}</div>
                                </td>
                                <td class="small">${escapeHtml(place.area || '未設定')}</td>
                                <td class="small">${escapeHtml(place.note || '') || '<span class="text-muted">-</span>'}</td>
                                <td>
                                    <select class="form-select form-select-sm" data-field="planned-member-id">
                                        ${flyerDistributionMemberOptionsHtml(record?.planned_member_id || '')}
                                    </select>
                                </td>
                                <td>
                                    <input class="form-control form-control-sm" data-field="planned-date" type="date" value="${escapeHtml(record?.planned_date || '')}">
                                </td>
                                <td>
                                    <select class="form-select form-select-sm" data-field="executed-member-id">
                                        ${flyerDistributionMemberOptionsHtml(record?.executed_member_id || '')}
                                    </select>
                                </td>
                                <td>
                                    <input class="form-control form-control-sm" data-field="executed-date" type="date" value="${escapeHtml(record?.executed_date || '')}">
                                </td>
                                <td>
                                    <div class="d-flex flex-wrap gap-2">
                                        <button class="btn btn-sm btn-outline-primary flyer-distribution-save-btn" type="button">保存</button>
                                        <button class="btn btn-sm btn-outline-danger flyer-distribution-delete-btn" type="button">削除</button>
                                    </div>
                                </td>
                            </tr>
                        `;
                    }).join('')}
                </tbody>
            </table>
        </div>
    `;

    list.querySelectorAll('.flyer-distribution-save-btn').forEach((button) => {
        button.addEventListener('click', async (event) => {
            const row = event.currentTarget.closest('tr');
            if (!row) return;
            await saveFlyerDistributionRow(row);
        });
    });
    list.querySelectorAll('.flyer-distribution-delete-btn').forEach((button) => {
        button.addEventListener('click', async (event) => {
            const row = event.currentTarget.closest('tr');
            if (!row) return;
            await deleteFlyerDistributionRow(row);
        });
    });
}

async function saveFlyerDistributionRow(row) {
    const performanceId = flyerDistributionSelectedPerformanceId();
    const placeId = String(row?.dataset?.flyerPlaceId || '');
    const place = flyerDistributionPlaceCollection().find((item) => String(item.id || '') === placeId);
    if (!performanceId) {
        showAlert('演奏会を選択してください', 'warning');
        return;
    }
    if (!place) {
        showAlert('施設情報が見つかりません', 'warning');
        return;
    }

    const recordId = String(row?.dataset?.flyerRecordId || '');
    const plannedMemberId = String(row.querySelector('[data-field="planned-member-id"]')?.value || '');
    const executedMemberId = String(row.querySelector('[data-field="executed-member-id"]')?.value || '');
    const plannedMember = flyerDistributionMemberCollection().find((member) => String(member.id || '') === plannedMemberId);
    const executedMember = flyerDistributionMemberCollection().find((member) => String(member.id || '') === executedMemberId);
    const performance = flyerDistributionPerformanceCollection().find((item) => String(item.id || '') === String(performanceId || ''));

    const payload = {
        performance_id: performanceId,
        performance_title: performance?.title || '',
        flyer_place_id: placeId,
        flyer_place_name: flyerDistributionPlaceLabel(place),
        flyer_place_area: place.area || '',
        flyer_place_note: place.note || '',
        planned_member_id: plannedMemberId,
        planned_member_name: plannedMember ? flyerDistributionMemberLabel(plannedMember) : '',
        planned_date: row.querySelector('[data-field="planned-date"]')?.value || '',
        executed_member_id: executedMemberId,
        executed_member_name: executedMember ? flyerDistributionMemberLabel(executedMember) : '',
        executed_date: row.querySelector('[data-field="executed-date"]')?.value || '',
    };

    if (recordId) {
        await request(`/api/extra/flyer_distributions/${encodeURIComponent(recordId)}`, jsonOptions('PUT', payload));
    } else {
        await saveExtra('flyer_distributions', payload);
    }
    await loadExtraData();
    showAlert('チラシ配布予定を保存しました', 'success');
}

async function deleteFlyerDistributionRow(row) {
    const recordId = String(row?.dataset?.flyerRecordId || '');
    if (!recordId) {
        row.querySelector('[data-field="planned-member-id"]').value = '';
        row.querySelector('[data-field="planned-date"]').value = '';
        row.querySelector('[data-field="executed-member-id"]').value = '';
        row.querySelector('[data-field="executed-date"]').value = '';
        showAlert('保存済みの配布予定はまだありません', 'warning');
        return;
    }
    if (!confirmDelete()) return;
    await request(`/api/extra/flyer_distributions/${encodeURIComponent(recordId)}`, { method: 'DELETE' });
    await loadExtraData();
    showAlert('チラシ配布予定を削除しました', 'success');
}
