// Frontend split: extracted from main.js.
// Loaded after main.js; functions intentionally remain global for legacy handlers.

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

async function savePracticeInstructionAdmin() {
    const payload = {
        performance_id: $('practiceInstructionPerformance')?.value || '',
        piece: $('practiceInstructionPiece')?.value.trim() || '',
        practice_notes: $('practiceInstructionNotes')?.value.trim() || '',
        // 旧項目は常に空文字で保存してデータを単一項目へ統一する。
        performance_instruction: ''
    };
    if (!payload.performance_id || !payload.piece) {
        showAlert('演奏会と曲名を入力してください', 'warning');
        return;
    }
    if (!payload.practice_notes) {
        showAlert('練習時の指摘内容を入力してください', 'warning');
        return;
    }

    const id = $('practiceInstructionId')?.value || '';
    const duplicate = appState.practiceInstructions.find((item) => String(item.performance_id || '') === String(payload.performance_id) && String(item.piece || '') === payload.piece);
    const saveId = id || String(duplicate?.id || '');
    if (saveId) {
        await request(`/api/extra/practice_instructions/${encodeURIComponent(saveId)}`, jsonOptions('PUT', payload));
    } else {
        await saveExtra('practice_instructions', payload);
    }
    clearPracticeInstructionForm();
    await loadExtraData();
    showAlert('練習指示を保存しました', 'success');
}

async function deletePracticeInstructionAdmin() {
    const id = $('practiceInstructionId')?.value || '';
    if (!id) {
        showAlert('削除する練習指示を選択してください', 'warning');
        return;
    }
    if (!confirmDelete()) return;
    await request(`/api/extra/practice_instructions/${encodeURIComponent(id)}`, { method: 'DELETE' });
    clearPracticeInstructionForm();
    await loadExtraData();
    showAlert('練習指示を削除しました', 'success');
}

// 団員向け楽譜ビュー。
// 演奏会 -> 曲 -> ファイルの順で段階的に絞り込めるようにし、
// 大量の楽譜があっても目的のファイルへ辿り着きやすくしている。
// renderSheetLibraryView moved to feature module.

// showSheetViewer moved to feature module.

// clearSheetViewer moved to feature module.

async function loadPdfJs() {
    if (window.pdfjsLib) return window.pdfjsLib;
    await new Promise((resolve, reject) => {
        const existing = document.querySelector('script[data-pdfjs]');
        if (existing) {
            existing.addEventListener('load', resolve, { once: true });
            existing.addEventListener('error', reject, { once: true });
            return;
        }
        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
        script.dataset.pdfjs = 'true';
        script.addEventListener('load', resolve, { once: true });
        script.addEventListener('error', reject, { once: true });
        document.head.appendChild(script);
    });
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    return window.pdfjsLib;
}

async function renderPdfViewer(url, scale = null) {
    const pages = $('sheetViewerPages');
    const status = $('sheetViewerStatus');
    if (!pages || !status) return;
    appState.sheetPdfUrl = url;
    appState.sheetPdfRendering = true;
    pages.innerHTML = '';
    status.textContent = '楽譜を読み込み中...';
    try {
        const pdfjsLib = await loadPdfJs();
        const data = await fetch(url, { cache: 'no-store' }).then((response) => {
            if (!response.ok) throw new Error(`PDFを取得できませんでした (${response.status})`);
            return response.arrayBuffer();
        });
        if (appState.sheetPdfUrl !== url) return;
        const pdf = await pdfjsLib.getDocument({ data }).promise;
        const firstPage = await pdf.getPage(1);
        appState.sheetPdfScale = scale || sheetViewerFitScale(firstPage);
        status.textContent = `${pdf.numPages}ページを表示中`;
        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
            if (appState.sheetPdfUrl !== url) return;
            const page = pageNumber === 1 ? firstPage : await pdf.getPage(pageNumber);
            await renderPdfPage(page, pageNumber, appState.sheetPdfScale, pages);
        }
        status.textContent = `${pdf.numPages}ページ`;
    } catch (error) {
        status.textContent = 'PDFを表示できませんでした';
        showAlert(error.message || 'PDFを表示できませんでした', 'danger');
    } finally {
        appState.sheetPdfRendering = false;
    }
}

