// Payment module.

var appState = window.portalRuntimeContext.appState;
var $ = window.portalRuntimeContext.getById;

var paymentAdminSortKey = 'dues';
var paymentAdminSortDirection = 'desc';

function renderPaymentView() {
    const c = $('memberPaymentInfo');
    if (!c) return;
    c.innerHTML = memberPaymentStatusHtml();
}

function memberPaymentStatusHtml() {
    const memberId = appState.currentUserMemberId;
    const payment = findPaymentForMember(memberId, currentUserMemberName());
    const feeMap = performanceFeeMap(payment);
    const alertInfo = paymentAlertInfo(payment, memberId);
    const summary = paymentStatusSummary(payment, memberId);
    const eligiblePerformanceIds = paymentChargeablePerformanceIdsForMember(memberId);

    const performanceFees = appState.performances
        .filter((perf) => eligiblePerformanceIds.has(String(perf.id)))
        .map((perf) => {
            const paid = Boolean(feeMap[String(perf.id)]);
            const overdue = alertInfo.overduePerformanceIds.has(String(perf.id));
            return `<div class="small"><span class="${overdue ? 'payment-overdue' : ''}">${escapeHtml(perf.title)}</span>: <span class="badge ${paid ? 'text-bg-success' : 'text-bg-secondary'}">${paid ? '\u652f\u6255\u6e08\u307f' : '\u672a\u6255\u3044'}</span>${overdue ? '<span class="payment-overdue ms-2">\u6ede\u7d0d</span>' : ''}</div>`;
        }).join('');

    return `
        <div class="info-block">
            <h6>\u56e3\u8cbb</h6>
            <div class="${alertInfo.duesOverdue ? 'payment-overdue' : ''}">${escapeHtml(summary.duesLabel)}</div>
            <h6 class="mt-3">\u6f14\u594f\u4f1a\u8cbb</h6>
            <div>${performanceFees || '<p class="text-muted mb-0">\u652f\u6255\u5bfe\u8c61\u306e\u6f14\u594f\u4f1a\u8cbb\u306f\u3042\u308a\u307e\u305b\u3093</p>'}</div>
        </div>
    `;
}

function findPaymentForMember(memberId, name = '') {
    return appState.payments.find((payment) =>
        (memberId && String(payment.member_id || '') === String(memberId)) ||
        (name && payment.name === name)
    ) || null;
}

function performanceFeeMap(payment) {
    return payment?.performance_fees && typeof payment.performance_fees === 'object'
        ? payment.performance_fees
        : {};
}

function performanceFeeAmountMap(payment) {
    return payment?.performance_fee_amounts && typeof payment.performance_fee_amounts === 'object'
        ? payment.performance_fee_amounts
        : {};
}

function orgMembershipFeeAmountLabel() {
    return yenAmountLabel(currentOrgSetting().membership_fee_amount);
}

function performanceFeeAmountLabel(performance) {
    return yenAmountLabel(performance?.performance_fee_amount);
}

const PAYMENT_POLICY_START_MONTH = '2026-02';

function paymentMemberForPayment(payment = null, memberId = '') {
    const resolvedId = String(
        memberId
        || payment?.member_id
        || appState.currentUserMemberId
        || ''
    );

    if (resolvedId) {
        const member = (appState.members || []).find(
            (item) => String(item.id || '') === resolvedId
        );
        if (member) return member;
    }

    const paymentName = String(payment?.name || '');
    return paymentName
        ? (appState.members || []).find(
            (member) => memberDisplayName(member) === paymentName
        ) || null
        : null;
}

function paymentMonthText(value) {
    const match = String(value || '').match(/^(\d{4})-(\d{2})/);
    return match ? `${match[1]}-${match[2]}` : '';
}

function paymentNextMonthText(monthText) {
    const value = monthValue(monthText);
    if (value === null) return '';

    const next = value + 1;
    const year = Math.floor((next - 1) / 12);
    const month = ((next - 1) % 12) + 1;
    return `${year}-${String(month).padStart(2, '0')}`;
}

function paymentSortedPerformancesForPolicy() {
    return [...(appState.performances || [])]
        .filter((perf) => paymentMonthText(perf.date))
        .sort((a, b) =>
            String(a.date).localeCompare(String(b.date))
            || String(a.id || '').localeCompare(String(b.id || ''))
        );
}

