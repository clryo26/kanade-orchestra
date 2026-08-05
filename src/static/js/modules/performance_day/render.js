// Performance day render functions split from modules/performance_day.js.
// Keep global names for compatibility with legacy non-module loading.

var appState = window.portalRuntimeContext.appState;
var $ = window.portalRuntimeContext.getById;

function renderPerformanceDayInfoView() {
    const container = $('memberPerformanceDayInfo');
    if (!container) return;
    const rows = sortedPerformanceDayInfoRows().filter((item) => isUpcomingPerformanceDate(item.performanceDate));
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