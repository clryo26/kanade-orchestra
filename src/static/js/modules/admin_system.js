// Frontend split: extracted from main.js.
// Loaded after main.js; functions intentionally remain global for legacy handlers.

function renderAuthDevices() {
    const container = $('authDeviceListItems');
    if (!container) return;
    if (!appState.authDevices.length) {
        container.innerHTML = '<p class="text-muted mb-0">認証済み端末はまだありません</p>';
        return;
    }
    container.innerHTML = `<div class="list-group">${appState.authDevices.map((device) => `
        <div class="list-group-item">
            <div class="d-flex flex-wrap justify-content-between gap-2">
                <span>
                    <strong>${escapeHtml(device.device_name || 'Unknown device')}</strong>
                    <div class="small text-muted">ログイン者: ${escapeHtml(device.member_name || 'Unknown')} / ${escapeHtml(device.member_part || 'パート未設定')}</div>
                    <div class="small text-muted">権限: ${escapeHtml(device.permission || '')}</div>
                    <div class="small text-muted">端末ID: ${escapeHtml(device.device_id || '')}</div>
                    <div class="small text-muted">認証日時: ${escapeHtml(formatDateTimeLabel(device.authenticated_at))}</div>
                    <div class="small text-muted">最終確認: ${escapeHtml(formatDateTimeLabel(device.last_seen_at))}</div>
                    ${device.user_agent ? `<div class="small text-muted text-break">${escapeHtml(device.user_agent)}</div>` : ''}
                </span>
                <span><button class="btn btn-sm btn-outline-danger auth-device-delete-btn" type="button" data-device-id="${escapeHtml(device.device_id || '')}">削除</button></span>
            </div>
        </div>
    `).join('')}</div>`;
    container.querySelectorAll('.auth-device-delete-btn').forEach((button) => {
        button.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', () => deleteAuthDevice(button.dataset.deviceId)));
    });
}

async function deleteAuthDevice(deviceId) {
    if (!deviceId) return;
    if (!confirmDelete()) return;
    await request(`/api/auth/devices/${encodeURIComponent(deviceId)}`, { method: 'DELETE' });
    if (deviceId === localStorage.getItem(PORTAL_DEVICE_ID_KEY)) {
        localStorage.removeItem(PORTAL_AUTH_KEY);
        appState.portalAuthVerified = false;
    }
    await loadAuthManagement();
    showAlert('認証端末を削除しました', 'success');
}

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

function sortedPartSettings() {
    return [...(appState.partSettings || [])].sort((a, b) =>
        Number(a.display_order || 9999) - Number(b.display_order || 9999) ||
        String(a.name || '').localeCompare(String(b.name || ''), 'ja')
    );
}

function currentPartNames() {
    const configured = sortedPartSettings()
        .map((part) => String(part.name || '').trim())
        .filter(Boolean);
    return configured.length ? configured : DEFAULT_MEMBER_PARTS;
}

function partSelectOptionsHtml(selected = '') {
    return ['<option value="">選択してください</option>']
        .concat(currentPartNames().map((part) => `<option value="${escapeHtml(part)}" ${part === selected ? 'selected' : ''}>${escapeHtml(part)}</option>`))
        .join('');
}

function refreshPartSelectOptions() {
    const portalPart = $('portalPartInput');
    if (portalPart) {
        const selected = portalPart.value;
        portalPart.innerHTML = partSelectOptionsHtml(selected);
        if ([...portalPart.options].some((option) => option.value === selected)) portalPart.value = selected;
    }
    const memberPart = $('memberPart');
    if (memberPart) {
        const selected = memberPart.value;
        memberPart.innerHTML = partSelectOptionsHtml(selected);
        if ([...memberPart.options].some((option) => option.value === selected)) memberPart.value = selected;
    }
}

function partMigrationNames() {
    return [...DEFAULT_MEMBER_PARTS, ...appState.members.map((member) => String(member.part || '').trim())]
        .filter((part, index, array) => part && array.indexOf(part) === index);
}

