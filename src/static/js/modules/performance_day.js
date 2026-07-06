// Frontend split: extracted from main.js.
// performance_day.js now stays as a thin compatibility loader.

var appState = window.portalRuntimeContext.appState;
var $ = window.portalRuntimeContext.getById;

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
            start_time: performanceDayTimelineStartValue(row),
            end_time: normalizeClockText(row?.end_time || row?.end || ''),
            duration_minutes: String(row?.duration_minutes || row?.duration || '').trim(),
            kind: String(row?.kind || row?.type || '').trim(),
            part: String(row?.part || row?.section || '').trim(),
            section: String(row?.section || row?.category || '').trim(),
            label: String(row?.label || row?.content || row?.title || '').trim(),
            content: String(row?.content || row?.label || row?.title || '').trim(),
            mc: String(row?.mc || '').trim(),
            reception: String(row?.reception || row?.desk || '').trim(),
            setting: String(row?.setting || '').trim(),
            note: String(row?.note || '').trim(),
            source_line: String(row?.source_line || '').trim()
        })).filter((row) => row.content || row.label || row.start_time || row.section || row.part);
    }
    const performance = appState.performances.find((perf) => String(perf.id || '') === String(item?.performance_id || ''));
    return parseTimelineTextRows(item?.timeline || item?.timetable || '', performance);
}

function performanceDayPartNames(performance) {
    const seen = new Set();
    return normalizePerformancePieces(performance?.pieces || [])
        .map((piece) => String(piece?.part || '').trim())
        .filter((part) => part && !seen.has(part) && seen.add(part));
}

function normalizePartRehearsalMinutes(value) {
    const text = String(value || '').trim();
    if (!/^\d{1,3}$/.test(text)) return '';
    return text.padStart(3, '0');
}

function performanceDayTimelineStartValue(row) {
    const kind = String(row?.kind || row?.type || '').trim();
    const rawStart = row?.start_time || row?.start || '';
    // Part rehearsal rows store minutes, not clock text.
    if (kind === 'part_rehearsal') return normalizePartRehearsalMinutes(rawStart);
    return normalizeClockText(rawStart);
}

function performanceDayTimelineLabel(row) {
    const kind = String(row?.kind || row?.type || '').trim();
    const part = String(row?.part || row?.section || '').trim();
    const label = String(row?.label || row?.content || row?.title || '').trim();
    if (label) return label;
    if (kind === 'open_time') return '開場時間';
    if (kind === 'rehearsal_start_time') return 'リハーサル開始時刻';
    if (kind === 'performance_start_time') return '開演時間';
    if (kind === 'part_rehearsal' && part) return `${part}のリハ時間`;
    return part;
}

function performanceDayTimelineRowEntries(performance, timelineRows = []) {
    const existing = new Map();
    (Array.isArray(timelineRows) ? timelineRows : []).forEach((row) => {
        const kind = String(row?.kind || row?.type || '').trim();
        const part = String(row?.part || row?.section || '').trim();
        const label = performanceDayTimelineLabel(row);
        const key = kind === 'part_rehearsal' && part ? `part:${part}` : kind || label;
        if (key) existing.set(key, performanceDayTimelineStartValue(row));
    });
    return [
        { key: 'open_time', kind: 'open_time', label: '開場時間', section: '基本' },
        { key: 'rehearsal_start_time', kind: 'rehearsal_start_time', label: 'リハーサル開始時刻', section: '基本' },
        ...performanceDayPartNames(performance).map((part) => ({ key: `part:${part}`, kind: 'part_rehearsal', part, label: `${part}のリハ時間`, section: part })),
        { key: 'performance_start_time', kind: 'performance_start_time', label: '開演時間', section: '基本' },
    ].map((row) => ({ ...row, start_time: existing.get(row.key) || '' }));
}

