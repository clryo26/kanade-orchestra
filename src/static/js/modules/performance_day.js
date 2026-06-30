// Frontend split: extracted from main.js.
// Loaded after main.js; functions intentionally remain global for legacy handlers.

function sortedPerformanceDayInfoRows() {
    return [...(appState.performanceDayInfos || [])]
        .map((item) => {
            const performance = appState.performances.find((perf) => String(perf.id || '') === String(item.performance_id || ''));
            return {
                ...item,
                performance,
                performanceDate: String(performance?.date || ''),
                performanceTitle: String(performance?.title || item.performance_title || '未設定の演奏会')
            };
        })
        .sort((a, b) => String(b.performanceDate || '').localeCompare(String(a.performanceDate || '')) || String(a.performanceTitle).localeCompare(String(b.performanceTitle), 'ja'));
}

function inferDurationFromTimelineContent(content, performance) {
    const normalizedContent = String(content || '').trim();
    if (!normalizedContent) return '';
    const pieces = normalizePerformancePieces(performance?.pieces || []);
    for (const piece of pieces) {
        const duration = String(piece?.duration || '').trim();
        if (!duration) continue;
        const labels = performancePieceLookupLabels(piece);
        if (labels.some((label) => label && normalizedContent.includes(label))) {
            return duration;
        }
    }
    return '';
}

function parseTimelineTextRows(text, performance) {
    const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return lines.map((line, index) => {
        let startTime = '';
        let endTime = '';
        let durationMinutes = '';
        let content = line;

        let matched = line.match(/^(\d{1,2}:\d{2})\s*[\-~〜]\s*(\d{1,2}:\d{2})\s+(.+)$/);
        if (matched) {
            startTime = normalizeClockText(matched[1]);
            endTime = normalizeClockText(matched[2]);
            content = String(matched[3] || '').trim();
            if (startTime && endTime) {
                const [sh, sm] = startTime.split(':').map((part) => Number(part));
                const [eh, em] = endTime.split(':').map((part) => Number(part));
                let diff = (eh * 60 + em) - (sh * 60 + sm);
                if (diff < 0) diff += 24 * 60;
                durationMinutes = String(diff);
            }
        } else {
            matched = line.match(/^(\d{1,2}:\d{2})\s+(\d{1,3})\s*分?\s+(.+)$/);
            if (matched) {
                startTime = normalizeClockText(matched[1]);
                durationMinutes = String(matched[2] || '').trim();
                content = String(matched[3] || '').trim();
                endTime = addMinutesToClockText(startTime, durationMinutes);
            } else {
                matched = line.match(/^(\d{1,2}:\d{2})\s+(.+)$/);
                if (matched) {
                    startTime = normalizeClockText(matched[1]);
                    content = String(matched[2] || '').trim();
                    durationMinutes = inferDurationFromTimelineContent(content, performance);
                    endTime = durationMinutes ? addMinutesToClockText(startTime, durationMinutes) : '';
                }
            }
        }

        return {
            sort_order: index + 1,
            start_time: startTime,
            end_time: endTime,
            duration_minutes: durationMinutes,
            section: '',
            content,
            mc: '',
            reception: '',
            setting: '',
            note: '',
            source_line: line
        };
    }).filter((row) => row.content || row.start_time);
}

function normalizedPerformanceDayTimelineRows(item) {
    const timelineRows = Array.isArray(item?.timeline_rows) ? item.timeline_rows : [];
    if (timelineRows.length) {
        return timelineRows.map((row, index) => ({
            sort_order: Number(row?.sort_order || index + 1),
            start_time: normalizeClockText(row?.start_time || row?.start || ''),
            end_time: normalizeClockText(row?.end_time || row?.end || ''),
            duration_minutes: String(row?.duration_minutes || row?.duration || '').trim(),
            section: String(row?.section || row?.category || '').trim(),
            content: String(row?.content || row?.title || '').trim(),
            mc: String(row?.mc || '').trim(),
            reception: String(row?.reception || row?.desk || '').trim(),
            setting: String(row?.setting || '').trim(),
            note: String(row?.note || '').trim(),
            source_line: String(row?.source_line || '').trim()
        })).filter((row) => row.content || row.start_time || row.section);
    }
    const performance = appState.performances.find((perf) => String(perf.id || '') === String(item?.performance_id || ''));
    return parseTimelineTextRows(item?.timeline || item?.timetable || '', performance);
}

