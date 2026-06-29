const fs = require('node:fs');
const path = require('node:path');

describe('payment status display', () => {
    const appJs = fs.readFileSync(path.resolve(__dirname, '../../src/static/js/app.js'), 'utf8');

    test('member payment view shows paid-until month instead of fee amount', () => {
        const memberPaymentStatusHtml = appJs.slice(
            appJs.indexOf('function memberPaymentStatusHtml()'),
            appJs.indexOf('function findPaymentForMember')
        );

        expect(memberPaymentStatusHtml).toContain('paymentPaymentRangeLabel(payment)');
        expect(memberPaymentStatusHtml).toContain('performanceFeeMap(payment)');
        expect(memberPaymentStatusHtml).not.toContain('membership_fee_amount');
        expect(memberPaymentStatusHtml).not.toContain('performance_fee_amount');
    });

    test('payment status detail does not render configured fee amounts', () => {
        const paymentStatusHtml = appJs.slice(
            appJs.indexOf('function paymentStatusHtml(payment)'),
            appJs.indexOf('function paymentMemberOptionsById')
        );

        expect(paymentStatusHtml).toContain('支払済み');
        expect(paymentStatusHtml).toContain('未払い');
        expect(paymentStatusHtml).not.toContain('performanceFeeAmountLabel');
        expect(paymentStatusHtml).not.toContain('orgMembershipFeeAmountLabel');
    });
});
