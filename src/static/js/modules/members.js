// This file was split from main.js during frontend refactor.
// It depends on shared globals declared in main.js (appState, $, request, helpers).

var appState = window.portalRuntimeContext.appState;
var $ = window.portalRuntimeContext.getById;

function setupMemberManagerTabs() {
    const memberPanel = $('memberPanel');
    const toolbar = memberPanel?.querySelector('.toolbar');
    if (!memberPanel || !toolbar) return;

    if (!$('memberUploadAdminBtn')) {
        toolbar.insertAdjacentHTML('beforeend', '<button class="btn btn-sm btn-outline-primary" id="memberUploadAdminBtn" data-tab="upload" type="button" hidden>録音管理</button>');
    }
    if (!$('memberSheetAdminBtn')) {
        toolbar.insertAdjacentHTML('beforeend', '<button class="btn btn-sm btn-outline-primary" id="memberSheetAdminBtn" data-tab="sheet-admin" type="button" hidden>楽譜管理</button>');
    }

    const uploadTab = $('uploadTab');
    if (uploadTab && uploadTab.parentElement !== memberPanel) {
        memberPanel.appendChild(uploadTab);
    }
    const sheetAdminTab = $('sheetAdminTab');
    if (sheetAdminTab && sheetAdminTab.parentElement !== memberPanel) {
        memberPanel.appendChild(sheetAdminTab);
    }
}

// ログイン中ユーザーの権限に応じて、管理導線ボタンの表示/非表示を切り替える。


function isExtraRestrictedMemberTab(tabName) {
    return isExtraUser() && EXTRA_RESTRICTED_MEMBER_TABS.has(tabName);
}


function visibleMemberMenuItems(items) {
    return items.filter((item) => item && !isExtraRestrictedMemberTab(item.tab || ''));
}

// ホーム/ドロワーに表示するメニュー群の定義を返す。
// 表示可否は現在の権限やアラート状態に応じて動的に決まる。


function currentUserMember() {
    return appState.members.find((member) => String(member.id || '') === String(appState.currentUserMemberId || '')) || null;
}

// 現在ログイン中の表示名を返す（団員レコード優先）。


function currentUserMemberName() {
    const member = currentUserMember();
    return member ? memberDisplayName(member) : appState.currentUserName || '';
}

// 管理者メニューへ入れるか判定する。


function memberDisplayName(member) {
    const last = member?.last_name || '';
    const first = member?.first_name || '';
    const maiden = member?.maiden_name || '';
    const splitName = `${last}${maiden ? `(${maiden})` : ''}${first}`;
    return splitName || member?.name || '';
}

// 現在ログイン中の団員レコードを状態ストアから取得する。
// currentUserMember moved to feature module.

// currentUserMemberName moved to feature module.


function memberKanaName(member) {
    return `${member?.last_name_kana || ''}${member?.first_name_kana || ''}`;
}

// renderMemberSchedules moved to feature module.

// sortedSchedules moved to feature module.

// groupSchedulesByPerformance moved to feature module.

// compareSchedulePerformanceGroups moved to feature module.

// schedulePerformanceGroupIsUndecided moved to feature module.

// schedulePerformance moved to feature module.

// scheduleIsConductorTraining moved to feature module.

// scheduleIsMainPerformance moved to feature module.

// formatScheduleDate moved to feature module.



// 楽曲情報は練習指示と同じく、未開催演奏会の曲一覧から曲別編集へ遷移する。


async function saveOrgMembershipFee() {
    const amount = integerAmountNumber($('orgMembershipFee')?.value || 0);
    const current = currentOrgSetting();
    const name = current.name || current.organization_name || current.organization_name_full || '';
    const shortName = current.short_name || current.shortName || current.organization_abbreviation || '';
    const payload = {
        name,
        organization_name: name,
        organization_abbreviation: shortName,
        short_name: shortName,
        icon_url: current.icon_url || current.iconUrl || '',
        membership_fee_amount: amount
    };
    if (current.id) {
        await request(`/api/extra/org_settings/${encodeURIComponent(current.id)}`, jsonOptions('PUT', payload));
    } else {
        await saveExtra('org_settings', payload);
    }
    await loadExtraData();
    showAlert('団費を保存しました', 'success');
    renderPaymentAdmin();
}