function timelineRowsToLegacyText(rows) {
    return (rows || []).map((row) => {
        const start = normalizeClockText(row?.start_time || '');
        const end = normalizeClockText(row?.end_time || '');
        const content = String(row?.content || '').trim();
        if (start && end && content) return `${start}-${end} ${content}`;
        if (start && content) return `${start} ${content}`;
        if (content) return content;
        return String(row?.source_line || '').trim();
    }).filter(Boolean).join('\n');
}

function parseAssignmentTextRows(text) {
    return String(text || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
            const parts = line.split(/[:：]/, 2);
            if (parts.length === 2) {
                return { role: String(parts[0] || '').trim(), members: String(parts[1] || '').trim() };
            }
            return { role: '', members: line };
        });
}

function normalizedPerformanceDayAssignments(item) {
    const rows = Array.isArray(item?.assignments_rows) ? item.assignments_rows : [];
    if (rows.length) {
        return rows.map((row) => ({
            role: String(row?.role || row?.duty || '').trim(),
            members: String(row?.members || row?.name || '').trim()
        })).filter((row) => row.role || row.members);
    }
    return parseAssignmentTextRows(item?.assignments || item?.duties || '');
}

function assignmentRowsToText(rows) {
    return (rows || [])
        .filter((row) => String(row?.role || '').trim() || String(row?.members || '').trim())
        .map((row) => {
            const role = String(row?.role || '').trim();
            const members = String(row?.members || '').trim();
            return role ? `${role}: ${members}`.trim() : members;
        })
        .filter(Boolean)
        .join('\n');
}

function emptyCostumeDetail() {
    return {
        male: { upper: '', lower: '', other: '' },
        female: { upper: '', lower: '', other: '' }
    };
}

function normalizedCostumeDetail(item) {
    const detail = item?.costume_detail && typeof item.costume_detail === 'object' ? item.costume_detail : {};
    const normalized = {
        male: {
            upper: String(detail?.male?.upper || detail?.male?.top || detail?.male_upper || '').trim(),
            lower: String(detail?.male?.lower || detail?.male?.bottom || detail?.male_lower || '').trim(),
            other: String(detail?.male?.other || detail?.male_other || '').trim()
        },
        female: {
            upper: String(detail?.female?.upper || detail?.female?.top || detail?.female_upper || '').trim(),
            lower: String(detail?.female?.lower || detail?.female?.bottom || detail?.female_lower || '').trim(),
            other: String(detail?.female?.other || detail?.female_other || '').trim()
        }
    };
    const hasStructured = Object.values(normalized.male).some(Boolean) || Object.values(normalized.female).some(Boolean);
    if (hasStructured) return normalized;

    const legacy = String(item?.costume || '').trim();
    if (!legacy) return emptyCostumeDetail();
    return {
        male: { upper: '', lower: '', other: legacy },
        female: { upper: '', lower: '', other: legacy }
    };
}

function costumeDetailFromForm() {
    return {
        male: {
            upper: String($('performanceDayCostumeMaleUpper')?.value || '').trim(),
            lower: String($('performanceDayCostumeMaleLower')?.value || '').trim(),
            other: String($('performanceDayCostumeMaleOther')?.value || '').trim()
        },
        female: {
            upper: String($('performanceDayCostumeFemaleUpper')?.value || '').trim(),
            lower: String($('performanceDayCostumeFemaleLower')?.value || '').trim(),
            other: String($('performanceDayCostumeFemaleOther')?.value || '').trim()
        }
    };
}

function hasCostumeDetail(detail) {
    return Object.values(detail?.male || {}).some(Boolean) || Object.values(detail?.female || {}).some(Boolean);
}

function costumeDetailToLegacyText(detail) {
    const formatOne = (label, value) => (value ? `${label}: ${value}` : '');
    const male = [
        formatOne('上', detail?.male?.upper),
        formatOne('下', detail?.male?.lower),
        formatOne('その他', detail?.male?.other)
    ].filter(Boolean).join(' / ');
    const female = [
        formatOne('上', detail?.female?.upper),
        formatOne('下', detail?.female?.lower),
        formatOne('その他', detail?.female?.other)
    ].filter(Boolean).join(' / ');
    return [male ? `男性(${male})` : '', female ? `女性(${female})` : ''].filter(Boolean).join('\n');
}