async function ensurePartSettingsMigrated() {
    if ((appState.partSettings || []).length) return;
    const names = partMigrationNames();
    if (!names.length) return;
    for (const [index, name] of names.entries()) {
        await saveExtra('part_settings', { name, display_order: index + 1 });
    }
    await loadExtraData();
}

function renderPartManagement() {
    const list = $('partSettingList');
    if (!list) return;
    const parts = sortedPartSettings();
    list.innerHTML = parts.length
        ? `<div class="list-group">${parts.map((part) => `
            <div class="list-group-item d-flex flex-wrap justify-content-between align-items-center gap-2">
                <div>
                    <strong>${escapeHtml(part.name || '')}</strong>
                </div>
                <div class="d-flex flex-wrap gap-2">
                    <button class="btn btn-sm btn-outline-secondary part-setting-up-btn" type="button" data-part-id="${escapeHtml(String(part.id || ''))}" ${parts.indexOf(part) === 0 ? 'disabled' : ''}>上へ</button>
                    <button class="btn btn-sm btn-outline-secondary part-setting-down-btn" type="button" data-part-id="${escapeHtml(String(part.id || ''))}" ${parts.indexOf(part) === parts.length - 1 ? 'disabled' : ''}>下へ</button>
                    <button class="btn btn-sm btn-outline-primary part-setting-edit-btn" type="button" data-part-id="${escapeHtml(String(part.id || ''))}">編集</button>
                    <button class="btn btn-sm btn-outline-danger part-setting-delete-btn" type="button" data-part-id="${escapeHtml(String(part.id || ''))}">削除</button>
                </div>
            </div>
        `).join('')}</div>`
        : '<div class="alert alert-info mb-0">パート設定を移行中です。表示されない場合は再度システム管理を開いてください。</div>';

    list.querySelectorAll('.part-setting-up-btn').forEach((button) => {
        button.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '移動中...', () => movePartSetting(button.dataset.partId || '', -1)));
    });
    list.querySelectorAll('.part-setting-down-btn').forEach((button) => {
        button.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '移動中...', () => movePartSetting(button.dataset.partId || '', 1)));
    });
    list.querySelectorAll('.part-setting-edit-btn').forEach((button) => {
        button.addEventListener('click', () => selectPartSetting(button.dataset.partId || ''));
    });
    list.querySelectorAll('.part-setting-delete-btn').forEach((button) => {
        button.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', () => deletePartSetting(button.dataset.partId || '')));
    });
}

function selectPartSetting(partId) {
    const part = appState.partSettings.find((item) => String(item.id || '') === String(partId));
    if (!part) return;
    $('partSettingId').value = part.id || '';
    $('partSettingName').value = part.name || '';
}

function clearPartSettingForm() {
    if ($('partSettingId')) $('partSettingId').value = '';
    if ($('partSettingName')) $('partSettingName').value = '';
}

function nextPartDisplayOrder() {
    const maxOrder = Math.max(0, ...appState.partSettings.map((part) => Number(part.display_order || 0)));
    return maxOrder + 1;
}

async function movePartSetting(partId, direction) {
    const parts = sortedPartSettings();
    const index = parts.findIndex((part) => String(part.id || '') === String(partId));
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= parts.length) return;
    const current = parts[index];
    const target = parts[nextIndex];
    await Promise.all([
        request(`/api/extra/part_settings/${encodeURIComponent(current.id)}`, jsonOptions('PUT', {
            ...current,
            display_order: target.display_order || nextIndex + 1
        })),
        request(`/api/extra/part_settings/${encodeURIComponent(target.id)}`, jsonOptions('PUT', {
            ...target,
            display_order: current.display_order || index + 1
        }))
    ]);
    await loadExtraData();
}

