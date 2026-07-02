// Performance day actions split from modules/performance_day.js.
// Keep global names for compatibility with legacy non-module loading.

var appState = window.portalRuntimeContext.appState;
var $ = window.portalRuntimeContext.getById;

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
        timetable: timeline,
        duties: assignments,
    };
    const id = $('performanceDayInfoId')?.value || '';
    const duplicate = (appState.performanceDayInfos || []).find((item) => String(item.performance_id || '') === String(performanceId) && String(item.id || '') !== String(id));
    const saveId = id || String(duplicate?.id || '');
    if (saveId) await request(`/api/extra/performance_day_infos/${encodeURIComponent(saveId)}`, jsonOptions('PUT', payload));
    else await saveExtra('performance_day_infos', payload);
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
        headers: deviceId ? { 'X-Device-Id': deviceId } : {},
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
        }
        showAlert(message, 'danger');
        throw new Error(message);
    }
    const blob = await response.blob();
    const contentDisposition = response.headers.get('Content-Disposition') || '';
    const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
    const asciiMatch = contentDisposition.match(/filename="?([^";]+)"?/i);
    const filename = utf8Match ? decodeURIComponent(utf8Match[1]) : (asciiMatch ? asciiMatch[1] : `performance_timetable_${performanceId}.xlsx`);
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