function costumeDetailHtml(detail) {
    const empty = !hasCostumeDetail(detail);
    if (empty) return '<div class="small text-muted mt-1">未登録</div>';
    return `
        <div class="table-responsive mt-1">
            <table class="table table-sm table-bordered mb-0">
                <thead class="table-light">
                    <tr><th style="width: 90px;">区分</th><th>上</th><th>下</th><th>その他</th></tr>
                </thead>
                <tbody>
                    <tr>
                        <td>男性</td>
                        <td>${escapeHtml(detail?.male?.upper || '')}</td>
                        <td>${escapeHtml(detail?.male?.lower || '')}</td>
                        <td>${escapeHtml(detail?.male?.other || '')}</td>
                    </tr>
                    <tr>
                        <td>女性</td>
                        <td>${escapeHtml(detail?.female?.upper || '')}</td>
                        <td>${escapeHtml(detail?.female?.lower || '')}</td>
                        <td>${escapeHtml(detail?.female?.other || '')}</td>
                    </tr>
                </tbody>
            </table>
        </div>
    `;
}

function setCostumeDetailForm(detail) {
    if ($('performanceDayCostumeMaleUpper')) $('performanceDayCostumeMaleUpper').value = detail?.male?.upper || '';
    if ($('performanceDayCostumeMaleLower')) $('performanceDayCostumeMaleLower').value = detail?.male?.lower || '';
    if ($('performanceDayCostumeMaleOther')) $('performanceDayCostumeMaleOther').value = detail?.male?.other || '';
    if ($('performanceDayCostumeFemaleUpper')) $('performanceDayCostumeFemaleUpper').value = detail?.female?.upper || '';
    if ($('performanceDayCostumeFemaleLower')) $('performanceDayCostumeFemaleLower').value = detail?.female?.lower || '';
    if ($('performanceDayCostumeFemaleOther')) $('performanceDayCostumeFemaleOther').value = detail?.female?.other || '';
}

function renderPerformanceDayAssignmentRows(rows = []) {
    const container = $('performanceDayAssignmentRows');
    if (!container) return;
    const normalizedRows = (rows || []).filter((row) => String(row?.role || '').trim() || String(row?.members || '').trim());
    const renderRows = normalizedRows.length ? normalizedRows : [{ role: '', members: '' }];
    container.innerHTML = renderRows.map((row, index) => `
        <tr>
            <td><input type="text" class="form-control form-control-sm performance-day-assignment-role" value="${escapeHtml(String(row.role || ''))}" placeholder="例: 受付"></td>
            <td><input type="text" class="form-control form-control-sm performance-day-assignment-members" value="${escapeHtml(String(row.members || ''))}" placeholder="例: 田中, 鈴木"></td>
            <td><button class="btn btn-sm btn-outline-danger performance-day-assignment-delete-btn" type="button" data-row-index="${index}">削除</button></td>
        </tr>
    `).join('');
    container.querySelectorAll('.performance-day-assignment-delete-btn').forEach((button) => {
        button.addEventListener('click', () => {
            const currentRows = collectPerformanceDayAssignmentRows();
            const targetIndex = Number(button.dataset.rowIndex || '-1');
            if (targetIndex >= 0) currentRows.splice(targetIndex, 1);
            renderPerformanceDayAssignmentRows(currentRows);
        });
    });
}

function addPerformanceDayAssignmentRow() {
    const currentRows = collectPerformanceDayAssignmentRows();
    currentRows.push({ role: '', members: '' });
    renderPerformanceDayAssignmentRows(currentRows);
}

function collectPerformanceDayAssignmentRows() {
    const container = $('performanceDayAssignmentRows');
    if (!container) return [];
    return [...container.querySelectorAll('tr')].map((row) => ({
        role: String(row.querySelector('.performance-day-assignment-role')?.value || '').trim(),
        members: String(row.querySelector('.performance-day-assignment-members')?.value || '').trim()
    })).filter((item) => item.role || item.members);
}

function assignmentRowsHtml(rows) {
    if (!rows.length) return '<div class="small text-muted mt-1">未登録</div>';
    return `<div class="table-responsive mt-1"><table class="table table-sm table-bordered mb-0"><thead class="table-light"><tr><th style="width:35%;">担当</th><th>氏名</th></tr></thead><tbody>${rows.map((row) => `<tr><td>${escapeHtml(row.role || '')}</td><td>${escapeHtml(row.members || '')}</td></tr>`).join('')}</tbody></table></div>`;
}

