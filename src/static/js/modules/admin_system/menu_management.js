// Changes apply only after the system-admin API has committed the full form.
var $ = window.portalRuntimeContext.getById;
var menuManagementSaving = false;

function renderMenuManagementForm(data) {
    const list = $('systemMenuManagementList');
    // Optional features are editable only when declared, even if currently OFF.
    const declared = new Set(portalMenuGroups({ includeHidden: true }).flatMap((group) => group.items.map((item) => item.key)));
    const groups = (data.groups || []).map((group) => ({ ...group,
        items: group.items.filter((item) => !(data.optional_keys || []).includes(item.key) || declared.has(item.key)),
    })).filter((group) => group.items.length);
    list.innerHTML = groups.map((group) => `
        <fieldset class="mb-3">
            <legend class="fs-6">${escapeHtml(group.title)}</legend>
            ${group.items.map((item) => `
                <div class="form-check form-switch mb-2">
                    <input class="form-check-input" type="checkbox" role="switch"
                        id="menu-visible-${escapeHtml(item.key)}" data-menu-key="${escapeHtml(item.key)}"
                        ${data.visibility?.[item.key] !== false ? 'checked' : ''}>
                    <label class="form-check-label" for="menu-visible-${escapeHtml(item.key)}">${escapeHtml(item.label)}</label>
                </div>
            `).join('')}
        </fieldset>
    `).join('');
}

async function renderSystemMenuManagement() {
    if (menuManagementSaving) return;
    const status = $('systemMenuManagementStatus');
    const button = $('systemMenuManagementSaveBtn');
    button.disabled = true;
    status.textContent = '読み込み中...';
    $('systemMenuManagementList').innerHTML = '';
    button.onclick = saveSystemMenuSettings;
    try {
        // Management must not silently fall back to an old cached form.
        const data = await request('/api/system/menu-settings', {
            _forceRevalidate: true, _allowCacheFallback: false,
        });
        renderMenuManagementForm(data);
        applyPortalMenuVisibility(data.visibility);
        status.textContent = '変更後、一括保存してください。';
        button.disabled = false;
    } catch (error) {
        status.textContent = error.message || 'メニュー設定を取得できませんでした。';
    }
}

async function saveSystemMenuSettings() {
    if (menuManagementSaving) return;
    const button = $('systemMenuManagementSaveBtn');
    const status = $('systemMenuManagementStatus');
    const switches = [...$('systemMenuManagementList').querySelectorAll('[data-menu-key]')];
    const visibility = Object.fromEntries(switches.map((input) => [input.dataset.menuKey, input.checked]));
    menuManagementSaving = true;
    button.disabled = true;
    switches.forEach((input) => { input.disabled = true; });
    status.textContent = '保存中...';
    try {
        const data = await request('/api/system/menu-settings', {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ visibility }),
        });
        // request() invalidates bootstrap IndexedDB entries on successful writes.
        applyPortalMenuVisibility(data.visibility);
        renderMenuManagementForm(data);
        status.textContent = '保存しました。';
        showAlert('メニュー表示設定を保存しました', 'success');
    } catch (error) {
        // Keep the draft for retry; never apply failed edits to the live menus.
        status.textContent = error.message || '保存できませんでした。再試行してください。';
    } finally {
        menuManagementSaving = false;
        button.disabled = false;
        switches.forEach((input) => { input.disabled = false; });
    }
}
