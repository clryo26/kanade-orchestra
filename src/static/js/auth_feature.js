// 認証 UI と端末認証のクライアント側処理を app.js から分離したモジュール。

var appState = window.portalRuntimeContext.appState;
var $ = window.portalRuntimeContext.getById;

function portalDeviceName() {
    const platform = navigator.platform || 'unknown';
    const language = navigator.language || '';
    return `${platform}${language ? ` / ${language}` : ''}`;
}

function portalDeviceId() {
    let deviceId = localStorage.getItem(window.portalRuntimeContext.PORTAL_DEVICE_ID_KEY);
    if (!deviceId) {
        deviceId = window.crypto?.randomUUID ? window.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        localStorage.setItem(window.portalRuntimeContext.PORTAL_DEVICE_ID_KEY, deviceId);
    }
    return deviceId;
}

function normalizePortalPassword(value) {
    return String(value || '').normalize('NFKC').replace(/[\u200b-\u200d\u2060\ufeff]/g, '').trim();
}

function normalizePortalPasswordInput(input) {
    if (!input) return '';
    const normalized = normalizePortalPassword(input.value);
    if (input.value !== normalized) input.value = normalized;
    return normalized;
}

function bindPortalPasswordNormalization(input) {
    if (!input) return;
    input.setAttribute('inputmode', 'latin');
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('spellcheck', 'false');
    input.addEventListener('input', () => normalizePortalPasswordInput(input));
    input.addEventListener('blur', () => normalizePortalPasswordInput(input));
}

async function isPortalAuthenticated() {
    if (appState.portalAuthVerified) return true;
    const deviceId = localStorage.getItem(window.portalRuntimeContext.PORTAL_DEVICE_ID_KEY);
    if (!deviceId || localStorage.getItem(window.portalRuntimeContext.PORTAL_AUTH_KEY) !== 'true') return false;
    try {
        const result = await request(`/api/auth/devices/${encodeURIComponent(deviceId)}`);
        appState.portalAuthVerified = Boolean(result.authenticated);
        appState.currentUserMemberId = result.device?.member_id ?? null;
        appState.currentUserName = result.device?.member_name || '';
        appState.currentUserPermission = result.device?.permission || '';
        appState.currentUserPart = result.device?.member_part || '';
        appState.currentUserIsRecordingManager = Boolean(result.device?.is_recording_manager);
        appState.currentUserIsSheetManager = Boolean(result.device?.is_sheet_manager);
        return appState.portalAuthVerified;
    } catch {
        return false;
    }
}

function showPortalLogin() {
    closePortalDrawer();
    if ($('portalDrawerToggle')) $('portalDrawerToggle').hidden = true;
    $('adminPanel').hidden = true;
    $('memberPanel').hidden = true;
    if ($('systemPanel')) $('systemPanel').hidden = true;
    let loginPanel = $('portalLoginPanel');
    if (!loginPanel) {
        const main = document.querySelector('main');
        main.insertAdjacentHTML('afterbegin', `
            <section id="portalLoginPanel" class="panel portal-login-panel">
                <div class="portal-login-box">
                    <div id="portalLoginForm">
                        <h1 id="portalLoginTitle">${escapeHtml(portalTitleText())}</h1>
                        <label class="form-label" for="portalNameInput">名前</label>
                        <input class="form-control" id="portalNameInput" type="text" autocomplete="name" placeholder="漢字またはふりがな">
                        <label class="form-label mt-3" for="portalPartInput">パート</label>
                        <select class="form-select" id="portalPartInput"></select>
                        <label class="form-label mt-3" for="portalPasswordInput">パスワード</label>
                        <input class="form-control" id="portalPasswordInput" type="password" autocomplete="current-password" inputmode="latin" autocapitalize="off" autocorrect="off" spellcheck="false">
                        <button class="btn btn-primary w-100 mt-3" id="portalLoginBtn" type="button">ログイン</button>
                        <div class="portal-login-actions mt-3">
                            <button class="btn btn-outline-success btn-sm" id="portalLoginReloadBtn" type="button">更新</button>
                            <span class="revision-inline">Rev. <span data-revision-number>${escapeHtml(currentRevisionText())}</span></span>
                        </div>
                    </div>
                    <div id="portalPasswordSetupForm" hidden>
                        <h1>パスワード登録</h1>
                        <p class="text-muted small mb-3">団員情報に名前が見つかりました。個人用パスワードを登録してください。</p>
                        <input type="hidden" id="portalSetupName">
                        <input type="hidden" id="portalSetupPart">
                        <label class="form-label" for="portalNewPasswordInput">新しいパスワード</label>
                        <input class="form-control" id="portalNewPasswordInput" type="password" autocomplete="new-password" inputmode="latin" autocapitalize="off" autocorrect="off" spellcheck="false">
                        <label class="form-label mt-3" for="portalNewPasswordConfirmInput">新しいパスワード（確認）</label>
                        <input class="form-control" id="portalNewPasswordConfirmInput" type="password" autocomplete="new-password" inputmode="latin" autocapitalize="off" autocorrect="off" spellcheck="false">
                        <button class="btn btn-primary w-100 mt-3" id="portalPasswordSetupBtn" type="button">登録</button>
                        <button class="btn btn-outline-secondary w-100 mt-2" id="portalBackToLoginBtn" type="button">ログインに戻る</button>
                    </div>
                </div>
            </section>
        `);
        loginPanel = $('portalLoginPanel');
        refreshPartSelectOptions();
        applyOrgSettings();
        updateCloudRunRevision();
        $('portalLoginBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '確認中...', handlePortalLogin));
        $('portalLoginReloadBtn').addEventListener('click', () => {
            setLoadingBar('更新中...');
            window.location.reload();
        });
        $('portalPasswordSetupBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '登録中...', handleMemberPasswordSetup));
        $('portalBackToLoginBtn').addEventListener('click', showPortalLoginForm);
        ['portalPasswordInput', 'portalNewPasswordInput', 'portalNewPasswordConfirmInput'].forEach((id) => bindPortalPasswordNormalization($(id)));
        ['portalNameInput', 'portalPasswordInput'].forEach((id) => $(id).addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                $('portalLoginBtn').click();
            }
        }));
        ['portalNewPasswordInput', 'portalNewPasswordConfirmInput'].forEach((id) => $(id).addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                $('portalPasswordSetupBtn').click();
            }
        }));
    }
    loginPanel.hidden = false;
    showPortalLoginForm();
}