async function savePartSetting() {
    const name = $('partSettingName')?.value.trim() || '';
    if (!name) {
        showAlert('パート名を入力してください', 'warning');
        return;
    }
    const duplicate = appState.partSettings.find((part) =>
        String(part.name || '').trim() === name &&
        String(part.id || '') !== String($('partSettingId')?.value || '')
    );
    if (duplicate) {
        showAlert('同じパート名が既に登録されています', 'warning');
        return;
    }
    const id = $('partSettingId')?.value || '';
    const current = appState.partSettings.find((part) => String(part.id || '') === String(id));
    const payload = { name, display_order: current?.display_order || nextPartDisplayOrder() };
    if (id) {
        await request(`/api/extra/part_settings/${encodeURIComponent(id)}`, jsonOptions('PUT', payload));
    } else {
        await saveExtra('part_settings', payload);
    }
    clearPartSettingForm();
    await loadExtraData();
    showAlert('パートを保存しました', 'success');
}

async function deletePartSetting(partId) {
    if (!partId || !confirmDelete()) return;
    await request(`/api/extra/part_settings/${encodeURIComponent(partId)}`, { method: 'DELETE' });
    clearPartSettingForm();
    await loadExtraData();
    showAlert('パートを削除しました', 'success');
}

// ===== DB 閲覧 =====

async function renderDatabaseView() {
    const tableSelect = $('databaseTableSelect');
    const pageSizeSelect = $('databasePageSizeSelect');
    const reloadBtn = $('databaseReloadBtn');
    const prevBtn = $('databasePrevBtn');
    const nextBtn = $('databaseNextBtn');

    if (!tableSelect) return;

    if (pageSizeSelect) {
        pageSizeSelect.value = String(appState.databaseLimit || 50);
        pageSizeSelect.onchange = async () => {
            appState.databaseLimit = Number(pageSizeSelect.value || 50) || 50;
            appState.databaseOffset = 0;
            await loadDatabaseRecords();
        };
    }

    tableSelect.onchange = async () => {
        appState.databaseSelectedTable = tableSelect.value || '';
        appState.databaseOffset = 0;
        await loadDatabaseRecords();
    };

    if (reloadBtn) {
        reloadBtn.onclick = () => withButtonStatus(reloadBtn, '更新中...', () => loadDatabaseTablesAndRecords(true));
    }
    if (prevBtn) {
        prevBtn.onclick = async () => {
            appState.databaseOffset = Math.max(0, appState.databaseOffset - appState.databaseLimit);
            await loadDatabaseRecords();
        };
    }
    if (nextBtn) {
        nextBtn.onclick = async () => {
            appState.databaseOffset += appState.databaseLimit;
            await loadDatabaseRecords();
        };
    }

    try {
        await loadDatabaseTablesAndRecords(false);
    } catch (error) {
        const statusEl = $('databaseStatus');
        if (statusEl) {
            statusEl.hidden = false;
            statusEl.textContent = String(error?.message || 'DB情報の取得に失敗しました');
        }
    }
}

