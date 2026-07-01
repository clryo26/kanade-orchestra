// Practice/casting render functions split from modules/practice_casting.js.
// Keep global names for compatibility with legacy non-module loading.

var appState = window.portalRuntimeContext.appState;
var $ = window.portalRuntimeContext.getById;

function renderPracticeInstructionAdmin() {
    const perfSelect = $('practiceInstructionPerformance');
    const list = $('practiceInstructionAdminList');
    if (!perfSelect || !list) return;
    const selected = perfSelect.value;
    perfSelect.innerHTML = '<option value="">演奏会を選択</option>' + appState.performances.map((perf) => `<option value="${escapeHtml(String(perf.id))}">${escapeHtml(perf.title)}</option>`).join('');
    if ([...perfSelect.options].some((option) => option.value === selected)) perfSelect.value = selected;
    updatePracticeInstructionPieceOptions();
    list.innerHTML = appState.practiceInstructions.length ? `<div class="list-group">${appState.practiceInstructions.map((item) => {
        const perf = appState.performances.find((value) => String(value.id || '') === String(item.performance_id || ''));
        const practiceText = item.practice_notes ? `<div class="small multiline-text mt-1">指摘内容: ${escapeHtml(item.practice_notes)}</div>` : '';
        return `<button class="list-group-item list-group-item-action text-start practice-instruction-admin-item" type="button" data-practice-instruction-id="${escapeHtml(String(item.id || ''))}"><strong>${escapeHtml(item.piece || '')}</strong><div class="small text-muted">${escapeHtml(perf?.title || '演奏会未設定')}</div>${practiceText}</button>`;
    }).join('')}</div>` : '<p class="text-muted mb-0">練習指示はまだ登録されていません</p>';
    list.querySelectorAll('.practice-instruction-admin-item').forEach((button) => button.addEventListener('click', () => selectPracticeInstructionAdmin(button.dataset.practiceInstructionId || '')));
}

function updatePracticeInstructionPieceOptions() {
    const select = $('practiceInstructionPiece');
    if (!select) return;
    const current = select.value;
    const performanceId = $('practiceInstructionPerformance')?.value || '';
    const perf = appState.performances.find((item) => String(item.id || '') === String(performanceId));
    const pieces = perf ? normalizePerformancePieces(perf.pieces || []).map(performancePieceLabel).filter(Boolean) : [];
    select.innerHTML = '<option value="">曲を選択</option>' + pieces.map((piece) => `<option value="${escapeHtml(piece)}">${escapeHtml(piece)}</option>`).join('');
    if ([...select.options].some((option) => option.value === current)) select.value = current;
}

function selectPracticeInstructionAdmin(id) {
    const item = appState.practiceInstructions.find((instruction) => String(instruction.id || '') === String(id));
    if (!item) return;
    $('practiceInstructionId').value = item.id || '';
    $('practiceInstructionPerformance').value = String(item.performance_id || '');
    updatePracticeInstructionPieceOptions();
    $('practiceInstructionPiece').value = item.piece || '';
    $('practiceInstructionNotes').value = item.practice_notes || '';
}

function clearPracticeInstructionForm() {
    if ($('practiceInstructionId')) $('practiceInstructionId').value = '';
    if ($('practiceInstructionPerformance')) $('practiceInstructionPerformance').value = '';
    if ($('practiceInstructionPiece')) $('practiceInstructionPiece').value = '';
    if ($('practiceInstructionNotes')) $('practiceInstructionNotes').value = '';
    updatePracticeInstructionPieceOptions();
}

