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
});
