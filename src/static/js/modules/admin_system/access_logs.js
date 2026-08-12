// System-admin access log search and pagination.
// Loaded on demand from navigation/routes.js when the access-log tab is opened.

var appState = (typeof window.getAppState === 'function')
    ? window.getAppState()
    : window.portalRuntimeContext.appState;
var $ = window.portalRuntimeContext.getById;

var ACCESS_LOG_PAGE_SIZE = 100;
var accessLogCurrentPage = 1;
var accessLogHasSearched = false;

function accessLogMemberOptionsHtml(selected = '') {
    const normalizedSelected = String(selected || '');
    const members = [...(appState.members || [])]
        .filter((member) => member?.id !== null && member?.id !== undefined)
        .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'ja'));
    return ['<option value="">すべて</option>']
        .concat(members.map((member) => {
            const id = String(member.id);
            const name = String(member.name || `ID ${id}`);
            return `<option value="${escapeHtml(id)}" ${id === normalizedSelected ? 'selected' : ''}>${escapeHtml(name)}</option>`;
        }))
        .join('');
}

function accessLogPartOptionsHtml(selected = '') {
    const normalizedSelected = String(selected || '');
    return ['<option value="">すべて</option>']
        .concat(currentPartNames().map((part) => {
            const name = String(part || '');
            return `<option value="${escapeHtml(name)}" ${name === normalizedSelected ? 'selected' : ''}>${escapeHtml(name)}</option>`;
        }))
        .join('');
}

function accessLogDateBoundary(value, exclusiveEnd = false) {
    const normalized = String(value || '').trim();
    if (!normalized) return '';
    const date = new Date(`${normalized}T00:00:00`);
    if (Number.isNaN(date.getTime())) return '';
    if (exclusiveEnd) date.setDate(date.getDate() + 1);
    return date.toISOString();
}

function prepareAccessLogView() {
    const tbody = document.querySelector('#accessLogTable tbody');
    const status = $('accessLogStatus');
    const searchButton = $('accessLogReloadBtn');
    if (!tbody || !status) return;

    if (searchButton) searchButton.textContent = '検索';

    let filters = $('accessLogSearchFilters');
    if (!filters) {
        filters = document.createElement('div');
        filters.id = 'accessLogSearchFilters';
        filters.className = 'border rounded p-3 mb-3';
        filters.innerHTML = `
            <div class="row g-2 align-items-end">
                <div class="col-md-3">
                    <label class="form-label" for="accessLogDateFrom">日付 From</label>
                    <input class="form-control" id="accessLogDateFrom" type="date">
                </div>
                <div class="col-md-3">
                    <label class="form-label" for="accessLogDateTo">日付 To</label>
                    <input class="form-control" id="accessLogDateTo" type="date">
                </div>
                <div class="col-md-3">
                    <label class="form-label" for="accessLogMemberId">団員</label>
                    <select class="form-select" id="accessLogMemberId"></select>
                </div>
                <div class="col-md-3">
                    <label class="form-label" for="accessLogMemberPart">パート</label>
                    <select class="form-select" id="accessLogMemberPart"></select>
                </div>
            </div>
            <div class="d-flex justify-content-between align-items-center gap-2 mt-3" id="accessLogPagination" hidden>
                <button class="btn btn-outline-secondary btn-sm" id="accessLogPrevBtn" type="button">前へ</button>
                <span class="small" id="accessLogPageLabel"></span>
                <button class="btn btn-outline-secondary btn-sm" id="accessLogNextBtn" type="button">次へ</button>
            </div>
        `;
        status.parentNode.insertBefore(filters, status);

        $('accessLogPrevBtn').addEventListener('click', () => {
            if (accessLogCurrentPage > 1) {
                renderAccessLogPage(accessLogCurrentPage - 1);
            }
        });
        $('accessLogNextBtn').addEventListener('click', () => {
            renderAccessLogPage(accessLogCurrentPage + 1);
        });
    }

    const memberSelect = $('accessLogMemberId');
    if (memberSelect) {
        const selected = memberSelect.value;
        memberSelect.innerHTML = accessLogMemberOptionsHtml(selected);
        if ([...memberSelect.options].some((option) => option.value === selected)) {
            memberSelect.value = selected;
        }
    }

    const partSelect = $('accessLogMemberPart');
    if (partSelect) {
        const selected = partSelect.value;
        partSelect.innerHTML = accessLogPartOptionsHtml(selected);
        if ([...partSelect.options].some((option) => option.value === selected)) {
            partSelect.value = selected;
        }
    }

    if (!accessLogHasSearched) {
        status.hidden = false;
        status.textContent = '検索条件を指定して「検索」を押してください。条件なしの場合は全ログを対象にします。';
        tbody.innerHTML = '<tr><td colspan="7" class="text-muted">検索を実行するとアクセスログを表示します</td></tr>';
        const pagination = $('accessLogPagination');
        if (pagination) pagination.hidden = true;
    }
}