async function loadDatabaseTablesAndRecords(forceReload) {
    const statusEl = $('databaseStatus');
    const tableSelect = $('databaseTableSelect');
    if (!tableSelect) return;

    if (statusEl) {
        statusEl.hidden = false;
        statusEl.textContent = 'テーブル一覧を読み込み中...';
    }

    const tableUrl = forceReload ? `/api/system/database/tables?_t=${Date.now()}` : '/api/system/database/tables';
    const result = await request(tableUrl);
    appState.databaseTables = Array.isArray(result.tables) ? result.tables : [];

    const previous = appState.databaseSelectedTable;
    const selected = appState.databaseTables.includes(previous)
        ? previous
        : (appState.databaseTables[0] || '');
    appState.databaseSelectedTable = selected;

    tableSelect.innerHTML = appState.databaseTables.length
        ? appState.databaseTables.map((name) => `<option value="${escapeHtml(name)}" ${name === selected ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('')
        : '<option value="">テーブルがありません</option>';

    if (!selected) {
        if (statusEl) {
            statusEl.textContent = '表示可能なテーブルがありません。';
        }
        clearDatabaseRows();
        return;
    }

    appState.databaseOffset = 0;
    await loadDatabaseRecords(forceReload);
}

function clearDatabaseRows() {
    const head = document.querySelector('#databaseRecordsTable thead');
    const body = document.querySelector('#databaseRecordsTable tbody');
    if (head) head.innerHTML = '';
    if (body) body.innerHTML = '<tr><td class="text-muted">データがありません</td></tr>';
    const prevBtn = $('databasePrevBtn');
    const nextBtn = $('databaseNextBtn');
    if (prevBtn) prevBtn.disabled = true;
    if (nextBtn) nextBtn.disabled = true;
}

async function loadDatabaseRecords(forceReload = false) {
    const statusEl = $('databaseStatus');
    const tableName = appState.databaseSelectedTable;
    if (!tableName) {
        clearDatabaseRows();
        return;
    }

    if (statusEl) {
        statusEl.hidden = false;
        statusEl.textContent = `テーブル ${tableName} を読み込み中...`;
    }

    const query = new URLSearchParams({
        table: tableName,
        limit: String(appState.databaseLimit),
        offset: String(appState.databaseOffset),
    }).toString();
    const recordUrl = forceReload
        ? `/api/system/database/records?${query}&_t=${Date.now()}`
        : `/api/system/database/records?${query}`;
    const result = await request(recordUrl);

    appState.databaseTotal = Number(result.total || 0);
    renderDatabaseRows(result.columns || [], result.rows || []);

    const from = appState.databaseTotal === 0 ? 0 : appState.databaseOffset + 1;
    const to = Math.min(appState.databaseOffset + appState.databaseLimit, appState.databaseTotal);
    if (statusEl) {
        statusEl.textContent = `${tableName}: ${from}-${to} / ${appState.databaseTotal} 件`;
    }

    const prevBtn = $('databasePrevBtn');
    const nextBtn = $('databaseNextBtn');
    if (prevBtn) prevBtn.disabled = appState.databaseOffset <= 0;
    if (nextBtn) nextBtn.disabled = (appState.databaseOffset + appState.databaseLimit) >= appState.databaseTotal;
}

function formatDatabaseCell(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
}

function renderDatabaseRows(columns, rows) {
    const head = document.querySelector('#databaseRecordsTable thead');
    const body = document.querySelector('#databaseRecordsTable tbody');
    if (!head || !body) return;

    if (!columns.length) {
        head.innerHTML = '';
        body.innerHTML = '<tr><td class="text-muted">列情報が取得できませんでした</td></tr>';
        return;
    }

    head.innerHTML = `<tr>${columns.map((column) => `<th class="text-nowrap">${escapeHtml(column)}</th>`).join('')}</tr>`;
    if (!rows.length) {
        body.innerHTML = `<tr><td class="text-muted" colspan="${columns.length}">レコードがありません</td></tr>`;
        return;
    }

    body.innerHTML = rows.map((row) => {
        const cells = columns.map((column) => {
            const value = formatDatabaseCell(row[column]);
            return `<td class="small">${escapeHtml(value)}</td>`;
        }).join('');
        return `<tr>${cells}</tr>`;
    }).join('');
}

function sortedVenueSettings() {
    return [...(appState.venueSettings || [])].sort((a, b) =>
        String(a.name || '').localeCompare(String(b.name || ''), 'ja')
    );
}

function venueSettingsFor(kind) {
    return sortedVenueSettings().filter((venue) => {
        if (kind === 'performance') return venue.for_performance !== false;
        if (kind === 'practice') return venue.for_practice !== false;
        return true;
    });
}

function venueSelectOptionsHtml(kind, selected = '') {
    const normalizedSelected = String(selected || '');
    const venues = venueSettingsFor(kind);
    const options = ['<option value="">選択してください</option>'];
    options.push(...venues.map((venue) => {
        const name = String(venue.name || '');
        return `<option value="${escapeHtml(name)}" ${name === normalizedSelected ? 'selected' : ''}>${escapeHtml(name)}</option>`;
    }));
    if (normalizedSelected && !venues.some((venue) => String(venue.name || '') === normalizedSelected)) {
        options.push(`<option value="${escapeHtml(normalizedSelected)}" selected>${escapeHtml(normalizedSelected)}（未登録会場）</option>`);
    }
    return options.join('');
}

function refreshVenueOptions() {
    const performanceSelect = $('perfVenue');
    if (performanceSelect) {
        performanceSelect.innerHTML = venueSelectOptionsHtml('performance', performanceSelect.value);
    }
    const practiceSelect = $('schedVenue');
    if (practiceSelect) {
        practiceSelect.innerHTML = venueSelectOptionsHtml('practice', practiceSelect.value);
    }
}

function venueInputId(kind) {
    return kind === 'performance' ? 'venuePerformanceName' : 'venuePracticeName';
}

function renderVenueManagement() {
    renderVenueListByType('performance', 'venuePerformanceList');
    renderVenueListByType('practice', 'venuePracticeList');
}

function renderVenueListByType(kind, listId) {
    const list = $(listId);
    if (!list) return;
    const venues = venueSettingsFor(kind);
    list.innerHTML = venues.length
        ? `<div class="list-group">${venues.map((venue) => `
            <div class="list-group-item d-flex flex-wrap justify-content-between align-items-center gap-2">
                <strong>${escapeHtml(venue.name || '')}</strong>
                <span class="d-flex gap-2">
                    <button class="btn btn-sm btn-outline-primary venue-setting-edit-btn" type="button" data-venue-type="${kind}" data-venue-id="${escapeHtml(String(venue.id || ''))}">編集</button>
                    <button class="btn btn-sm btn-outline-danger venue-setting-delete-btn" type="button" data-venue-id="${escapeHtml(String(venue.id || ''))}">削除</button>
                </span>
            </div>
        `).join('')}</div>`
        : '<p class="text-muted mb-0">会場はまだ登録されていません</p>';
    list.querySelectorAll('.venue-setting-edit-btn').forEach((button) => {
        button.addEventListener('click', () => selectVenueSetting(button.dataset.venueId || '', button.dataset.venueType || kind));
    });
    list.querySelectorAll('.venue-setting-delete-btn').forEach((button) => {
        button.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', () => deleteVenueSetting(button.dataset.venueId || '')));
    });
}

function selectVenueSetting(venueId, kind = '') {
    const venue = appState.venueSettings.find((item) => String(item.id || '') === String(venueId));
    if (!venue) return;
    const type = kind || (venue.for_performance ? 'performance' : 'practice');
    if ($('venueSettingId')) $('venueSettingId').value = venue.id || '';
    if ($('venueUsageType')) $('venueUsageType').value = type;
    const input = $(venueInputId(type));
    if (input) input.value = venue.name || '';
}

function clearVenueSettingForm(kind = '') {
    if ($('venueSettingId')) $('venueSettingId').value = '';
    if (kind) {
        const input = $(venueInputId(kind));
        if (input) input.value = '';
        if ($('venueUsageType')) $('venueUsageType').value = kind;
        return;
    }
    if ($('venuePerformanceName')) $('venuePerformanceName').value = '';
    if ($('venuePracticeName')) $('venuePracticeName').value = '';
    if ($('venueUsageType')) $('venueUsageType').value = 'performance';
}

async function saveVenueSetting(kind = 'practice') {
    const input = $(venueInputId(kind));
    const name = input?.value.trim() || '';
    if (!name) {
        showAlert('会場名を入力してください', 'warning');
        return;
    }
    const forPractice = kind === 'practice';
    const forPerformance = kind === 'performance';
    const id = $('venueUsageType')?.value === kind ? ($('venueSettingId')?.value || '') : '';
    const duplicate = appState.venueSettings.find((venue) =>
        String(venue.name || '').trim() === name &&
        String(venue.id || '') !== String(id)
    );
    if (duplicate) {
        showAlert('同じ会場名が既に登録されています', 'warning');
        return;
    }
    const payload = { name, for_practice: forPractice, for_performance: forPerformance, note: '' };
    if (id) await request(`/api/extra/venue_settings/${encodeURIComponent(id)}`, jsonOptions('PUT', payload));
    else await saveExtra('venue_settings', payload);
    clearVenueSettingForm(kind);
    await loadExtraData();
    showAlert('会場を保存しました', 'success');
}

async function deleteVenueSetting(venueId) {
    if (!venueId || !confirmDelete()) return;
    await request(`/api/extra/venue_settings/${encodeURIComponent(venueId)}`, { method: 'DELETE' });
    clearVenueSettingForm();
    await loadExtraData();
    showAlert('会場を削除しました', 'success');
}

function currentOrgSetting() {
    return (appState.orgSettings || [])[0] || {};
}

function orgShortName() {
    const org = currentOrgSetting();
    return String(
        org.short_name
        || org.shortName
        || org.abbreviation
        || org.short
        || org.organization_abbreviation
        || org.organizationAbbreviation
        || org.name
        || org.organization_name
        || org.organizationName
        || org.organization_name_full
        || org.organizationNameFull
        || '楽団'
    ).trim() || '楽団';
}

function portalTitleText() {
    return `${orgShortName()}ポータル`;
}

function applyOrgSettings() {
    const org = currentOrgSetting();
    const title = portalTitleText();
    document.title = title;
    const titleElement = document.querySelector('title');
    if (titleElement) titleElement.textContent = title;
    document.querySelectorAll('meta[name="application-name"], meta[name="apple-mobile-web-app-title"]').forEach((meta) => {
        meta.setAttribute('content', title);
    });
    if ($('portalBrandTitle')) $('portalBrandTitle').textContent = title;
    if ($('portalLoginTitle')) $('portalLoginTitle').textContent = title;
    const iconUrl = org.icon_url || org.iconUrl || '';
    if (iconUrl) {
        document.querySelectorAll('link[rel="icon"], link[rel="apple-touch-icon"]').forEach((link) => {
            link.href = iconUrl;
        });
        if ($('portalLogo')) $('portalLogo').src = iconUrl;
        if ($('orgIconPreview')) $('orgIconPreview').src = iconUrl;
    }
    const logo = $('portalLogo');
    if (logo) logo.alt = orgShortName();
    applyDynamicManifest(title, title, org.icon_url || org.iconUrl || '');
}

function applyDynamicManifest(name, shortName, iconUrl = '') {
    const manifestLink = document.querySelector('link[rel="manifest"]');
    if (!manifestLink) return;
    const icons = [
        { src: iconUrl || '/static/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: iconUrl || '/static/icons/icon-512.png', sizes: '512x512', type: 'image/png' }
    ];
    const manifest = {
        name,
        short_name: shortName,
        start_url: '/',
        display: 'standalone',
        background_color: '#ffffff',
        theme_color: '#235789',
        icons
    };
    if (appState.manifestObjectUrl) {
        URL.revokeObjectURL(appState.manifestObjectUrl);
    }
    appState.manifestObjectUrl = URL.createObjectURL(new Blob([JSON.stringify(manifest)], { type: 'application/manifest+json' }));
    manifestLink.href = appState.manifestObjectUrl;
}

function updateCloudRunRevision() {
    // Google Cloud Run のリビジョン情報をUI に反映
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

function renderOrgManagement() {
    const org = currentOrgSetting();
    if ($('orgSettingId')) $('orgSettingId').value = org.id || '';
    if ($('orgName')) $('orgName').value = org.name || org.organization_name || org.organization_name_full || '';
    if ($('orgShortName')) $('orgShortName').value = org.short_name || org.shortName || org.organization_abbreviation || '';
    if ($('orgIconFile')) $('orgIconFile').value = '';
    if ($('orgIconPreview')) $('orgIconPreview').src = org.icon_url || org.iconUrl || '/static/icons/icon-192.png';
}

async function previewOrgIcon() {
    const file = $('orgIconFile')?.files?.[0];
    if (!file || !$('orgIconPreview')) return;
    $('orgIconPreview').src = await fileToDataUrl(file);
}

function clearOrgSettingForm() {
    if ($('orgSettingId')) $('orgSettingId').value = currentOrgSetting().id || '';
    if ($('orgName')) $('orgName').value = '';
    if ($('orgShortName')) $('orgShortName').value = '';
    if ($('orgIconFile')) $('orgIconFile').value = '';
    if ($('orgIconPreview')) $('orgIconPreview').src = currentOrgSetting().icon_url || '/static/icons/icon-192.png';
}

async function saveOrgSetting() {
    const current = currentOrgSetting();
    const name = $('orgName')?.value.trim() || '';
    const shortName = $('orgShortName')?.value.trim() || '';
    if (!name || !shortName) {
        showAlert('団体名と略称を入力してください', 'warning');
        return;
    }
    const iconFile = $('orgIconFile')?.files?.[0];
    const iconUrl = iconFile ? await fileToDataUrl(iconFile) : (current.icon_url || current.iconUrl || '');
    const payload = {
        name,
        organization_name: name,
        organization_abbreviation: shortName,
        short_name: shortName,
        icon_url: iconUrl,
        membership_fee_amount: Number(current.membership_fee_amount || 0)
    };
    if (current.id) {
        await request(`/api/extra/org_settings/${encodeURIComponent(current.id)}`, jsonOptions('PUT', payload));
    } else {
        await saveExtra('org_settings', payload);
    }
    await loadExtraData();
    showAlert('団体情報を保存しました', 'success');
}

// currentSnsSetting moved to feature module.

// renderSnsManagement moved to feature module.

// clearSnsSettingForm moved to feature module.

// saveSnsSetting moved to feature module.

function currentConnectionSetting() {
    return (appState.connectionSettings || [])[0] || {};
}

function renderConnectionSettingsManagement() {
    const current = currentConnectionSetting();
    if ($('connectionSettingId')) $('connectionSettingId').value = current.id || '';
    if ($('connectionGoogleProjectId')) $('connectionGoogleProjectId').value = current.google_project_id || '';
    if ($('connectionBucketName')) $('connectionBucketName').value = current.google_cloud_storage_bucket || '';
    if ($('connectionDataPrefix')) $('connectionDataPrefix').value = current.google_cloud_storage_data_prefix || 'app-data';
    if ($('connectionPublicFlag')) $('connectionPublicFlag').checked = String(current.google_cloud_storage_public || '').toLowerCase() === 'true';
    if ($('connectionServiceAccountFile')) $('connectionServiceAccountFile').value = current.google_service_account_file || '';
    if ($('connectionServiceAccountJson')) $('connectionServiceAccountJson').value = current.google_service_account_json || '';
}

function clearConnectionSettingForm() {
    if ($('connectionGoogleProjectId')) $('connectionGoogleProjectId').value = '';
    if ($('connectionBucketName')) $('connectionBucketName').value = '';
    if ($('connectionDataPrefix')) $('connectionDataPrefix').value = 'app-data';
    if ($('connectionPublicFlag')) $('connectionPublicFlag').checked = false;
    if ($('connectionServiceAccountFile')) $('connectionServiceAccountFile').value = '';
    if ($('connectionServiceAccountJson')) $('connectionServiceAccountJson').value = '';
}

async function saveConnectionSetting() {
    const current = currentConnectionSetting();
    const bucket = $('connectionBucketName')?.value.trim() || '';
    if (!bucket) {
        showAlert('GCSバケット名を入力してください', 'warning');
        return;
    }

    const payload = {
        google_project_id: $('connectionGoogleProjectId')?.value.trim() || '',
        google_cloud_storage_bucket: bucket,
        google_cloud_storage_data_prefix: $('connectionDataPrefix')?.value.trim() || 'app-data',
        google_cloud_storage_public: $('connectionPublicFlag')?.checked ? 'true' : 'false',
        google_service_account_file: $('connectionServiceAccountFile')?.value.trim() || '',
        google_service_account_json: $('connectionServiceAccountJson')?.value.trim() || ''
    };

    if (current.id) {
        await request(`/api/extra/connection_settings/${encodeURIComponent(current.id)}`, jsonOptions('PUT', payload));
    } else {
        await saveExtra('connection_settings', payload);
    }
    await loadExtraData();
    showAlert('接続先情報を保存しました', 'success');
}

// renderSnsView moved to feature module.
