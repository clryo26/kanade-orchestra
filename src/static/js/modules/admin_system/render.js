// Admin render helpers split from modules/admin_system.js.
// Keep global names for legacy non-module loading.

var appState = (typeof window.getAppState === 'function')
    ? window.getAppState()
    : window.portalRuntimeContext.appState;
var $ = window.portalRuntimeContext.getById;

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

function renderVenueManagement() {
    renderVenueListByType('performance', 'venuePerformanceList');
    renderVenueListByType('practice', 'venuePracticeList');
}

function flyerDistributionSettings() {
    return [...(appState.flyerDistributions || [])].sort((a, b) =>
        String(a.facility_name || '').localeCompare(String(b.facility_name || ''), 'ja')
        || String(a.area_address || '').localeCompare(String(b.area_address || ''), 'ja')
    );
}

function renderFlyerDistributionManagement() {
    const list = $('flyerDistributionAdminList');
    if (!list) return;
    const distributions = flyerDistributionSettings();
    list.innerHTML = distributions.length
        ? `<div class="list-group">${distributions.map((item) => `
            <div class="list-group-item d-flex flex-wrap justify-content-between align-items-start gap-2">
                <div>
                    <strong>${escapeHtml(item.facility_name || '')}</strong>
                    <div class="small text-muted">${escapeHtml(item.area_address || '')}</div>
                    ${String(item.note || '').trim() ? `<div class="small">備考: ${escapeHtml(String(item.note || '').trim())}</div>` : ''}
                </div>
                <span class="d-flex gap-2">
                    <button class="btn btn-sm btn-outline-primary flyer-distribution-edit-btn" type="button" data-id="${escapeHtml(String(item.id || ''))}">編集</button>
                    <button class="btn btn-sm btn-outline-danger flyer-distribution-delete-btn" type="button" data-id="${escapeHtml(String(item.id || ''))}">削除</button>
                </span>
            </div>
        `).join('')}</div>`
        : '<p class="text-muted mb-0">配布先はまだ登録されていません</p>';

    list.querySelectorAll('.flyer-distribution-edit-btn').forEach((button) => {
        button.addEventListener('click', () => selectFlyerDistributionSetting(button.dataset.id || ''));
    });
    list.querySelectorAll('.flyer-distribution-delete-btn').forEach((button) => {
        button.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', () => deleteFlyerDistributionSetting(button.dataset.id || '')));
    });
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

function selectFlyerDistributionSetting(itemId) {
    const item = flyerDistributionSettings().find((entry) => String(entry.id || '') === String(itemId));
    if (!item) return;
    if ($('flyerDistributionId')) $('flyerDistributionId').value = item.id || '';
    if ($('flyerDistributionFacility')) $('flyerDistributionFacility').value = item.facility_name || '';
    if ($('flyerDistributionArea')) $('flyerDistributionArea').value = item.area_address || '';
    if ($('flyerDistributionNote')) $('flyerDistributionNote').value = item.note || '';
    updateFlyerDistributionDeleteButtonState();
}

function clearFlyerDistributionForm() {
    if ($('flyerDistributionId')) $('flyerDistributionId').value = '';
    if ($('flyerDistributionFacility')) $('flyerDistributionFacility').value = '';
    if ($('flyerDistributionArea')) $('flyerDistributionArea').value = '';
    if ($('flyerDistributionNote')) $('flyerDistributionNote').value = '';
    updateFlyerDistributionDeleteButtonState();
}

function updateFlyerDistributionDeleteButtonState() {
    const deleteBtn = $('deleteFlyerDistributionBtn');
    if (!deleteBtn) return;
    const selectedId = $('flyerDistributionId')?.value || '';
    deleteBtn.disabled = !selectedId;
}

function clearConnectionSettingForm() {
    if ($('connectionGoogleProjectId')) $('connectionGoogleProjectId').value = '';
    if ($('connectionBucketName')) $('connectionBucketName').value = '';
    if ($('connectionDataPrefix')) $('connectionDataPrefix').value = 'app-data';
    if ($('connectionPublicFlag')) $('connectionPublicFlag').checked = false;
    if ($('connectionServiceAccountFile')) $('connectionServiceAccountFile').value = '';
    if ($('connectionServiceAccountJson')) $('connectionServiceAccountJson').value = '';
}
