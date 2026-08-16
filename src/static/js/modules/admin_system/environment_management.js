// Environment management for test/prod split preparation.
// Keep global names for compatibility with legacy non-module loading.

var appState = (typeof window.getAppState === 'function')
    ? window.getAppState()
    : window.portalRuntimeContext.appState;
var $ = window.portalRuntimeContext.getById;

function _setEnvironmentField(id, value) {
    const input = $(id);
    if (!input) return;
    input.value = String(value || '未設定');
}

function _missingDeployValue(value) {
    const normalized = String(value || '').trim();
    return !normalized || normalized === '未設定';
}

function _formatOperationHistory(items) {
    const rows = Array.isArray(items) ? items : [];
    if (!rows.length) return '履歴なし';
    return rows.map((item) => {
        const state = String(item.execution_status || 'unknown');
        const requestedAt = formatDateTimeLabel(item.requested_at || '');
        const target = String(item.target_environment || '');
        const gitSha = String(item.target_git_sha || '');
        const imageDigest = String(item.image_digest || '');
        const requestedBy = String(item.requested_by || '');
        const reason = String(item.failure_reason || '');
        return `${requestedAt} | ${state} | target=${target} | sha=${gitSha || '未設定'} | digest=${imageDigest || '未設定'} | by=${requestedBy || '不明'}${reason ? ` | reason=${reason}` : ''}`;
    }).join('\n');
}

async function refreshSystemEnvironmentMenuVisibility() {
    const button = $('systemEnvironmentMenuBtn');
    if (!button) return false;

    // First gate: only normal system admin may see this menu.
    const allowedByUser = appState.currentUserPermission === 'システム管理者' && !appState.currentUserHiddenUser;
    if (!allowedByUser) {
        button.hidden = true;
        return false;
    }

    const deviceId = localStorage.getItem(window.portalRuntimeContext.PORTAL_DEVICE_ID_KEY) || '';
    if (!deviceId) {
        button.hidden = true;
        return false;
    }

    try {
        const response = await fetchWithTimeout('/api/system/environment/status', {
            method: 'GET',
            headers: { 'X-Device-Id': deviceId },
        }, PORTAL_TIMEOUT_GET);
        if (!response.ok) {
            button.hidden = true;
            return false;
        }
        const payload = await response.json().catch(() => ({}));
        appState.systemEnvironmentStatus = payload;
        button.hidden = false;
        return true;
    } catch {
        button.hidden = true;
        return false;
    }
}

function _bindEnvironmentButtons() {
    const promoteBtn = $('environmentReleasePromoteBtn');
    const syncBtn = $('environmentProdToTestSyncBtn');
    if (promoteBtn && !promoteBtn.dataset.bound) {
        promoteBtn.dataset.bound = '1';
        promoteBtn.addEventListener('click', async () => {
            const status = $('environmentOperationResult');
            if (status) status.textContent = '本番リリースを要求しています...';
            const targetGitSha = String(appState.systemEnvironmentStatus?.deploy_info?.git_sha || '').trim();
            const targetImageDigest = String(appState.systemEnvironmentStatus?.deploy_info?.image_digest || '').trim();
            if (_missingDeployValue(targetGitSha)) {
                if (status) status.textContent = 'Git SHA が未設定のため、本番リリース要求を送信しませんでした。';
                return;
            }
            if (_missingDeployValue(targetImageDigest)) {
                if (status) status.textContent = 'Image Digest が未設定のため、本番リリース要求を送信しませんでした。';
                return;
            }
            await request('/api/system/release/promote', jsonOptions('POST', {
                target_git_sha: targetGitSha,
                target_image_digest: targetImageDigest,
            }));
            await renderSystemEnvironmentManagement();
        });
    }
    if (syncBtn && !syncBtn.dataset.bound) {
        syncBtn.dataset.bound = '1';
        syncBtn.addEventListener('click', async () => {
            const status = $('environmentOperationResult');
            if (status) status.textContent = '本番データ同期を要求しています...';
            const targetGitSha = String(appState.systemEnvironmentStatus?.deploy_info?.git_sha || '').trim();
            await request('/api/system/sync/prod-to-test', jsonOptions('POST', {
                target_git_sha: targetGitSha,
            }));
            await renderSystemEnvironmentManagement();
        });
    }
}

async function renderSystemEnvironmentManagement() {
    const statusEl = $('systemEnvironmentStatus');
    const actionArea = $('environmentOperationActions');
    const resultEl = $('environmentOperationResult');
    const releaseHistory = $('environmentReleaseHistory');
    const syncHistory = $('environmentSyncHistory');
    if (!statusEl || !actionArea || !resultEl || !releaseHistory || !syncHistory) return;

    _bindEnvironmentButtons();

    statusEl.className = 'text-muted small mb-3';
    statusEl.textContent = '読み込み中...';
    resultEl.textContent = '';

    try {
        const [status, release, sync] = await Promise.all([
            request('/api/system/environment/status'),
            request('/api/system/release/history'),
            request('/api/system/sync/history'),
        ]);

        appState.systemEnvironmentStatus = status;
        _setEnvironmentField('environmentCurrentEnvironment', status.current_environment || '未設定');
        _setEnvironmentField('environmentAppEnv', status.app_env || '未設定');
        _setEnvironmentField('environmentGitSha', status.deploy_info?.git_sha || '未設定');
        _setEnvironmentField('environmentBuildTime', status.deploy_info?.build_time || '未設定');
        _setEnvironmentField('environmentCloudRunRevision', status.deploy_info?.cloud_run_revision || '未設定');
        _setEnvironmentField('environmentCloudRunService', status.deploy_info?.cloud_run_service || '未設定');
        _setEnvironmentField('environmentImageUri', status.deploy_info?.image_uri || '未設定');
        _setEnvironmentField('environmentImageDigest', status.deploy_info?.image_digest || '未設定');

        releaseHistory.textContent = _formatOperationHistory(release.items);
        syncHistory.textContent = _formatOperationHistory(sync.items);

        const canManage = Boolean(status.can_manage_operations) && !appState.currentUserHiddenUser;
        actionArea.hidden = !canManage;
        if (canManage) {
            statusEl.className = 'text-success small mb-3';
            statusEl.textContent = 'テスト環境として本番操作API契約を利用できます。';
        } else {
            statusEl.className = 'text-warning small mb-3';
            statusEl.textContent = 'この環境では本番操作は利用できません。';
        }

        if (!status.execution_backend_implemented || !status.promotion_dispatch?.configured) {
            resultEl.textContent = '本番リリース実行基盤の設定が不足しています。PRODUCTION_OPERATION_EXECUTOR と GitHub Actions 起動設定を確認してください。';
        } else if (!status.execution_backend_configured) {
            resultEl.textContent = '本番リリース実行基盤の設定が不足しています / 本番データ同期実行基盤の設定が不足しています';
        }
    } catch (error) {
        actionArea.hidden = true;
        statusEl.className = 'text-danger small mb-3';
        statusEl.textContent = '環境管理情報を取得できませんでした';
        resultEl.textContent = String(error?.message || '取得できません');
    }
}