function renderPerformanceDayPartRehearsalRows(performance, timelineRows = []) {
    const container = $('performanceDayPartRehearsalRows');
    if (!container) return;
    const targetPerformance = performance || appState.performances.find((perf) => String(perf.id || '') === String($('performanceDayInfoPerformance')?.value || '')) || null;
    const rows = performanceDayTimelineRowEntries(targetPerformance, timelineRows);
    const partRows = rows.filter((row) => row.kind === 'part_rehearsal');
    if (!partRows.length) {
        container.innerHTML = '<div class="col-12"><div class="small text-muted">この演奏会には部が登録されていません</div></div>';
        return;
    }
    container.innerHTML = partRows.map((row) => `
        <div class="col-md-6 col-lg-4">
            <label class="form-label" for="performanceDayPartTime_${escapeHtml(cssSafeId(row.part || 'part'))}">${escapeHtml(row.label || '')}</label>
            <input type="text" inputmode="numeric" pattern="\\d{1,3}" maxlength="3" class="form-control performance-day-part-rehearsal-time" id="performanceDayPartTime_${escapeHtml(cssSafeId(row.part || 'part'))}" data-performance-day-part="${escapeHtml(row.part || '')}" value="${escapeHtml(normalizePartRehearsalMinutes(row.start_time || ''))}" placeholder="000">
        </div>
    `).join('');
    container.querySelectorAll('.performance-day-part-rehearsal-time').forEach((input) => {
        input.addEventListener('blur', () => {
            input.value = normalizePartRehearsalMinutes(input.value || '');
        });
    });
}

function collectPerformanceDayPartRehearsalRows() {
    const container = $('performanceDayPartRehearsalRows');
    if (!container) return [];
    return [...container.querySelectorAll('.performance-day-part-rehearsal-time')].map((input) => {
        const part = String(input.dataset.performanceDayPart || '').trim();
        return {
            kind: 'part_rehearsal',
            part,
            section: part,
            label: `${part}のリハ時間`,
            content: `${part}のリハ時間`,
            start_time: normalizePartRehearsalMinutes(input.value || ''),
            end_time: '',
            duration_minutes: '',
        };
    }).filter((row) => row.part);
}