function paymentMemberHasCastingForPerformance(memberId, performanceId) {
    const targetMemberId = String(memberId || '');
    const targetPerformanceId = String(performanceId || '');

    if (!targetMemberId || !targetPerformanceId) return false;

    return (appState.castings || []).some((casting) =>
        String(casting.performance_id || '') === targetPerformanceId
        && Array.isArray(casting.members)
        && casting.members.some(
            (member) => String(member.member_id || '') === targetMemberId
        )
    );
}

function paymentChargeablePerformanceIdsForMember(memberId) {
    const policyStart = monthValue(PAYMENT_POLICY_START_MONTH);
    const ids = new Set();

    paymentSortedPerformancesForPolicy().forEach((perf) => {
        const performanceMonth = monthValue(paymentMonthText(perf.date));

        if (
            performanceMonth !== null
            && policyStart !== null
            && performanceMonth >= policyStart
            && paymentMemberHasCastingForPerformance(memberId, perf.id)
        ) {
            ids.add(String(perf.id));
        }
    });

    return ids;
}

function paymentChargeableMonthsForMember(memberId) {
    const member = (appState.members || []).find(
        (item) => String(item.id || '') === String(memberId || '')
    );
    if (!member) return [];

    const performances = paymentSortedPerformancesForPolicy();
    const policyStart = monthValue(PAYMENT_POLICY_START_MONTH);
    const joinedMonth = monthValue(paymentMonthText(member.joined_at));
    const chargeableMonths = new Set();

    performances.forEach((perf, index) => {
        if (!paymentMemberHasCastingForPerformance(member.id, perf.id)) return;

        const performanceMonth = monthValue(paymentMonthText(perf.date));
        if (
            performanceMonth === null
            || policyStart === null
            || performanceMonth < policyStart
        ) {
            return;
        }

        const previousPerformanceMonth = index > 0
            ? paymentMonthText(performances[index - 1].date)
            : '';

        const calculatedStartText = previousPerformanceMonth
            ? paymentNextMonthText(previousPerformanceMonth)
            : PAYMENT_POLICY_START_MONTH;

        const calculatedStart = monthValue(calculatedStartText);
        if (calculatedStart === null) return;

        const startMonth = Math.max(
            calculatedStart,
            policyStart,
            joinedMonth === null ? policyStart : joinedMonth
        );

        for (
            let month = startMonth;
            month <= performanceMonth;
            month += 1
        ) {
            chargeableMonths.add(month);
        }
    });

    return [...chargeableMonths].sort((a, b) => a - b);
}

function paymentRemainingMonthCountForMember(payment = null, memberId = '') {
    const member = paymentMemberForPayment(payment, memberId);
    if (!member) return null;

    const current = currentMonthValue();
    if (current === null) return null;

    const paidUntil = monthValue(
        payment?.paid_until_month
        || payment?.membership_fee
        || payment?.dues
        || ''
    );

    return paymentChargeableMonthsForMember(member.id)
        .filter(
            (month) =>
                month <= current
                && (paidUntil === null || month > paidUntil)
        )
        .length;
}

function paymentMembershipStatusLabel(payment = null, memberId = '') {
    const member = paymentMemberForPayment(payment, memberId);
    if (!member) return '\u672a\u6255\u3044';

    const chargeableMonths = paymentChargeableMonthsForMember(member.id);
    if (!chargeableMonths.length) return '\u56e3\u8cbb\u5bfe\u8c61\u6708\u306a\u3057';

    const remaining = paymentRemainingMonthCountForMember(payment, member.id);
    const paidUntil =
        payment?.paid_until_month
        || payment?.membership_fee
        || payment?.dues
        || '';

    const paidUntilLabel = paymentMonthLabel(paidUntil);

    if (!paidUntilLabel) {
        return remaining > 0
            ? `\u672a\u767b\u9332\uff08${remaining}\u30f6\u6708\u5206\u672a\u7d0d\uff09`
            : '\u672a\u6255\u3044';
    }

    if (remaining === null || remaining <= 0) {
        return `${paidUntilLabel}\u307e\u3067\u652f\u6255\u6e08\u307f`;
    }

    return `${paidUntilLabel}\u307e\u3067\u652f\u6255\u6e08\u307f\uff08${remaining}\u30f6\u6708\u5206\u672a\u7d0d\uff09`;
}

