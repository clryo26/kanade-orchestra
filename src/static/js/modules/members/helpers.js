// Member helpers split from modules/members.js.
// Keep global names for compatibility with legacy non-module loading.

var appState = window.portalRuntimeContext.appState;

function currentUserMember() {
    return appState.members.find((member) => String(member.id || '') === String(appState.currentUserMemberId || '')) || null;
}

function currentUserMemberName() {
    const member = currentUserMember();
    return member ? memberDisplayName(member) : appState.currentUserName || '';
}

function memberDisplayName(member) {
    const last = member?.last_name || '';
    const first = member?.first_name || '';
    const maiden = member?.maiden_name || '';
    const splitName = `${last}${maiden ? `(${maiden})` : ''}${first}`;
    return splitName || member?.name || '';
}

function memberKanaName(member) {
    return `${member?.last_name_kana || ''}${member?.first_name_kana || ''}`;
}

function sortedMembersByPartAndKana(members) {
    return [...(members || [])].sort((a, b) =>
        partSortIndex(a.part) - partSortIndex(b.part)
        || String(a.part || '').localeCompare(String(b.part || ''), 'ja')
        || String(memberKanaName(a) || memberDisplayName(a)).localeCompare(String(memberKanaName(b) || memberDisplayName(b)), 'ja')
        || String(memberDisplayName(a)).localeCompare(String(memberDisplayName(b)), 'ja')
    );
}

function uniqueEventResponses(responses) {
    const byName = new Map();
    responses.forEach((response) => {
        const key = String(response.name || '');
        if (!key) return;
        byName.set(key, response);
    });
    return Array.from(byName.values());
}

function renderGroupedEventResponses(responses) {
    const uniqueResponses = uniqueEventResponses(responses);
    if (!uniqueResponses.length) return '<p class="text-muted">回答はまだありません</p>';
    const groups = ['参加', '不参加'];
    return groups.map((status) => {
        const rows = uniqueResponses.filter((r) => String(r.status || '') === status);
        const body = rows.length
            ? `<div class="list-group">${rows.map((r) => `<div class="list-group-item d-flex justify-content-between align-items-center"><span>${escapeHtml(r.name || '')}</span><span class="badge text-bg-secondary">${escapeHtml(status)}</span></div>`).join('')}</div>`
            : '<p class="text-muted small mb-0">該当者はいません</p>';
        return `<section class="mb-3"><h6>${status}（${rows.length}名）</h6>${body}</section>`;
    }).join('');
}