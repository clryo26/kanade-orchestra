const { paymentStatusContract } = require('../../src/static/js/frontend_testable_logic.js');

describe('payment status display', () => {
    const contract = paymentStatusContract();

    test('member payment view shows paid-until month instead of fee amount', () => {
        expect(contract.membershipRangeField).toBe('paid_until_month');
        expect(contract.performanceStatusField).toBe('performance_fees');
        expect(contract.hiddenAmountFields).toContain('membership_fee_amount');
        expect(contract.hiddenAmountFields).toContain('performance_fee_amount');
    });

    test('payment status detail does not render configured fee amounts', () => {
        expect(contract.visibleStatusLabels).toEqual(expect.arrayContaining(['支払済み', '未払い']));
        expect(contract.hiddenAmountHelpers).toEqual(expect.arrayContaining(['performanceFeeAmountLabel', 'orgMembershipFeeAmountLabel']));
    });

    test('paid-until label shows Japanese year-month format with paid suffix', () => {
        expect(paymentStatusContract).toBeDefined();
        const { paymentPaymentRangeLabel } = require('../../src/static/js/frontend_testable_logic.js');
        expect(paymentPaymentRangeLabel({ paid_until_month: '2999-12' })).toBe('2999年12月まで支払済み');
    });

    test('paid-until label can include unpaid months summary', () => {
        const { paymentPaymentRangeLabel } = require('../../src/static/js/frontend_testable_logic.js');
        expect(paymentPaymentRangeLabel({ paid_until_month: '2000-01' })).toMatch(/^2000年01月まで支払済み（\d+ヶ月分未納）$/);
    });
});