function timelineRowsHtml(rows) {
    if (!rows.length) return '<div class="small text-muted mt-1">未登録</div>';
    return `
        <div class="table-responsive mt-1">
            <table class="table table-sm table-bordered mb-0">
                <thead class="table-light"><tr><th style="width:20%;">時間</th><th>内容</th><th style="width:16%;">所要(分)</th></tr></thead>
                <tbody>
                    ${rows.map((row) => {
        const start = normalizeClockText(row?.start_time || '');
        const end = normalizeClockText(row?.end_time || '');
        const timeText = start && end ? `${start}-${end}` : (start || end || '');
        return `<tr><td>${escapeHtml(timeText)}</td><td>${escapeHtml(String(row?.content || '').trim())}</td><td>${escapeHtml(String(row?.duration_minutes || '').trim())}</td></tr>`;
    }).join('')}
                </tbody>
            </table>
        </div>
    `;
}

function renderPerformanceDayInfoView() {
    const container = $('memberPerformanceDayInfo');
    if (!container) return;
    const rows = sortedPerformanceDayInfoRows();
    if (!rows.length) {
        container.innerHTML = '<p class="text-muted mb-0">本番情報はまだ登録されていません</p>';
        return;
    }
    container.innerHTML = rows.map((item) => `
        <article class="info-block">
            <h5>${escapeHtml(item.performanceTitle)}</h5>
            <div class="small text-muted mb-2">${escapeHtml(formatDateWithWeekday(item.performanceDate || ''))}</div>
            <div class="mb-3">
                <strong>当日タイムテーブル</strong>
                ${timelineRowsHtml(normalizedPerformanceDayTimelineRows(item))}
            </div>
            <div class="mb-3">
                <strong>本番衣装</strong>
                ${costumeDetailHtml(normalizedCostumeDetail(item))}
            </div>
            <div>
                <strong>係り割</strong>
                ${assignmentRowsHtml(normalizedPerformanceDayAssignments(item))}
            </div>
        </article>
    `).join('');
}

function renderPerformanceDayInfoAdmin() {
    const performanceSelect = $('performanceDayInfoPerformance');
    const list = $('performanceDayInfoList');
    if (!performanceSelect || !list) return;

    const current = performanceSelect.value;
    performanceSelect.innerHTML = '<option value="">演奏会を選択</option>' + appState.performances.map((perf) =>
        `<option value="${escapeHtml(String(perf.id || ''))}">${escapeHtml(perf.title || '')}</option>`
    ).join('');
    if ([...performanceSelect.options].some((option) => option.value === current)) performanceSelect.value = current;

    const rows = sortedPerformanceDayInfoRows();
    list.innerHTML = rows.length
        ? `<div class="list-group">${rows.map((item) => `
            <button class="list-group-item list-group-item-action text-start performance-day-info-select-btn" type="button" data-performance-day-info-id="${escapeHtml(String(item.id || ''))}">
                <strong>${escapeHtml(item.performanceTitle)}</strong>
                <div class="small text-muted">${escapeHtml(formatDateWithWeekday(item.performanceDate || ''))}</div>
                <div class="small mt-1 text-truncate">タイムテーブル: ${escapeHtml(timelineRowsToLegacyText(normalizedPerformanceDayTimelineRows(item)) || '未登録')}</div>
                <div class="small text-truncate">本番衣装: ${escapeHtml(costumeDetailToLegacyText(normalizedCostumeDetail(item)) || '未登録')}</div>
                <div class="small text-truncate">係り割: ${escapeHtml(assignmentRowsToText(normalizedPerformanceDayAssignments(item)) || '未登録')}</div>
            </button>
        `).join('')}</div>`
        : '<p class="text-muted mb-0">本番情報はまだ登録されていません</p>';

    list.querySelectorAll('.performance-day-info-select-btn').forEach((button) => {
        button.addEventListener('click', () => selectPerformanceDayInfo(button.dataset.performanceDayInfoId || ''));
    });
}

function selectPerformanceDayInfo(infoId) {
    const item = (appState.performanceDayInfos || []).find((row) => String(row.id || '') === String(infoId));
    if (!item) return;
    $('performanceDayInfoId').value = item.id || '';
    $('performanceDayInfoPerformance').value = String(item.performance_id || '');
    $('performanceDayTimeline').value = timelineRowsToLegacyText(normalizedPerformanceDayTimelineRows(item)) || item.timeline || item.timetable || '';
    setCostumeDetailForm(normalizedCostumeDetail(item));
    renderPerformanceDayAssignmentRows(normalizedPerformanceDayAssignments(item));
}

