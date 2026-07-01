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

function cloudRunRevisionLabel(revision) {
    const value = String(revision || '').trim();
    if (!value) return '';
    const match = value.match(/(?:^|-)(\d{5}-[a-z0-9]+)$/i);
    return match ? match[1] : value;
}