// sheetViewerFitScale moved to feature module.

async function renderPdfPage(page, pageNumber, scale, container) {
    const viewport = page.getViewport({ scale });
    const wrapper = document.createElement('section');
    wrapper.className = 'sheet-viewer-page';
    wrapper.innerHTML = `<div class="sheet-viewer-page-label">${pageNumber}</div>`;
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    const outputScale = window.devicePixelRatio || 1;
    canvas.width = Math.floor(viewport.width * outputScale);
    canvas.height = Math.floor(viewport.height * outputScale);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    wrapper.appendChild(canvas);
    container.appendChild(wrapper);
    await page.render({
        canvasContext: context,
        viewport,
        transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null
    }).promise;
}

// zoomSheetViewer moved to feature module.

// fitSheetViewerWidth moved to feature module.

// sheetPieceOptions moved to feature module.

// sheetFilterPerformanceOptions moved to feature module.

// sheetFilterPieceOptions moved to feature module.

// sheetFilterPartOptions moved to feature module.

// sheetPartOptions moved to feature module.

function partOptionHtml(selected = '') {
    return ['<option value="">選択してください</option>']
        .concat(sheetPartOptions().map((part) => `<option value="${escapeHtml(part)}" ${part === selected ? 'selected' : ''}>${escapeHtml(part)}</option>`))
        .join('');
}

// sheetZipUrl moved to feature module.