async function loadAccessLogs(page = 1) {
    const params = new URLSearchParams();
    params.set('page', String(page));

    const dateFrom = accessLogDateBoundary($('accessLogDateFrom')?.value);
    const dateTo = accessLogDateBoundary($('accessLogDateTo')?.value, true);
    const memberId = String($('accessLogMemberId')?.value || '').trim();
    const memberPart = String($('accessLogMemberPart')?.value || '').trim();

    if (dateFrom) params.set('date_from', dateFrom);
    if (dateTo) params.set('date_to', dateTo);
    if (memberId) params.set('member_id', memberId);
    if (memberPart) params.set('member_part', memberPart);
    params.set('_', String(Date.now()));

    const result = await request(`/api/system/access-logs?${params.toString()}`);
    const items = Array.isArray(result?.items) ? result.items : [];
    appState.accessLogs = items;
    return {
        items,
        page: Number(result?.page || 1),
        pageSize: Number(result?.page_size || ACCESS_LOG_PAGE_SIZE),
        total: Number(result?.total || 0),
        totalPages: Number(result?.total_pages || 1),
    };
}

function accessLogSortValue(item) {
    const value = String(item?.accessed_at || item?.created_at || '').trim();
    if (!value) return Number.NEGATIVE_INFINITY;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

async function renderAccessLogPage(page) {
    const tbody = document.querySelector('#accessLogTable tbody');
    const status = $('accessLogStatus');
    if (!tbody) return;

    if (status) {
        status.hidden = false;
        status.textContent = '読み込み中...';
    }

    try {
        const result = await loadAccessLogs(page);
        const logs = [...result.items].sort((a, b) => accessLogSortValue(b) - accessLogSortValue(a));
        accessLogCurrentPage = result.page;

        const first = result.total ? ((result.page - 1) * result.pageSize) + 1 : 0;
        const last = result.total ? Math.min(result.page * result.pageSize, result.total) : 0;
        if (status) {
            status.hidden = false;
            status.textContent = `${result.total}件中 ${first}-${last}件を表示しています`;
        }

        const pagination = $('accessLogPagination');
        const pageLabel = $('accessLogPageLabel');
        const prevButton = $('accessLogPrevBtn');
        const nextButton = $('accessLogNextBtn');
        if (pagination) pagination.hidden = false;
        if (pageLabel) pageLabel.textContent = `${result.page} / ${result.totalPages}ページ`;
        if (prevButton) prevButton.disabled = result.page <= 1;
        if (nextButton) nextButton.disabled = result.page >= result.totalPages;

        tbody.innerHTML = logs.length ? logs.map((item) => `
            <tr>
                <td class="text-nowrap">${escapeHtml(formatDateTimeLabel(item.accessed_at || item.created_at))}</td>
                <td>${escapeHtml(item.member_name || '不明')}</td>
                <td>${escapeHtml(item.member_part || '')}</td>
                <td>${escapeHtml(item.permission || '')}</td>
                <td>${escapeHtml(item.menu_label || item.menu_key || '')}</td>
                <td>${escapeHtml(item.panel || '')}</td>
                <td class="small text-break">${escapeHtml(item.device_name || item.device_id || '')}</td>
            </tr>
        `).join('') : '<tr><td colspan="7" class="text-muted">条件に一致するアクセスログはありません</td></tr>';
    } catch (error) {
        if (status) {
            status.hidden = false;
            status.textContent = 'アクセスログの読み込みに失敗しました';
        }
        const pagination = $('accessLogPagination');
        if (pagination) pagination.hidden = true;
        tbody.innerHTML = '<tr><td colspan="7" class="text-danger">アクセスログを取得できませんでした</td></tr>';
        console.error('Load access logs failed', error);
    }
}

async function renderAccessLogView() {
    accessLogHasSearched = true;
    return renderAccessLogPage(1);
}