function timelineRowsToLegacyText(rows) {
    return (rows || []).map((row) => {
        const start = normalizeClockText(row?.start_time || '');
        const end = normalizeClockText(row?.end_time || '');
        const kind = String(row?.kind || '').trim();
        const label = String(row?.label || row?.content || row?.section || '').trim();
        if (!kind && String(row?.source_line || '').trim()) return String(row?.source_line || '').trim();
        if (kind === 'part_rehearsal' && label) return `${label}: ${normalizePartRehearsalMinutes(row?.start_time || '')}`;
        if (start && end && label) return `${label}: ${start}-${end}`;
        if (start && label) return `${label}: ${start}`;
        if (label) return label;
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
    // Editing state must keep blank rows; the save payload is filtered separately.
    const renderRows = Array.isArray(rows) && rows.length ? rows : [{ role: '', members: '' }];
    container.innerHTML = renderRows.map((row, index) => `
        <tr>
            <td><input type="text" class="form-control form-control-sm performance-day-assignment-role" value="${escapeHtml(String(row.role || ''))}" placeholder="例: 受付"></td>
            <td><input type="text" class="form-control form-control-sm performance-day-assignment-members" value="${escapeHtml(String(row.members || ''))}" placeholder="例: 田中, 鈴木"></td>
            <td><button class="btn btn-sm btn-outline-danger performance-day-assignment-delete-btn" type="button" data-row-index="${index}">削除</button></td>
        </tr>
    `).join('');
    container.querySelectorAll('.performance-day-assignment-delete-btn').forEach((button) => {
        button.addEventListener('click', () => {
            const currentRows = collectPerformanceDayAssignmentRows({ includeBlankRows: true });
            const targetIndex = Number(button.dataset.rowIndex || '-1');
            if (targetIndex >= 0) currentRows.splice(targetIndex, 1);
            renderPerformanceDayAssignmentRows(currentRows);
        });
    });
}

function addPerformanceDayAssignmentRow() {
    const currentRows = collectPerformanceDayAssignmentRows({ includeBlankRows: true });
    currentRows.push({ role: '', members: '' });
    renderPerformanceDayAssignmentRows(currentRows);
}

function collectPerformanceDayAssignmentRows(options = {}) {
    const container = $('performanceDayAssignmentRows');
    if (!container) return [];
    const rows = [...container.querySelectorAll('tr')].map((row) => ({
        role: String(row.querySelector('.performance-day-assignment-role')?.value || '').trim(),
        members: String(row.querySelector('.performance-day-assignment-members')?.value || '').trim()
    }));
    if (options.includeBlankRows) return rows;
    return rows.filter((item) => item.role || item.members);
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
                <thead class="table-light"><tr><th style="width:35%;">項目</th><th style="width:25%;">時刻</th><th>備考</th></tr></thead>
                <tbody>
                    ${rows.map((row) => {
        const start = normalizeClockText(row?.start_time || '');
        const end = normalizeClockText(row?.end_time || '');
        const timeText = start && end ? `${start}-${end}` : (start || end || '');
        const label = String(row?.label || row?.content || row?.section || '').trim();
        const note = String(row?.note || '').trim();
        return `<tr><td>${escapeHtml(label)}</td><td>${escapeHtml(timeText)}</td><td>${escapeHtml(note)}</td></tr>`;
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
                <strong>本番タイムテーブル</strong>
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
    const performance = appState.performances.find((perf) => String(perf.id || '') === String(item.performance_id || '')) || null;
    const timelineRows = normalizedPerformanceDayTimelineRows(item);
    $('performanceDayInfoId').value = item.id || '';
    $('performanceDayInfoPerformance').value = String(item.performance_id || '');
    if ($('performanceDayOpenTime')) $('performanceDayOpenTime').value = timelineRows.find((row) => row.kind === 'open_time')?.start_time || '';
    if ($('performanceDayRehearsalStartTime')) $('performanceDayRehearsalStartTime').value = timelineRows.find((row) => row.kind === 'rehearsal_start_time')?.start_time || '';
    if ($('performanceDayStartTime')) $('performanceDayStartTime').value = timelineRows.find((row) => row.kind === 'performance_start_time')?.start_time || '';
    renderPerformanceDayPartRehearsalRows(performance, timelineRows);
    setCostumeDetailForm(normalizedCostumeDetail(item));
    renderPerformanceDayAssignmentRows(normalizedPerformanceDayAssignments(item));
}

function clearPerformanceDayInfoForm() {
    if ($('performanceDayInfoId')) $('performanceDayInfoId').value = '';
    if ($('performanceDayInfoPerformance')) $('performanceDayInfoPerformance').value = '';
    if ($('performanceDayOpenTime')) $('performanceDayOpenTime').value = '';
    if ($('performanceDayRehearsalStartTime')) $('performanceDayRehearsalStartTime').value = '';
    if ($('performanceDayStartTime')) $('performanceDayStartTime').value = '';
    renderPerformanceDayPartRehearsalRows(null, []);
    setCostumeDetailForm(emptyCostumeDetail());
    renderPerformanceDayAssignmentRows([]);
}

async function savePerformanceDayInfo() {
    const performanceId = $('performanceDayInfoPerformance')?.value || '';
    const performance = appState.performances.find((perf) => String(perf.id || '') === String(performanceId));
    const openTime = normalizeClockText($('performanceDayOpenTime')?.value || '');
    const rehearsalStartTime = normalizeClockText($('performanceDayRehearsalStartTime')?.value || '');
    const performanceStartTime = normalizeClockText($('performanceDayStartTime')?.value || '');
    const partRows = collectPerformanceDayPartRehearsalRows();
    const missingPartRow = partRows.find((row) => !row.start_time);
    const costumeDetail = costumeDetailFromForm();
    const costume = costumeDetailToLegacyText(costumeDetail);
    const assignmentRows = collectPerformanceDayAssignmentRows();
    const assignments = assignmentRowsToText(assignmentRows);
    if (!performanceId) {
        showAlert('演奏会を選択してください', 'warning');
        return;
    }
    if (!openTime || !rehearsalStartTime || !performanceStartTime) {
        showAlert('開場時間、リハーサル開始時刻、開演時間を入力してください', 'warning');
        return;
    }
    if (missingPartRow) {
        showAlert(`${missingPartRow.part}のリハ時間を入力してください`, 'warning');
        return;
    }

    const timelineRows = [
        { sort_order: 1, kind: 'open_time', section: '基本', label: '開場時間', content: '開場時間', start_time: openTime, end_time: '', duration_minutes: '' },
        { sort_order: 2, kind: 'rehearsal_start_time', section: '基本', label: 'リハーサル開始時刻', content: 'リハーサル開始時刻', start_time: rehearsalStartTime, end_time: '', duration_minutes: '' },
        ...partRows.map((row, index) => ({ sort_order: index + 3, ...row })),
        { sort_order: partRows.length + 3, kind: 'performance_start_time', section: '基本', label: '開演時間', content: '開演時間', start_time: performanceStartTime, end_time: '', duration_minutes: '' },
    ];

    const payload = {
        performance_id: performanceId,
        timeline: timelineRowsToLegacyText(timelineRows),
        timeline_rows: timelineRows,
        costume_detail: costumeDetail,
        costume,
        assignments_rows: assignmentRows,
        assignments,
        timetable: timelineRowsToLegacyText(timelineRows),
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

    const deviceId = localStorage.getItem(window.portalRuntimeContext.PORTAL_DEVICE_ID_KEY) || '';
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
