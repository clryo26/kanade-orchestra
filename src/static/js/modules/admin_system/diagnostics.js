// Admin diagnostics split from modules/admin_system.js.
// Keep global names for legacy non-module loading.

var appState = (typeof window.getAppState === 'function')
    ? window.getAppState()
    : window.portalRuntimeContext.appState;
var $ = window.portalRuntimeContext.getById;

const READINESS_MANDATORY_KEYS = new Set([
    'db_ready_when_expected',
    'release_files',
]);

function readinessCategory(item) {
    return READINESS_MANDATORY_KEYS.has(String(item?.key || '')) ? '正式公開前に対応必須' : '要確認';
}

function readinessStatusBadge(item) {
    const passed = Boolean(item?.passed);
    const category = readinessCategory(item);
    if (passed) return '<span class="badge text-bg-success">OK</span>';
    if (category === '正式公開前に対応必須') return '<span class="badge text-bg-danger">必須</span>';
    return '<span class="badge text-bg-warning">要確認</span>';
}

function readinessDetailHtml(detailText, key) {
    const text = String(detailText || '').trim();
    if (!text) return '<span class="text-muted">-</span>';
    const isLong = text.length > 120 || (text.match(/, /g) || []).length >= 3;
    if (!isLong) {
        return escapeHtml(text);
    }
    const detailsId = `readiness-detail-${escapeHtml(String(key || 'detail'))}`;
    return `
        <details class="readiness-detail-collapse" id="${detailsId}">
            <summary>詳細を表示</summary>
            <div class="small text-break mt-1">${escapeHtml(text)}</div>
        </details>
    `;
}

async function loadAccessLogs() {
    appState.accessLogs = await request(`/api/system/access-logs?limit=200&_=${Date.now()}`);
    return appState.accessLogs;
}

function accessLogSortValue(item) {
    const value = String(item?.accessed_at || item?.created_at || '').trim();
    if (!value) return Number.NEGATIVE_INFINITY;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

async function renderAccessLogView() {
    const tbody = document.querySelector('#accessLogTable tbody');
    const status = $('accessLogStatus');
    if (!tbody) return;
    if (status) {
        status.hidden = false;
        status.textContent = '読み込み中...';
    }
    try {
        const logs = [...(await loadAccessLogs())].sort((a, b) => accessLogSortValue(b) - accessLogSortValue(a));
        if (status) {
            status.hidden = false;
            status.textContent = `${logs.length}件を表示しています`;
        }
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
        `).join('') : '<tr><td colspan="7" class="text-muted">アクセスログはまだありません</td></tr>';
    } catch (error) {
        if (status) {
            status.hidden = false;
            status.textContent = 'アクセスログの読み込みに失敗しました';
        }
        tbody.innerHTML = '<tr><td colspan="7" class="text-danger">アクセスログを取得できませんでした</td></tr>';
        console.error('Load access logs failed', error);
    }
}

function updateCloudRunRevision() {
    const revisionLabel = currentRevisionText();
    const revisionElements = [
        $('revisionNumber'),
        ...document.querySelectorAll('[data-revision-number]')
    ].filter(Boolean);
    revisionElements.forEach((element) => {
        element.textContent = revisionLabel;
    });
}

function currentRevisionText() {
    return cloudRunRevisionLabel(appState.cloudRunRevision) || '取得中';
}

async function loadCloudRunRevision() {
    try {
        const data = await requestJson('/api/revision', { cache: 'no-store' });
        appState.cloudRunRevision = data.cloudRunRevision || '';
        updateCloudRunRevision();
    } catch (error) {
        console.warn('Cloud Run revision fetch failed', error);
        updateCloudRunRevision();
    }
}

async function renderReadinessDashboard() {
    const status = $('readinessStatus');
    const summary = $('readinessSummary');
    const checks = $('readinessChecks');
    if (!status || !summary || !checks) return;

    status.hidden = false;
    status.textContent = '読み込み中...';
    summary.innerHTML = '';
    checks.innerHTML = '';
    try {
        const data = await request('/api/system/readiness-summary');
        const runtime = data.runtime || {};
        const governance = data.governance || {};
        const rows = Array.isArray(data.checks) ? data.checks : [];
        const failedMandatory = rows.filter((item) => !item.passed && readinessCategory(item) === '正式公開前に対応必須');
        const failedReview = rows.filter((item) => !item.passed && readinessCategory(item) === '要確認');
        const levelClass = failedMandatory.length ? 'text-danger' : (failedReview.length ? 'text-warning' : 'text-success');
        status.className = `${levelClass} small mb-2`;
        if (failedMandatory.length) {
            const labels = failedMandatory.map((item) => item.label || item.key).join(' / ');
            status.textContent = `Warning: 正式公開前に対応必須項目があります（${labels}）`;
        } else if (failedReview.length) {
            const labels = failedReview.map((item) => item.label || item.key).join(' / ');
            status.textContent = `Warning: 要確認項目があります（${labels}）`;
        } else {
            status.textContent = 'Ready: 主要チェックは正常です';
        }

        summary.innerHTML = `
            <div class="row g-2 small">
                <div class="col-md-4"><strong>DATA_BACKEND:</strong> ${escapeHtml(String(runtime.data_backend || ''))}</div>
                <div class="col-md-4"><strong>DB expected:</strong> ${runtime.db_expected ? 'yes' : 'no'}</div>
                <div class="col-md-4"><strong>DB ready:</strong> ${runtime.db_ready ? 'yes' : 'no'}</div>
                <div class="col-md-4"><strong>JSON fallback:</strong> ${runtime.local_json_fallback_enabled ? 'enabled' : 'disabled'}</div>
                <div class="col-md-4"><strong>app_core:</strong> ${escapeHtml(String(governance.app_core_lines || 0))}/${escapeHtml(String(governance.app_core_budget || 520))}</div>
                <div class="col-md-4"><strong>更新時刻:</strong> ${escapeHtml(formatDateTimeLabel(data.generated_at || ''))}</div>
            </div>
            <div class="small mt-2">
                <span class="badge text-bg-danger me-1">正式公開前に対応必須</span>${failedMandatory.length}件
                <span class="badge text-bg-warning ms-3 me-1">要確認</span>${failedReview.length}件
            </div>
        `;

        checks.innerHTML = rows.length ? rows.map((item) => `
            <tr>
                <td>${readinessStatusBadge(item)}</td>
                <td>${escapeHtml(String(item.label || item.key || ''))}</td>
                <td class="small text-break">
                    <div class="mb-1"><span class="badge text-bg-light">${escapeHtml(readinessCategory(item))}</span></div>
                    ${readinessDetailHtml(item.detail || '', item.key || '')}
                </td>
            </tr>
        `).join('') : '<tr><td colspan="3" class="text-muted">チェック項目がありません</td></tr>';
    } catch (error) {
        status.className = 'text-danger small mb-2';
        status.textContent = '読み込みに失敗しました';
        checks.innerHTML = '<tr><td colspan="3" class="text-danger">Readyチェックを取得できませんでした</td></tr>';
        console.error('Readiness dashboard failed', error);
    }
}

function cloudRunRevisionLabel(revision) {
    const value = String(revision || '').trim();
    if (!value) return '';
    const match = value.match(/(?:^|-)(\d{5}-[a-z0-9]+)$/i);
    return match ? match[1] : value;
}