function paymentPerformanceUnpaidTitles(payment = null, memberId = '') {
    const member = paymentMemberForPayment(payment, memberId);
    if (!member) return [];

    const feeMap = performanceFeeMap(payment);
    const eligibleIds = paymentChargeablePerformanceIdsForMember(member.id);

    return appState.performances
        .filter(
            (perf) =>
                eligibleIds.has(String(perf.id))
                && !Boolean(feeMap[String(perf.id)])
        )
        .map((perf) => perf.title)
        .filter(Boolean);
}

function paymentStatusSummary(payment = null, memberId = '') {
    const member = paymentMemberForPayment(payment, memberId);
    const resolvedMemberId = member?.id || memberId || '';

    const duesRemaining =
        paymentRemainingMonthCountForMember(payment, resolvedMemberId);

    const unpaidPerformanceTitles =
        paymentPerformanceUnpaidTitles(payment, resolvedMemberId);

    return {
        duesRemaining,
        duesLabel: paymentMembershipStatusLabel(payment, resolvedMemberId),
        unpaidPerformanceTitles,
        latestPaymentDate: payment?.latest_payment_date || '\u672a\u6255\u3044',
        hasWarning:
            (duesRemaining !== null && duesRemaining > 0)
            || unpaidPerformanceTitles.length > 0,
    };
}

function monthValue(monthText) {
    if (!monthText || !/^\d{4}-\d{2}$/.test(String(monthText))) return null;
    const [year, month] = String(monthText).split('-').map(Number);
    return year * 12 + month;
}

function currentMonthValue() {
    return monthValue(window.portalRuntimeContext.today().slice(0, 7));
}

function addMonths(dateText, months) {
    if (!dateText) return null;
    const date = new Date(`${dateText}T00:00:00`);
    if (Number.isNaN(date.getTime())) return null;
    date.setMonth(date.getMonth() + months);
    return date;
}

function paymentAlertInfo(payment = null, memberId = '') {
    const member = paymentMemberForPayment(payment, memberId);
    const info = {
        duesOverdue: false,
        overduePerformanceIds: new Set(),
        hasAlert: false
    };

    if (!member) return info;

    const resolvedPayment = payment || findPaymentForMember(member.id, memberDisplayName(member));

    const paidUntil = monthValue(
        resolvedPayment?.paid_until_month
        || resolvedPayment?.membership_fee
        || resolvedPayment?.dues
        || ''
    );

    const current = currentMonthValue();

    if (current !== null) {
        info.duesOverdue = paymentChargeableMonthsForMember(member.id)
            .some(
                (month) =>
                    month <= current - 6
                    && (paidUntil === null || month > paidUntil)
            );
    }

    const feeMap = performanceFeeMap(resolvedPayment);
    const eligibleIds =
        paymentChargeablePerformanceIdsForMember(member.id);

    const now = new Date(
        `${window.portalRuntimeContext.today()}T00:00:00`
    );

    appState.performances.forEach((perf) => {
        if (!eligibleIds.has(String(perf.id))) return;

        const dueDate = addMonths(perf.date, 6);
        const paid = Boolean(feeMap[String(perf.id)]);

        if (dueDate && dueDate < now && !paid) {
            info.overduePerformanceIds.add(String(perf.id));
        }
    });

    info.hasAlert =
        info.duesOverdue
        || info.overduePerformanceIds.size > 0;

    return info;
}

