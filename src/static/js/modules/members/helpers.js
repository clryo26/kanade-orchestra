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

function _memberDetailStateMaps() {
    if (!appState.memberDetailRecords) appState.memberDetailRecords = {};
    if (!appState.memberDetailLoadStates) appState.memberDetailLoadStates = {};
    if (!appState.memberDetailLoadPromises) appState.memberDetailLoadPromises = {};
    return {
        records: appState.memberDetailRecords,
        states: appState.memberDetailLoadStates,
        promises: appState.memberDetailLoadPromises,
    };
}

const MEMBER_SUMMARY_KEYS = [
    'id',
    'name',
    'last_name',
    'first_name',
    'maiden_name',
    'last_name_kana',
    'first_name_kana',
    'part',
    'photo_url',
    'password_set',
    'permission',
    'joined_at',
    'system_access_until',
];

function memberDetailId(memberId) {
    return String(memberId || '').trim();
}

function normalizeMemberSummary(member) {
    const source = member || {};
    const summary = {};
    MEMBER_SUMMARY_KEYS.forEach((key) => {
        if (Object.prototype.hasOwnProperty.call(source, key)) {
            summary[key] = source[key];
            return;
        }
        if (key === 'password_set') {
            summary[key] = Boolean(source[key]);
            return;
        }
        summary[key] = '';
    });
    summary.id = source.id ?? summary.id ?? '';
    summary.password_set = Boolean(source.password_set);
    summary.permission = String(source.permission || '荳闊ｬ');
    summary.joined_at = String(source.joined_at || '');
    summary.system_access_until = String(source.system_access_until || '');
    summary.photo_url = String(source.photo_url || '');
    summary.part = String(source.part || '');
    summary.name = String(source.name || '');
    summary.last_name = String(source.last_name || '');
    summary.first_name = String(source.first_name || '');
    summary.maiden_name = String(source.maiden_name || '');
    summary.last_name_kana = String(source.last_name_kana || '');
    summary.first_name_kana = String(source.first_name_kana || '');
    return summary;
}

function upsertMemberSummary(member) {
    const summary = normalizeMemberSummary(member);
    const id = memberDetailId(summary.id);
    if (!id) return summary;
    const index = (appState.members || []).findIndex((item) => String(item.id || '') === id);
    if (index >= 0) {
        appState.members[index] = { ...(appState.members[index] || {}), ...summary };
    } else {
        appState.members = [...(appState.members || []), summary];
    }
    return summary;
}

function removeMemberSummary(memberId) {
    const id = memberDetailId(memberId);
    if (!id) return;
    appState.members = (appState.members || []).filter((member) => String(member.id || '') !== id);
}

function storeMemberDetailRecord(memberId, detail, state = 'loaded') {
    const id = memberDetailId(memberId || detail?.id);
    if (!id) return null;
    const { records, states, promises } = _memberDetailStateMaps();
    records[id] = detail ? { ...detail } : {};
    states[id] = state;
    delete promises[id];
    return records[id];
}

function clearMemberSummaryAndDetail(memberId) {
    removeMemberSummary(memberId);
    clearMemberDetailCache(memberId);
}

function memberDetailKeys() {
    return Object.keys(_memberDetailStateMaps().records);
}

function memberSummaryById(memberId) {
    const id = memberDetailId(memberId);
    if (!id) return null;
    return (appState.members || []).find((member) => String(member.id || '') === id) || null;
}

function memberDetailById(memberId) {
    const id = memberDetailId(memberId);
    if (!id) return null;
    const summary = memberSummaryById(id) || {};
    const { records } = _memberDetailStateMaps();
    const detail = records[id] || {};
    return { ...summary, ...detail };
}

function publicMemberDetailById(memberId) {
    const detail = memberDetailById(memberId);
    if (!detail) return null;
    const publicDetail = { ...detail };
    [
        'maiden_name_kana',
        'is_recording_manager',
        'is_sheet_manager',
        'permission',
        'system_access_until',
        'password_set',
    ].forEach((key) => {
        delete publicDetail[key];
    });
    return publicDetail;
}

function clearMemberDetailCache(memberId = '') {
    const { records, states, promises } = _memberDetailStateMaps();
    const id = memberDetailId(memberId);
    if (!id) {
        Object.keys(records).forEach((key) => { delete records[key]; });
        Object.keys(states).forEach((key) => { delete states[key]; });
        Object.keys(promises).forEach((key) => { delete promises[key]; });
        return;
    }
    delete records[id];
    delete states[id];
    delete promises[id];
}

function memberDetailLoaded(memberId) {
    const { states } = _memberDetailStateMaps();
    return states[memberDetailId(memberId)] === 'loaded';
}

function memberDetailLoading(memberId) {
    const { states } = _memberDetailStateMaps();
    return states[memberDetailId(memberId)] === 'loading';
}

async function loadMemberDetail(memberId) {
    const id = memberDetailId(memberId);
    if (!id) return null;
    const { records, states, promises } = _memberDetailStateMaps();

    if (states[id] === 'loaded' && records[id]) {
        return memberDetailById(id);
    }
    if (states[id] === 'loading' && promises[id]) {
        return promises[id];
    }

    const pending = (async () => {
        states[id] = 'loading';
        try {
            const detail = await request(`/api/members/${encodeURIComponent(id)}`);
            storeMemberDetailRecord(id, detail || {}, 'loaded');
            states[id] = 'loaded';
            return memberDetailById(id);
        } catch (error) {
            delete records[id];
            states[id] = 'error';
            throw error;
        } finally {
            delete promises[id];
        }
    })();

    promises[id] = pending;
    return pending;
}

async function ensureMemberIntroDataLoaded() {
    const members = Array.isArray(appState.members) ? appState.members : [];
    const pending = members
        .map((member) => memberDetailId(member.id))
        .filter(Boolean)
        .filter((id) => !memberDetailLoaded(id) && !memberDetailLoading(id))
        .map((id) => loadMemberDetail(id));

    if (!pending.length) {
        return true;
    }

    const settled = await Promise.allSettled(pending);
    const failed = settled.filter((item) => item.status === 'rejected').length;
    if (failed && typeof showAlert === 'function') {
        showAlert('蝗｣蜩｡邏ｹ莉・蜀崎ｩｦ陦後・繝・・繧ｿ繝ｼ蜿門ｾ励↓螟ｱ謨励＠縺ｾ縺励◆縲よｽｭ陦後∪縺溘・繝医Λ繧ｳ繝輔ぃ繝ｼ繝舌・縺ｧ蜿門ｾ励し繝ｼ繝・を蜿門ｾ後〒縺阪∪縺吶・', 'warning');
    }
    return failed === 0;
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
