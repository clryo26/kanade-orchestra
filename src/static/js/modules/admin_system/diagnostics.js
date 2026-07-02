// Admin diagnostics split from modules/admin_system.js.
// Keep global names for legacy non-module loading.

var appState = (typeof window.getAppState === 'function')
    ? window.getAppState()
    : window.portalRuntimeContext.appState;
var $ = window.portalRuntimeContext.getById;

async function loadAccessLogs() {
    appState.accessLogs = await request(`/api/system/access-logs?limit=200&_=${Date.now()}`);
    return appState.accessLogs;
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
        const logs = await loadAccessLogs();
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
        const levelClass = data.overall_status === 'ok' ? 'text-success' : 'text-warning';
        status.className = `${levelClass} small mb-2`;
        status.textContent = data.overall_status === 'ok' ? 'Ready: 主要チェックは正常です' : 'Warning: 要確認項目があります';

        summary.innerHTML = `
            <div class="row g-2 small">
                <div class="col-md-4"><strong>DATA_BACKEND:</strong> ${escapeHtml(String(runtime.data_backend || ''))}</div>
                <div class="col-md-4"><strong>DB expected:</strong> ${runtime.db_expected ? 'yes' : 'no'}</div>
                <div class="col-md-4"><strong>DB ready:</strong> ${runtime.db_ready ? 'yes' : 'no'}</div>
                <div class="col-md-4"><strong>JSON fallback:</strong> ${runtime.local_json_fallback_enabled ? 'enabled' : 'disabled'}</div>
                <div class="col-md-4"><strong>app_core:</strong> ${escapeHtml(String(governance.app_core_lines || 0))}/${escapeHtml(String(governance.app_core_budget || 520))}</div>
                <div class="col-md-4"><strong>更新時刻:</strong> ${escapeHtml(formatDateTimeLabel(data.generated_at || ''))}</div>
            </div>
        `;

        const rows = Array.isArray(data.checks) ? data.checks : [];
        checks.innerHTML = rows.length ? rows.map((item) => `
            <tr>
                <td>${item.passed ? '<span class="text-success">OK</span>' : '<span class="text-warning">WARN</span>'}</td>
                <td>${escapeHtml(String(item.label || item.key || ''))}</td>
                <td class="small text-break">${escapeHtml(String(item.detail || ''))}</td>
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