function renderCastingAdmin() {
    const performanceSelect = $('castingPerformanceSelect');
    if (!performanceSelect) return;
    const previousValue = performanceSelect.value;
    performanceSelect.innerHTML = appState.performances.map((perf) => `<option value="${escapeHtml(String(perf.id || ''))}">${escapeHtml(perf.title || '未設定')}</option>`).join('');
    const hasPrevious = appState.performances.some((perf) => String(perf.id || '') === String(previousValue));
    if (hasPrevious) performanceSelect.value = previousValue;
    performanceSelect.onchange = () => loadCastingById(Number(performanceSelect.value) || 0);
    if (!performanceSelect.value && appState.performances.length) {
        performanceSelect.value = String(appState.performances[0].id || '');
    }
    const editingCasting = appState.castings.find((c) => String(c.id || '') === String(appState.castingEditingId || ''));
    if (editingCasting) {
        loadCastingRecord(editingCasting);
        performanceSelect.value = String(editingCasting.performance_id || '');
    } else {
        loadCastingById(Number(performanceSelect.value) || 0);
    }
    renderCastingAdminList();
}

function renderCastingExtrasList() {
    const list = $('castingExtrasList');
    if (!list) return;
    list.innerHTML = appState.castingEditingExtras.map((extra, index) => `
            <div class="mb-3 p-2 border rounded">
                <div class="mb-2">
                    <label class="form-label form-label-sm mb-1">名前</label>
                    <input type="text" class="form-control form-control-sm" placeholder="名前" value="${escapeHtml(extra.name || '')}" data-name-index="${index}">
                </div>
                <div class="mb-2">
                    <label class="form-label form-label-sm mb-1">フリガナ</label>
                    <input type="text" class="form-control form-control-sm" placeholder="フリガナ" value="${escapeHtml(extra.furigana || '')}" data-furigana-index="${index}">
                </div>
                <div class="mb-2">
                    <label class="form-label form-label-sm mb-1">パート</label>
                    <input type="text" class="form-control form-control-sm" placeholder="パート" value="${escapeHtml(extra.part || '')}" data-extra-part-index="${index}">
                </div>
                <button class="btn btn-sm btn-outline-danger casting-extra-delete-btn" data-index="${index}" type="button">削除</button>
            </div>
        `).join('');
    list.querySelectorAll('[data-name-index]').forEach((input) => {
        input.addEventListener('change', (e) => {
            const index = Number(e.target.dataset.nameIndex || 0);
            if (appState.castingEditingExtras[index]) appState.castingEditingExtras[index].name = e.target.value.trim();
        });
    });
    list.querySelectorAll('[data-furigana-index]').forEach((input) => {
        input.addEventListener('change', (e) => {
            const index = Number(e.target.dataset.furiganaIndex || 0);
            if (appState.castingEditingExtras[index]) appState.castingEditingExtras[index].furigana = e.target.value.trim();
        });
    });
    list.querySelectorAll('[data-extra-part-index]').forEach((input) => {
        input.addEventListener('change', (e) => {
            const index = Number(e.target.dataset.extraPartIndex || 0);
            if (appState.castingEditingExtras[index]) appState.castingEditingExtras[index].part = e.target.value.trim();
        });
    });
    list.querySelectorAll('.casting-extra-delete-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            const index = Number(e.target.dataset.index || 0);
            appState.castingEditingExtras.splice(index, 1);
            renderCastingExtrasList();
        });
    });
}

