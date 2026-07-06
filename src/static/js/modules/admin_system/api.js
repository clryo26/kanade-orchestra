// Admin settings API actions split from modules/admin_system.js.
// Keep global names for legacy non-module loading.

var appState = (typeof window.getAppState === 'function')
    ? window.getAppState()
    : window.portalRuntimeContext.appState;
var $ = window.portalRuntimeContext.getById;

async function deleteAuthDevice(deviceId) {
    if (!deviceId) return;
    if (!confirmDelete()) return;
    await request(`/api/auth/devices/${encodeURIComponent(deviceId)}`, { method: 'DELETE' });
    if (deviceId === localStorage.getItem(window.portalRuntimeContext.PORTAL_DEVICE_ID_KEY)) {
        localStorage.removeItem(window.portalRuntimeContext.PORTAL_AUTH_KEY);
        appState.portalAuthVerified = false;
    }
    await loadAuthManagement();
    showAlert('認証端末を削除しました', 'success');
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

async function saveFlyerDistributionSetting() {
    const facility = $('flyerDistributionFacility')?.value.trim() || '';
    const area = $('flyerDistributionArea')?.value.trim() || '';
    const note = $('flyerDistributionNote')?.value.trim() || '';
    if (!facility) {
        showAlert('施設・店舗を入力してください', 'warning');
        return;
    }
    const id = $('flyerDistributionId')?.value || '';
    const duplicate = flyerDistributionSettings().find((item) =>
        String(item.facility_name || '').trim() === facility
        && String(item.area_address || '').trim() === area
        && String(item.id || '') !== String(id)
    );
    if (duplicate) {
        showAlert('同じ配布先が既に登録されています', 'warning');
        return;
    }
    const payload = {
        facility_name: facility,
        area_address: area,
        note,
    };
    if (id) await request(`/api/extra/flyer_distributions/${encodeURIComponent(id)}`, jsonOptions('PUT', payload));
    else await saveExtra('flyer_distributions', payload);
    clearFlyerDistributionForm();
    await loadExtraData();
    renderFlyerDistributionManagement();
    showAlert('チラシ配布先を保存しました', 'success');
}

async function deleteFlyerDistributionSetting(itemId) {
    if (!itemId || !confirmDelete()) return;
    await request(`/api/extra/flyer_distributions/${encodeURIComponent(itemId)}`, { method: 'DELETE' });
    clearFlyerDistributionForm();
    await loadExtraData();
    renderFlyerDistributionManagement();
    showAlert('チラシ配布先を削除しました', 'success');
}

async function deleteSelectedFlyerDistributionSetting() {
    const selectedId = $('flyerDistributionId')?.value || '';
    if (!selectedId) {
        showAlert('削除する配布先を選択してください', 'warning');
        return;
    }
    await deleteFlyerDistributionSetting(selectedId);
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
        membership_fee_amount: integerAmountNumber(current.membership_fee_amount || 0)
    };
    if (current.id) {
        await request(`/api/extra/org_settings/${encodeURIComponent(current.id)}`, jsonOptions('PUT', payload));
    } else {
        await saveExtra('org_settings', payload);
    }
    await loadExtraData();
    showAlert('団体情報を保存しました', 'success');
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