async function handlePortalLogin() {
    const nameInput = $('portalNameInput');
    const partInput = $('portalPartInput');
    const passwordInput = $('portalPasswordInput');
    if (!nameInput || !partInput || !passwordInput) return;
    const name = nameInput.value.trim();
    const part = partInput.value;
    // hidden admin は大文字小文字・全角半角の揺れを吸収して判定する。
    const normalizedName = String(name || '').normalize('NFKC').replace(/[\u200b-\u200d\u2060\ufeff\s\u3000]+/g, '').toLowerCase();
    const isHiddenAdmin = normalizedName === 'administrator';
    const password = normalizePortalPasswordInput(passwordInput);
    if (!name || !password || (!isHiddenAdmin && !part)) {
        showAlert('名前、パート、パスワードを入力してください', 'warning');
        return;
    }
    const response = await fetch('/api/auth/portal-login', jsonOptions('POST', {
        name,
        part,
        password,
        device_id: portalDeviceId(),
        device_name: portalDeviceName(),
        user_agent: navigator.userAgent || ''
    }));
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
        const detail = typeof result === 'object' && result.detail ? String(result.detail) : '';
        const message = detail || (response.status === 404 ? '該当する団員が見つかりません' : '名前またはパスワードが違います');
        showAlert(message, 'danger');
        passwordInput.value = '';
        return;
    }
    if (result.needs_password_setup) {
        showMemberPasswordSetup(name, part);
        return;
    }
    appState.currentUserPermission = result.permission || '';
    appState.currentUserMemberId = result.member_id ?? null;
    appState.currentUserName = result.member_name || '';
    appState.currentUserPart = result.member_part || part || '';
    appState.currentUserIsRecordingManager = Boolean(result.is_recording_manager);
    appState.currentUserIsSheetManager = Boolean(result.is_sheet_manager);
    localStorage.setItem(window.portalRuntimeContext.PORTAL_AUTH_KEY, 'true');
    appState.portalAuthVerified = true;
    await enterPortal();
}

function showPortalLoginForm() {
    if ($('portalLoginForm')) $('portalLoginForm').hidden = false;
    if ($('portalPasswordSetupForm')) $('portalPasswordSetupForm').hidden = true;
    if ($('portalPasswordInput')) $('portalPasswordInput').value = '';
    if ($('portalPartInput')) $('portalPartInput').value = '';
    $('portalNameInput')?.focus();
}

function showMemberPasswordSetup(name, part = '') {
    if ($('portalLoginForm')) $('portalLoginForm').hidden = true;
    if ($('portalPasswordSetupForm')) $('portalPasswordSetupForm').hidden = false;
    if ($('portalSetupName')) $('portalSetupName').value = name;
    if ($('portalSetupPart')) $('portalSetupPart').value = part;
    if ($('portalNewPasswordInput')) $('portalNewPasswordInput').value = '';
    if ($('portalNewPasswordConfirmInput')) $('portalNewPasswordConfirmInput').value = '';
    $('portalNewPasswordInput')?.focus();
}

async function handleMemberPasswordSetup() {
    const name = $('portalSetupName')?.value || $('portalNameInput')?.value.trim() || '';
    const part = $('portalSetupPart')?.value || $('portalPartInput')?.value || '';
    const password = normalizePortalPasswordInput($('portalNewPasswordInput'));
    const confirmPassword = normalizePortalPasswordInput($('portalNewPasswordConfirmInput'));
    if (!password) {
        showAlert('新しいパスワードを入力してください', 'warning');
        return;
    }
    if (password !== confirmPassword) {
        showAlert('確認用パスワードが一致しません', 'warning');
        return;
    }
    await request('/api/auth/member-password', jsonOptions('POST', { name, part, password }));
    showAlert('パスワードを登録しました。もう一度ログインしてください', 'success');
    showPortalLoginForm();
}

function logoutPortal() {
    localStorage.removeItem(window.portalRuntimeContext.PORTAL_AUTH_KEY);
    localStorage.removeItem('userRole');
    appState.portalAuthVerified = false;
    appState.currentUserMemberId = null;
    appState.currentUserName = '';
    appState.currentUserPermission = '';
    appState.currentUserPart = '';
    appState.currentUserIsRecordingManager = false;
    appState.currentUserIsSheetManager = false;
    closePortalDrawer();
    showPortalLogin();
}
