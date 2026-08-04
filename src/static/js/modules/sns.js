// This file was split from main.js during frontend refactor.
// It depends on shared globals declared in main.js (appState, $, request, helpers).

var appState = window.portalRuntimeContext.appState;
var $ = window.portalRuntimeContext.getById;

function currentSnsSetting() {
    return (appState.snsSettings || [])[0] || {};
}


function renderSnsManagement() {
    const sns = currentSnsSetting();
    if ($('snsSettingId')) $('snsSettingId').value = sns.id || '';
    if ($('snsFacebookUrl')) $('snsFacebookUrl').value = sns.facebook_url || '';
    if ($('snsInstagramUrl')) $('snsInstagramUrl').value = sns.instagram_url || '';
    if ($('snsXUrl')) $('snsXUrl').value = sns.x_url || '';
    if ($('snsYoutubeUrl')) $('snsYoutubeUrl').value = sns.youtube_url || '';
}


function clearSnsSettingForm() {
    if ($('snsFacebookUrl')) $('snsFacebookUrl').value = '';
    if ($('snsInstagramUrl')) $('snsInstagramUrl').value = '';
    if ($('snsXUrl')) $('snsXUrl').value = '';
    if ($('snsYoutubeUrl')) $('snsYoutubeUrl').value = '';
}


async function saveSnsSetting() {
    const current = currentSnsSetting();
    const payload = {
        facebook_url: $('snsFacebookUrl')?.value.trim() || '',
        instagram_url: $('snsInstagramUrl')?.value.trim() || '',
        x_url: $('snsXUrl')?.value.trim() || '',
        youtube_url: $('snsYoutubeUrl')?.value.trim() || ''
    };
    if (current.id) {
        await request(`/api/extra/sns_settings/${encodeURIComponent(current.id)}`, jsonOptions('PUT', payload));
    } else {
        await saveExtra('sns_settings', payload);
    }
    await loadExtraData(['snsSettings']);
    showAlert('SNS情報を保存しました', 'success');
}


function renderSnsView() {
    const container = $('memberSnsInfo');
    if (!container) return;
    const sns = currentSnsSetting();
    const links = [
        { label: 'Facebook', url: sns.facebook_url },
        { label: 'Instagram', url: sns.instagram_url },
        { label: 'X', url: sns.x_url }
    ];
    container.innerHTML = `
        <div class="d-flex flex-wrap gap-2">
            ${links.map((item) => item.url
                ? `<a class="btn btn-outline-primary btn-lg sns-link-button" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.label)}</a>`
                : `<button class="btn btn-outline-secondary btn-lg sns-link-button" type="button" disabled>${escapeHtml(item.label)}</button>`
            ).join('')}
        </div>
    `;
}