function clearPerformanceDayInfoForm() {
    if ($('performanceDayInfoId')) $('performanceDayInfoId').value = '';
    if ($('performanceDayInfoPerformance')) $('performanceDayInfoPerformance').value = '';
    if ($('performanceDayTimeline')) $('performanceDayTimeline').value = '';
    setCostumeDetailForm(emptyCostumeDetail());
    renderPerformanceDayAssignmentRows([]);
}

async function savePerformanceDayInfo() {
    const performanceId = $('performanceDayInfoPerformance')?.value || '';
    const timeline = $('performanceDayTimeline')?.value.trim() || '';
    const performance = appState.performances.find((perf) => String(perf.id || '') === String(performanceId));
    const timelineRows = parseTimelineTextRows(timeline, performance);
    const costumeDetail = costumeDetailFromForm();
    const costume = costumeDetailToLegacyText(costumeDetail);
    const assignmentRows = collectPerformanceDayAssignmentRows();
    const assignments = assignmentRowsToText(assignmentRows);
    if (!performanceId) {
        showAlert('演奏会を選択してください', 'warning');
        return;
    }
    if (!timelineRows.length && !hasCostumeDetail(costumeDetail) && !assignments) {
        showAlert('タイムテーブル、本番衣装、係り割のいずれかを入力してください', 'warning');
        return;
    }

    const payload = {
        performance_id: performanceId,
        timeline: timeline || timelineRowsToLegacyText(timelineRows),
        timeline_rows: timelineRows,
        costume_detail: costumeDetail,
        costume,
        assignments_rows: assignmentRows,
        assignments,
        // 互換キーも保存し、既存データとの表記揺れを吸収する。
        timetable: timeline,
        duties: assignments
    };

    const id = $('performanceDayInfoId')?.value || '';
    const duplicate = (appState.performanceDayInfos || []).find((item) =>
        String(item.performance_id || '') === String(performanceId)
        && String(item.id || '') !== String(id)
    );
    const saveId = id || String(duplicate?.id || '');
    if (saveId) {
        await request(`/api/extra/performance_day_infos/${encodeURIComponent(saveId)}`, jsonOptions('PUT', payload));
    } else {
        await saveExtra('performance_day_infos', payload);
    }
    clearPerformanceDayInfoForm();
    await loadExtraData();
    showAlert('本番情報を保存しました', 'success');
}

async function exportPerformanceDayInfoExcel() {
    const selectedPerformanceId = String($('performanceDayInfoPerformance')?.value || '').trim();
    const currentId = String($('performanceDayInfoId')?.value || '').trim();
    const fromCurrent = (appState.performanceDayInfos || []).find((item) => String(item.id || '') === currentId);
    const performanceId = selectedPerformanceId || String(fromCurrent?.performance_id || '').trim();
    if (!performanceId) {
        showAlert('演奏会を選択してください', 'warning');
        return;
    }

    const deviceId = localStorage.getItem(PORTAL_DEVICE_ID_KEY) || '';
    const response = await fetch(`/api/reports/performance-timetable/${encodeURIComponent(performanceId)}/xlsx`, {
        method: 'GET',
        headers: deviceId ? { 'X-Device-Id': deviceId } : {}
    });
    if (!response.ok) {
        let message = 'Excel出力に失敗しました';
        try {
            const contentType = response.headers.get('content-type') || '';
            if (contentType.includes('application/json')) {
                const json = await response.json();
                message = json?.detail || message;
            }
        } catch {
            // no-op
        }
        showAlert(message, 'danger');
        throw new Error(message);
    }

    const blob = await response.blob();
    const contentDisposition = response.headers.get('Content-Disposition') || '';
    const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
    const asciiMatch = contentDisposition.match(/filename="?([^";]+)"?/i);
    const filename = utf8Match
        ? decodeURIComponent(utf8Match[1])
        : (asciiMatch ? asciiMatch[1] : `performance_timetable_${performanceId}.xlsx`);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    showAlert('Excelを出力しました', 'success');
}

async function deletePerformanceDayInfo() {
    const id = $('performanceDayInfoId')?.value || '';
    if (!id) {
        showAlert('削除する本番情報を選択してください', 'warning');
        return;
    }
    if (!confirmDelete()) return;
    await request(`/api/extra/performance_day_infos/${encodeURIComponent(id)}`, { method: 'DELETE' });
    clearPerformanceDayInfoForm();
    await loadExtraData();
    showAlert('本番情報を削除しました', 'success');
}

// マニュアルは固定文面だが、団体名など動的な表示には現在の設定値を反映する。