function renderCastingAdminList() {
    const list = $('castingAdminList');
    if (!list) return;
    const grouped = groupBy(appState.castings, 'performance_id');
    const performanceMap = new Map(appState.performances.map((performance) => [String(performance.id || ''), performance]));
    const memberNameMap = new Map(appState.members.map((member) => [String(member.id || ''), memberDisplayName(member)]));
    list.innerHTML = Object.entries(grouped).map(([perfId, castings]) => {
        const perf = performanceMap.get(String(perfId));
        const perfTitle = perf?.title || '未設定の演奏会';
        return `
            <section class="mb-4">
                <h6>${escapeHtml(perfTitle)}</h6>
                ${castings.map((c) => {
                    const members = Array.isArray(c.members) ? c.members.map((m) => {
                        const memberName = memberNameMap.get(String(m.member_id || '')) || m.name || '';
                        return `${memberName}${m.part ? `（${m.part}）` : ''}`;
                    }).join(', ') : '';
                    const extras = Array.isArray(c.extras) ? c.extras.map((e) => `${e.name || ''}${e.part ? `（${e.part}）` : ''}`).join(', ') : '';
                    const allCasting = [members, extras].filter(Boolean).join(' / ') || '(出演者未設定)';
                    return `
                        <div class="p-2 border rounded mb-2">
                            <div class="d-flex justify-content-between align-items-start">
                                <div>
                                    <strong>${escapeHtml(c.piece || '全曲')}</strong><br>
                                    <small class="text-muted">${escapeHtml(allCasting)}</small>
                                </div>
                                <button class="btn btn-sm btn-outline-primary casting-edit-btn" data-casting-id="${escapeHtml(String(c.id || ''))}" type="button">編集</button>
                            </div>
                        </div>
                    `;
                }).join('')}
            </section>
        `;
    }).join('') || '<p class="text-muted">乗り番データがありません</p>';
    list.querySelectorAll('.casting-edit-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            const castingId = e.currentTarget.dataset.castingId || '';
            const casting = appState.castings.find((c) => String(c.id || '') === String(castingId));
            if (!casting) {
                showAlert('編集対象の乗り番データが見つかりません', 'warning');
                return;
            }
            if ($('castingPerformanceSelect')) $('castingPerformanceSelect').value = String(casting.performance_id || '');
            loadCastingRecord(casting);
            $('castingPieceInput')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
    });
}

function renderCastingView() {
    const c = $('memberCastingInfo'); if (!c) return;
    c.innerHTML = appState.performances.map((perf) => {
        const rows = appState.castings.filter((x) => String(x.performance_id || '') === String(perf.id));
        const castingContent = rows.length ? rows.map((r) => {
            const partMap = new Map();
            (r.members || []).forEach((m) => {
                const member = appState.members.find((item) => item.id === m.member_id);
                const name = member ? memberDisplayName(member) : `団員ID:${m.member_id}`;
                const part = m.part || member?.part || '（パート未設定）';
                if (!partMap.has(part)) partMap.set(part, []);
                partMap.get(part).push(name);
            });
            (r.extras || []).forEach((e) => {
                const name = e.name || '';
                if (!name) return;
                const part = e.part || '（エキストラ）';
                if (!partMap.has(part)) partMap.set(part, []);
                partMap.get(part).push(name);
            });
            const sortedParts = [...partMap.entries()].sort(([a], [b]) => partSortIndex(a) - partSortIndex(b) || String(a).localeCompare(String(b), 'ja'));
            if (!sortedParts.length) {
                return `<div class="info-block"><strong>${escapeHtml(r.piece || '全曲')}</strong><p class="text-muted mb-0">（未登録）</p></div>`;
            }
            const tableRows = sortedParts.map(([part, names]) => {
                const memberList = Array.isArray(names) && names.length
                    ? `<ul class="casting-member-vertical-list mb-0">${names.map((name) => `<li>${escapeHtml(name)}</li>`).join('')}</ul>`
                    : '<span class="text-muted">（未登録）</span>';
                return `<tr><td class="casting-part-cell text-nowrap text-muted small fw-bold">${escapeHtml(part)}</td><td class="casting-members-cell">${memberList}</td></tr>`;
            }).join('');
            return `<div class="info-block mb-3"><strong class="d-block mb-2">${escapeHtml(r.piece || '全曲')}</strong><table class="table table-sm table-borderless mb-0 casting-table"><tbody>${tableRows}</tbody></table></div>`;
        }).join('') : '<p class="text-muted">乗り番表は未登録です</p>';
        return `<section class="mb-3"><h5>${escapeHtml(perf.title)}</h5>${castingContent}</section>`;
    }).join('');
}