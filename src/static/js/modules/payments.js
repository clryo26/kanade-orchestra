// Payment module.

var appState = window.portalRuntimeContext.appState;
var $ = window.portalRuntimeContext.getById;

function renderPaymentView() {
    const c = $('memberPaymentInfo');
    if (!c) return;
    c.innerHTML = memberPaymentStatusHtml();
}

function memberPaymentStatusHtml() {
    const payment = findPaymentForMember(appState.currentUserMemberId, currentUserMemberName());
    const feeMap = performanceFeeMap(payment);
    const alertInfo = paymentAlertInfo(payment);
    const performanceFees = appState.performances.map((perf) => {
        const paid = Boolean(feeMap[String(perf.id)]);
        const overdue = alertInfo.overduePerformanceIds.has(String(perf.id));
        return `<div class="small"><span class="${overdue ? 'payment-overdue' : ''}">${escapeHtml(perf.title)}</span>: <span class="badge ${paid ? 'text-bg-success' : 'text-bg-secondary'}">${paid ? '支払済み' : '未払い'}</span>${overdue ? '<span class="payment-overdue ms-2">滞納</span>' : ''}</div>`;
    }).join('');
    
    return `
        <div class="info-block">
            <h6>団費</h6>
            <div class="${alertInfo.duesOverdue ? 'payment-overdue' : ''}">${escapeHtml(payment ? paymentPaymentRangeLabel(payment) : '未登録')}${alertInfo.duesOverdue ? '（滞納）' : ''}</div>
            <h6 class="mt-3">演奏会費</h6>
            <div>${performanceFees || '<p class="text-muted mb-0">演奏会情報は未登録です</p>'}</div>
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

function paymentPerformanceUnpaidTitles(payment = null) {
    const targetPayment = payment || findPaymentForMember(appState.currentUserMemberId, currentUserMemberName());
    const feeMap = performanceFeeMap(targetPayment);
    return appState.performances
        .filter((perf) => !Boolean(feeMap[String(perf.id)]))
        .map((perf) => perf.title)
        .filter(Boolean);
}

function paymentStatusSummary(payment = null) {
    const targetPayment = payment || findPaymentForMember(appState.currentUserMemberId, currentUserMemberName());
    const duesRemaining = paymentRemainingMonthCount(targetPayment);
    const unpaidPerformanceTitles = paymentPerformanceUnpaidTitles(targetPayment);
    return {
        duesRemaining,
        duesLabel: paymentPaymentRangeLabel(targetPayment),
        unpaidPerformanceTitles,
        latestPaymentDate: targetPayment?.latest_payment_date || '未登録',
        hasWarning: !targetPayment || duesRemaining === null || duesRemaining > 0 || unpaidPerformanceTitles.length > 0,
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

function paymentAlertInfo(payment = null) {
    const targetPayment = payment || findPaymentForMember(appState.currentUserMemberId, currentUserMemberName());
    const info = { duesOverdue: false, overduePerformanceIds: new Set(), hasAlert: false };
    if (!targetPayment) return info;
    const paidUntil = monthValue(targetPayment.paid_until_month || targetPayment.membership_fee || targetPayment.dues || '');
    const current = currentMonthValue();
    if (paidUntil !== null && current !== null && paidUntil <= current - 6) {
        info.duesOverdue = true;
    }
    const feeMap = performanceFeeMap(targetPayment);
    const now = new Date(`${window.portalRuntimeContext.today()}T00:00:00`);
    appState.performances.forEach((perf) => {
        const dueDate = addMonths(perf.date, 6);
        const paid = Boolean(feeMap[String(perf.id)]);
        if (dueDate && dueDate < now && !paid) {
            info.overduePerformanceIds.add(String(perf.id));
        }
    });
    info.hasAlert = info.duesOverdue || info.overduePerformanceIds.size > 0;
    return info;
}

function paymentStatusHtml(payment) {
    const feeMap = performanceFeeMap(payment);
    const alertInfo = paymentAlertInfo(payment);
    const summary = paymentStatusSummary(payment);
    const performanceFees = appState.performances.map((perf) => {
        const paid = Boolean(feeMap[String(perf.id)]);
        const overdue = alertInfo.overduePerformanceIds.has(String(perf.id));
        return `<div><span class="${overdue || !paid ? 'payment-overdue' : 'text-muted'}">${escapeHtml(perf.title)}</span>: <span class="badge ${paid ? 'text-bg-secondary' : 'text-bg-danger'}">${paid ? '支払済み' : '未払い'}</span>${overdue ? '<span class="payment-overdue ms-2">滞納</span>' : ''}</div>`;
    }).join('');
    const unpaidPerformanceText = summary.unpaidPerformanceTitles.length
        ? `<div class="payment-unpaid-summary mt-2">未払いの演奏会費: ${escapeHtml(summary.unpaidPerformanceTitles.join('、'))}</div>`
        : '<div class="text-muted mt-2">演奏会費は未払いなし</div>';
    return `
        <div class="info-block">
            <div class="${summary.duesRemaining !== null && summary.duesRemaining > 0 ? 'payment-overdue' : ''}">団費: ${escapeHtml(summary.duesLabel)}${alertInfo.duesOverdue ? '（滞納）' : ''}</div>
            <div>最新支払日: ${escapeHtml(summary.latestPaymentDate)}</div>
            <div class="mt-2"><strong>演奏会費</strong>${performanceFees || '<div class="text-muted">演奏会情報は未登録です</div>'}</div>
            ${unpaidPerformanceText}
        </div>
    `;
}

function paymentMemberOptionsById(selected = '') {
    return ['<option value="">選択してください</option>'].concat(sortedMembersByPartAndKana(appState.members).map((member) => {
        const id = String(member.id || '');
        const part = member.part ? `（${member.part}）` : '';
        return `<option value="${escapeHtml(id)}" ${id === String(selected) ? 'selected' : ''}>${escapeHtml(memberDisplayName(member) + part)}</option>`;
    })).join('');
}

// 乗り番管理は保存済みレコードを編集フォーム用の配列へコピーして扱う。
// 保存済みデータを直接触らず、一覧の「編集」はレコードIDで対象を特定する。

function renderPaymentAdmin() {
    const memberSelect = $('paymentMemberId');
    const feeContainer = $('paymentPerformanceFees');
    const list = $('paymentAdminList');
    if (!memberSelect || !feeContainer || !list) return;

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

    const allMembers = sortedMembersByPartAndKana(appState.members || [])
        .map((member) => ({
            member,
            payment: findPaymentForMember(member.id, memberDisplayName(member)),
        }))
        .map((entry) => ({
            ...entry,
            summary: paymentStatusSummary(entry.payment),
        }))
        .sort((a, b) => Number(b.summary.hasWarning) - Number(a.summary.hasWarning)
            || String(a.member.part || '').localeCompare(String(b.member.part || ''))
            || String(memberKanaName(a.member) || memberDisplayName(a.member)).localeCompare(String(memberKanaName(b.member) || memberDisplayName(b.member))));
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
                return;
            }
            fillPaymentForm(null, memberId);
        });
    });

    renderPaymentFeeSettings();
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
    await loadExtraData();
    renderPaymentView();
    fillPaymentForm(saved, memberId);
    showAlert('支払状況を保存しました', 'success');
}