function paymentStatusHtml(payment) {
    const member = paymentMemberForPayment(payment);
    const memberId = member?.id || payment?.member_id || '';

    const feeMap = performanceFeeMap(payment);
    const alertInfo = paymentAlertInfo(payment, memberId);
    const summary = paymentStatusSummary(payment, memberId);
    const eligibleIds =
        paymentChargeablePerformanceIdsForMember(memberId);

    const performanceFees = appState.performances
        .filter((perf) => eligibleIds.has(String(perf.id)))
        .map((perf) => {
            const paid = Boolean(feeMap[String(perf.id)]);
            const overdue =
                alertInfo.overduePerformanceIds.has(String(perf.id));

            return `<div><span class="${overdue || !paid ? 'payment-overdue' : 'text-muted'}">${escapeHtml(perf.title)}</span>: <span class="badge ${paid ? 'text-bg-secondary' : 'text-bg-danger'}">${paid ? '\u652f\u6255\u6e08\u307f' : '\u672a\u6255\u3044'}</span>${overdue ? '<span class="payment-overdue ms-2">\u6ede\u7d0d</span>' : ''}</div>`;
        })
        .join('');

    const unpaidPerformanceText =
        summary.unpaidPerformanceTitles.length
            ? `<div class="payment-unpaid-summary mt-2">\u672a\u6255\u3044\u306e\u6f14\u594f\u4f1a\u8cbb: ${escapeHtml(summary.unpaidPerformanceTitles.join('\u3001'))}</div>`
            : '<div class="text-muted mt-2">\u6f14\u594f\u4f1a\u8cbb\u306f\u672a\u6255\u3044\u306a\u3057</div>';

    return `
        <div class="info-block">
            <div class="${summary.duesRemaining !== null && summary.duesRemaining > 0 ? 'payment-overdue' : ''}">\u56e3\u8cbb: ${escapeHtml(summary.duesLabel)}</div>
            <div>\u6700\u65b0\u652f\u6255\u65e5: ${escapeHtml(summary.latestPaymentDate)}</div>
            <div class="mt-2"><strong>\u6f14\u594f\u4f1a\u8cbb</strong>${performanceFees || '<div class="text-muted">\u652f\u6255\u5bfe\u8c61\u306e\u6f14\u594f\u4f1a\u8cbb\u306f\u3042\u308a\u307e\u305b\u3093</div>'}</div>
            ${unpaidPerformanceText}
        </div>
    `;
}

function paymentMemberOptionsById(selected = '') {
    return ['<option value="">選択してください</option>'].concat(paymentAdminVisibleMembersSortedByPartAndName().map((member) => {
        const id = String(member.id || '');
        const part = member.part ? `（${member.part}）` : '';
        return `<option value="${escapeHtml(id)}" ${id === String(selected) ? 'selected' : ''}>${escapeHtml(memberDisplayName(member) + part)}</option>`;
    })).join('');
}

function paymentAdminVisibleMembers() {
    return (appState.members || []).filter((member) => String(member.permission || '一般') !== 'エキストラ');
}

function paymentAdminPartOrder(partName) {
    const target = String(partName || '');
    const setting = (appState.partSettings || []).find(
        (item) => String(item.name || '') === target
    );
    const order = Number(setting?.display_order ?? setting?.sort_order);
    return Number.isFinite(order) ? order : Number.MAX_SAFE_INTEGER;
}

function paymentAdminComparePartNames(aPart, bPart) {
    return paymentAdminPartOrder(aPart) - paymentAdminPartOrder(bPart)
        || String(aPart || '').localeCompare(String(bPart || ''), 'ja');
}

function paymentAdminCompareMemberNames(a, b) {
    return String(memberKanaName(a) || memberDisplayName(a)).localeCompare(
        String(memberKanaName(b) || memberDisplayName(b)),
        'ja'
    ) || String(memberDisplayName(a)).localeCompare(String(memberDisplayName(b)), 'ja');
}

function paymentAdminVisibleMembersSortedByPartAndName() {
    return [...paymentAdminVisibleMembers()].sort((a, b) =>
        paymentAdminComparePartNames(a.part, b.part)
        || paymentAdminCompareMemberNames(a, b)
    );
}

// 乗り番管理は保存済みレコードを編集フォーム用の配列へコピーして扱う。
// 保存済みデータを直接触らず、一覧の「編集」はレコードIDで対象を特定する。

function paymentAdminCompareName(a, b) {
    return paymentAdminCompareMemberNames(a.member, b.member);
}

function paymentAdminComparePart(a, b) {
    return paymentAdminComparePartNames(a.member.part, b.member.part);
}

function paymentAdminComparePartAndName(a, b) {
    return paymentAdminComparePart(a, b) || paymentAdminCompareName(a, b);
}

function paymentAdminSortedPerformances() {
    return [...(appState.performances || [])]
        .filter((perf) => String(perf.date || ''))
        .sort((a, b) =>
            String(a.date).localeCompare(String(b.date))
            || String(a.id || '').localeCompare(String(b.id || ''))
        );
}