function renderCastingAdmin() {
    const performanceSelect = $('castingPerformanceSelect');
    if (!performanceSelect) return;

    const previousValue = performanceSelect.value;
    performanceSelect.innerHTML = appState.performances.map((perf) => 
        `<option value="${escapeHtml(String(perf.id || ''))}">${escapeHtml(perf.title || '未設定')}</option>`
    ).join('');

    const hasPrevious = appState.performances.some((perf) => String(perf.id || '') === String(previousValue));
    if (hasPrevious) {
        performanceSelect.value = previousValue;
    }

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
    
    // 保存済みデータを直接参照し続けると編集中に一覧側へ影響するため、
    // フォーム編集用には浅いコピーで別配列を持つ。
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

// renderCastingMembersList moved to feature module.

function renderCastingExtrasList() {
    const list = $('castingExtrasList');
    if (!list) return;
    
    list.innerHTML = appState.castingEditingExtras.map((extra, index) => {
        return `
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
        `;
    }).join('');
    
    list.querySelectorAll('[data-name-index]').forEach((input) => {
        input.addEventListener('change', (e) => {
            const index = Number(e.target.dataset.nameIndex || 0);
            if (appState.castingEditingExtras[index]) {
                appState.castingEditingExtras[index].name = e.target.value.trim();
            }
        });
    });
    
    list.querySelectorAll('[data-furigana-index]').forEach((input) => {
        input.addEventListener('change', (e) => {
            const index = Number(e.target.dataset.furiganaIndex || 0);
            if (appState.castingEditingExtras[index]) {
                appState.castingEditingExtras[index].furigana = e.target.value.trim();
            }
        });
    });
    
    list.querySelectorAll('[data-extra-part-index]').forEach((input) => {
        input.addEventListener('change', (e) => {
            const index = Number(e.target.dataset.extraPartIndex || 0);
            if (appState.castingEditingExtras[index]) {
                appState.castingEditingExtras[index].part = e.target.value.trim();
            }
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

function bindCastingAdminEvents() {
    const addExtraBtn = $('castingAddExtraBtn');
    const saveBtn = $('castingSaveBtn');
    const deleteBtn = $('castingDeleteBtn');
    const clearBtn = $('castingClearBtn');
    
    if (addExtraBtn) {
        addExtraBtn.addEventListener('click', () => {
            appState.castingEditingExtras.push({ name: '', furigana: '', part: '' });
            renderCastingExtrasList();
        });
    }
    
    if (saveBtn) {
        saveBtn.addEventListener('click', () => saveCasting());
    }
    
    if (deleteBtn) {
        deleteBtn.addEventListener('click', () => deleteCasting());
    }
    
    if (clearBtn) {
        clearBtn.addEventListener('click', () => clearCastingForm());
    }
}

async function saveCasting() {
    const perfId = Number($('castingPerformanceSelect')?.value || 0);
    if (!perfId) {
        showAlert('演奏会を選択してください', 'warning');
        return;
    }
    
    const piece = $('castingPieceInput')?.value.trim() || '';
    const members = appState.castingEditingMembers.filter((m) => m.member_id);
    const extras = appState.castingEditingExtras.filter((e) => e.name);
    
    if (!members.length && !extras.length) {
        showAlert('団員またはエキストラを追加してください', 'warning');
        return;
    }
    
    const payload = {
        performance_id: perfId,
        piece,
        members,
        extras
    };
    
    try {
        setOperationStatus('castingOperationStatus', '保存中...');
        if (appState.castingEditingId) {
            await request(`/api/extra/castings/${appState.castingEditingId}`, jsonOptions('PUT', payload));
        } else {
            await request('/api/extra/castings', jsonOptions('POST', payload));
        }
        await loadExtraData();
        renderCastingAdmin();
        showAlert('乗り番を保存しました', 'success');
        setOperationStatus('castingOperationStatus', null);
    } catch (error) {
        setOperationStatus('castingOperationStatus', '保存に失敗しました', 'danger');
        console.error('Save casting failed', error);
    }
}

async function deleteCasting() {
    if (!appState.castingEditingId) {
        showAlert('削除対象が選択されていません', 'warning');
        return;
    }
    if (!confirmDelete()) return;
    
    try {
        setOperationStatus('castingOperationStatus', '削除中...');
        await request(`/api/extra/castings/${appState.castingEditingId}`, jsonOptions('DELETE'));
        await loadExtraData();
        renderCastingAdmin();
        clearCastingForm();
        showAlert('乗り番を削除しました', 'success');
        setOperationStatus('castingOperationStatus', null);
    } catch (error) {
        setOperationStatus('castingOperationStatus', '削除に失敗しました', 'danger');
        console.error('Delete casting failed', error);
    }
}

// 支払管理画面。
// 団費と演奏会費の両方を 1 レコードに集約し、団員単位で入力・参照できる形にしている。
// function renderPaymentAdmin() moved to modules/payments.js.

function renderCastingView() {
    const c = $('memberCastingInfo'); if (!c) return;
    c.innerHTML = appState.performances.map((perf) => {
        const rows = appState.castings.filter((x) => String(x.performance_id || '') === String(perf.id));
        const castingContent = rows.length ? rows.map((r) => {
            // members配列をパートごとにグルーピング（part設定順でソート）
            const partMap = new Map();
            (r.members || []).forEach((m) => {
                const member = appState.members.find((item) => item.id === m.member_id);
                const name = member ? memberDisplayName(member) : `団員ID:${m.member_id}`;
                const part = m.part || member?.part || '（パート未設定）';
                if (!partMap.has(part)) partMap.set(part, []);
                partMap.get(part).push(name);
            });
            // エキストラはパートごとにグルーピング
            (r.extras || []).forEach((e) => {
                const name = e.name || '';
                if (!name) return;
                const part = e.part || '（エキストラ）';
                if (!partMap.has(part)) partMap.set(part, []);
                partMap.get(part).push(name);
            });

            // パート設定の順序でソート
            const sortedParts = [...partMap.entries()].sort(
                ([a], [b]) => partSortIndex(a) - partSortIndex(b) ||
                    String(a).localeCompare(String(b), 'ja')
            );

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
