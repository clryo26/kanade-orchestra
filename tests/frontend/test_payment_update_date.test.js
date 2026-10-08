const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

describe('member payment update date', () => {
    test.each([
        ['2026-10-08', '2026-10-08'],
        ['', '未登録'],
        [undefined, '未登録'],
        ['<script>', '&lt;script&gt;'],
    ])('shows own latest payment date as update date: %s', (date, expected) => {
        const state = { currentUserMemberId: 1, payments: [{ member_id: 2, latest_payment_date: '2099-01-01' }, { member_id: 1, latest_payment_date: date }], performances: [] };
        const container = { innerHTML: '' };
        const sandbox = {
            window: { portalRuntimeContext: { appState: state, getById: () => container } },
            currentUserMemberName: () => '',
            escapeHtml: (value) => String(value).replace(/</g, '&lt;').replace(/>/g, '&gt;'),
        };
        vm.createContext(sandbox);
        vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../src/static/js/modules/payments.js'), 'utf8'), sandbox);
        sandbox.paymentAlertInfo = () => ({ overduePerformanceIds: new Set(), duesOverdue: false });
        sandbox.paymentStatusSummary = () => ({ duesLabel: 'paid' });
        sandbox.paymentChargeablePerformanceIdsForMember = () => new Set();
        sandbox.renderPaymentView();
        expect(container.innerHTML).toContain(`更新日: ${expected}`);
        expect(container.innerHTML).not.toContain('2099-01-01');
        state.payments = [];
        sandbox.renderPaymentView();
        expect(container.innerHTML).toContain('更新日: 未登録');
    });
});