function paymentAdminPerformanceUnpaidCompare(a, b) {
    const performances = paymentAdminSortedPerformances();
    const aFeeMap = performanceFeeMap(a.payment);
    const bFeeMap = performanceFeeMap(b.payment);

    const aEligible =
        paymentChargeablePerformanceIdsForMember(a.member.id);
    const bEligible =
        paymentChargeablePerformanceIdsForMember(b.member.id);

    for (const perf of performances) {
        const performanceId = String(perf.id);

        const aState = !aEligible.has(performanceId)
            ? 2
            : (Boolean(aFeeMap[performanceId]) ? 1 : 0);

        const bState = !bEligible.has(performanceId)
            ? 2
            : (Boolean(bFeeMap[performanceId]) ? 1 : 0);

        if (aState !== bState) return aState - bState;
    }

    return 0;
}

function paymentAdminCompareEntries(a, b) {
    let primary = 0;

    if (paymentAdminSortKey === 'dues') {
        primary = (a.summary.duesRemaining ?? -1) - (b.summary.duesRemaining ?? -1);
    } else if (paymentAdminSortKey === 'performance') {
        primary = paymentAdminPerformanceUnpaidCompare(a, b);
    } else if (paymentAdminSortKey === 'part') {
        primary = paymentAdminComparePart(a, b);
    } else if (paymentAdminSortKey === 'name') {
        primary = paymentAdminCompareName(a, b);
    }

    if (paymentAdminSortDirection === 'desc') {
        primary *= -1;
    }

    if (primary) return primary;

    if (paymentAdminSortKey === 'dues' || paymentAdminSortKey === 'performance') {
        return paymentAdminComparePartAndName(a, b);
    }
    if (paymentAdminSortKey === 'part') {
        return paymentAdminCompareName(a, b);
    }
    return 0;
}

function renderPaymentAdminSortControls() {
    const controls = $('paymentAdminSortControls');
    if (!controls) return;

    controls.querySelectorAll('[data-payment-sort]').forEach((button) => {
        const key = button.dataset.paymentSort;
        const active = key === paymentAdminSortKey;
        button.classList.toggle('btn-primary', active);
        button.classList.toggle('btn-outline-primary', !active);
        button.textContent = `${button.dataset.sortLabel}${active ? (paymentAdminSortDirection === 'asc' ? ' \u2191' : ' \u2193') : ''}`;
        button.onclick = () => {
            if (paymentAdminSortKey === key) {
                paymentAdminSortDirection = paymentAdminSortDirection === 'asc' ? 'desc' : 'asc';
            } else {
                paymentAdminSortKey = key;
                paymentAdminSortDirection = 'asc';
            }
            renderPaymentAdmin();
        };
    });
}

