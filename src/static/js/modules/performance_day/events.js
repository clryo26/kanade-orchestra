// Performance day actions split from modules/performance_day.js.
// Keep global names for compatibility with legacy non-module loading.

var appState = window.portalRuntimeContext.appState;
var $ = window.portalRuntimeContext.getById;

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
    await loadExtraData(['performanceDayInfos']);
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
    const response = await fetchWithTimeout(`/api/reports/performance-timetable/${encodeURIComponent(performanceId)}/xlsx`, {
        method: 'GET',
        headers: deviceId ? { 'X-Device-Id': deviceId } : {}
    }, PORTAL_TIMEOUT_GET);
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
    await loadExtraData(['performanceDayInfos']);
    showAlert('本番情報を削除しました', 'success');
}