function renderPaymentAdmin() {
    const memberSelect = $('paymentMemberId');
    const feeContainer = $('paymentPerformanceFees');
    const list = $('paymentAdminList');
    if (!memberSelect || !feeContainer || !list) return;

    renderPaymentAdminSortControls();

    const selected = memberSelect.value;
    memberSelect.innerHTML = paymentMemberOptionsById(selected);
    if ([...memberSelect.options].some((option) => option.value === selected)) {
        memberSelect.value = selected;
    }

    feeContainer.innerHTML = appState.performances.length
        ? appState.performances.map((perf) => `
            <div class="d-flex flex-wrap align-items-center gap-2 mb-2">
                <label class="form-check mb-0">
                    <input class="form-check-input payment-performance-checkbox" type="checkbox" value="${escapeHtml(String(perf.id))}">
                    <span class="form-check-label">${escapeHtml(perf.title)}（${escapeHtml(performanceFeeAmountLabel(perf))}）</span>
                </label>
            </div>
        `).join('')
        : '<p class="text-muted mb-0">演奏会情報はまだありません</p>';

    const allMembers = paymentAdminVisibleMembers()
        .map((member) => ({
            member,
            payment: findPaymentForMember(member.id, memberDisplayName(member)),
        }))
        .map((entry) => ({
            ...entry,
            summary: paymentStatusSummary(entry.payment, entry.member.id),
        }))
        .sort(paymentAdminCompareEntries);
    list.innerHTML = allMembers.length
        ? `<div class="list-group">${allMembers.map(({ member, payment, summary }) => {
            const part = member.part ? `（${member.part}）` : '';
            const unpaidTitles = summary.unpaidPerformanceTitles.length ? summary.unpaidPerformanceTitles.join('、') : '未払いなし';
            const latestDate = summary.latestPaymentDate || '未登録';
            return `
                <button class="list-group-item list-group-item-action payment-admin-item ${summary.hasWarning ? 'payment-admin-item-warning' : 'payment-admin-item-ok'}" type="button" data-payment-id="${escapeHtml(String(payment?.id || ''))}" data-member-id="${escapeHtml(String(member.id || ''))}">
                    <div class="d-flex flex-wrap justify-content-between align-items-start gap-2">
                        <div>
                            <strong>${escapeHtml(memberDisplayName(member))}</strong>${part ? `<span class="ms-1 text-muted">${escapeHtml(part)}</span>` : ''}
                            <div class="small ${summary.hasWarning ? 'payment-overdue' : 'text-muted'}">団費: ${escapeHtml(summary.duesLabel)} / 演奏会費: ${escapeHtml(unpaidTitles)} / 最新支払日: ${escapeHtml(latestDate)}</div>
                        </div>
                        <span class="badge ${summary.hasWarning ? 'text-bg-danger' : 'text-bg-secondary'}">${summary.hasWarning ? '未払い確認' : '支払済み'}</span>
                    </div>
                </button>
            `;
        }).join('')}</div>`
        : '<p class="text-muted mb-0">団員情報はまだありません</p>';

    list.querySelectorAll('.payment-admin-item').forEach((button) => {
        button.addEventListener('click', () => {
            const paymentId = button.dataset.paymentId || '';
            const memberId = button.dataset.memberId || '';
            if (paymentId) {
                selectPaymentRecord(paymentId);
            } else {
                fillPaymentForm(null, memberId);
            }
            const form = $('paymentAdminForm');
            if (form) {
                form.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        });
    });

    if (typeof renderPaymentFeeSettings === 'function') renderPaymentFeeSettings();
}

function selectPaymentByMember(memberId) {
    const member = appState.members.find((item) => String(item.id || '') === String(memberId));
    const payment = findPaymentForMember(memberId, member ? memberDisplayName(member) : '');
    fillPaymentForm(payment, memberId);
}

function selectPaymentRecord(paymentId) {
    const payment = appState.payments.find((item) => String(item.id || '') === String(paymentId));
    if (!payment) return;
    fillPaymentForm(payment, payment.member_id || '');
}

function fillPaymentForm(payment, memberId = '') {
    if (!$('paymentId')) return;
    $('paymentId').value = payment?.id || '';
    $('paymentMemberId').value = memberId || payment?.member_id || '';
    if ($('paymentPaidFromMonth')) $('paymentPaidFromMonth').value = payment?.paid_from_month || '';
    $('paymentPaidUntilMonth').value = payment?.paid_until_month || '';
    $('paymentLatestDate').value = payment?.latest_payment_date || window.portalRuntimeContext.today();
    const feeMap = performanceFeeMap(payment);
    document.querySelectorAll('.payment-performance-checkbox').forEach((checkbox) => {
        checkbox.checked = Boolean(feeMap[String(checkbox.value)]);
    });
}

function clearPaymentForm() {
    fillPaymentForm(null, '');
}

async function savePaymentStatus() {
    const memberId = $('paymentMemberId')?.value || '';
    const member = appState.members.find((item) => String(item.id || '') === String(memberId));
    if (!member) {
        showAlert('支払状況を登録する団員を選択してください', 'warning');
        return;
    }
    const performanceFees = {};
    document.querySelectorAll('.payment-performance-checkbox').forEach((checkbox) => {
        performanceFees[String(checkbox.value)] = checkbox.checked;
    });
    const payload = {
        member_id: memberId,
        name: memberDisplayName(member),
        paid_until_month: $('paymentPaidUntilMonth')?.value || '',
        latest_payment_date: $('paymentLatestDate')?.value || '',
        performance_fees: performanceFees
    };
    const id = $('paymentId')?.value || findPaymentForMember(memberId, payload.name)?.id || '';
    const saved = id
        ? await request(`/api/extra/payments/${encodeURIComponent(id)}`, jsonOptions('PUT', payload))
        : await saveExtra('payments', payload);
    await loadExtraData(['payments']);
    renderPaymentView();
    fillPaymentForm(saved, memberId);
    showAlert('支払状況を保存しました', 'success');
}
