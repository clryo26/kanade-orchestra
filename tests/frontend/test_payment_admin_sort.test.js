const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function paymentSandbox() {
    const content = fs.readFileSync(
        path.resolve(__dirname, '../../src/static/js/modules/payments.js'),
        'utf8'
    );
    const sandbox = {
        window: {
            portalRuntimeContext: {
                appState: { members: [], performances: [], payments: [], castings: [], partSettings: [] },
                getById: () => null,
                today: () => '2026-08-01',
            },
        },
        memberDisplayName: (member) => member.name || '',
        memberKanaName: (member) => `${member.last_name_kana || ''}${member.first_name_kana || ''}`,
        console,
    };
    vm.createContext(sandbox);
    vm.runInContext(content, sandbox);
    return sandbox;
}

describe('payment admin sorting', () => {
    test('payment admin renders four sort buttons and scroll target', () => {
        const html = fs.readFileSync(path.resolve(__dirname, '../../src/index.html'), 'utf8');
        expect(html).toContain('id="paymentAdminForm"');
        expect(html).toContain('id="paymentAdminSortControls"');
        expect(html).toContain('data-payment-sort="dues"');
        expect(html).toContain('data-payment-sort="performance"');
        expect(html).toContain('data-payment-sort="part"');
        expect(html).toContain('data-payment-sort="name"');
    });

    test('initial sort is dues descending', () => {
        const sandbox = paymentSandbox();
        expect(sandbox.paymentAdminSortKey).toBe('dues');
        expect(sandbox.paymentAdminSortDirection).toBe('desc');

        const rows = [
            { member: { name: 'B', part: 'Cl' }, payment: null, summary: { duesRemaining: 1 } },
            { member: { name: 'A', part: 'Fl' }, payment: null, summary: { duesRemaining: 5 } },
        ];
        rows.sort(sandbox.paymentAdminCompareEntries);
        expect(rows.map((row) => row.summary.duesRemaining)).toEqual([5, 1]);
    });

    test('same sort button toggles direction and another button starts ascending', () => {
        const sandbox = paymentSandbox();
        const buttons = ['dues', 'performance', 'part', 'name'].map((key) => ({
            dataset: { paymentSort: key, sortLabel: key },
            classList: { toggle: () => {} },
            textContent: '',
            onclick: null,
        }));
        const controls = { querySelectorAll: () => buttons };
        sandbox.window.portalRuntimeContext.getById = (id) => id === 'paymentAdminSortControls' ? controls : null;
        sandbox.$ = sandbox.window.portalRuntimeContext.getById;
        sandbox.renderPaymentAdmin = () => {};

        sandbox.renderPaymentAdminSortControls();
        buttons[0].onclick();
        expect(sandbox.paymentAdminSortDirection).toBe('asc');

        sandbox.renderPaymentAdminSortControls();
        buttons[0].onclick();
        expect(sandbox.paymentAdminSortDirection).toBe('desc');

        sandbox.renderPaymentAdminSortControls();
        buttons[2].onclick();
        expect(sandbox.paymentAdminSortKey).toBe('part');
        expect(sandbox.paymentAdminSortDirection).toBe('asc');
    });

    test('part sort follows configured display order before member name', () => {
        const sandbox = paymentSandbox();

        sandbox.window.portalRuntimeContext.appState.partSettings = [
            { name: 'Fl', display_order: 1 },
            { name: 'Cl', display_order: 2 },
            { name: 'Vn', display_order: 3 },
        ];
        sandbox.appState = sandbox.window.portalRuntimeContext.appState;
        sandbox.paymentAdminSortKey = 'part';
        sandbox.paymentAdminSortDirection = 'asc';

        const rows = [
            { member: { name: 'A', part: 'Vn' }, payment: null, summary: {} },
            { member: { name: 'B', part: 'Cl' }, payment: null, summary: {} },
            { member: { name: 'C', part: 'Fl' }, payment: null, summary: {} },
        ];

        rows.sort(sandbox.paymentAdminCompareEntries);

        expect(rows.map((row) => row.member.part)).toEqual(['Fl', 'Cl', 'Vn']);
    });

    test('payment alert resolves current member payment when payment argument is omitted', () => {
        const sandbox = paymentSandbox();

        sandbox.window.portalRuntimeContext.appState.currentUserMemberId = 1;
        sandbox.window.portalRuntimeContext.appState.members = [
            { id: 1, name: 'Current Member', joined_at: '2026-02' },
        ];
        sandbox.window.portalRuntimeContext.appState.performances = [
            { id: 10, title: 'Summer 2026', date: '2026-08-02' },
        ];
        sandbox.window.portalRuntimeContext.appState.castings = [
            { performance_id: 10, members: [{ member_id: 1 }] },
        ];
        sandbox.window.portalRuntimeContext.appState.payments = [
            {
                member_id: 1,
                name: 'Current Member',
                paid_until_month: '2026-08',
                performance_fees: { 10: true },
            },
        ];
        sandbox.appState = sandbox.window.portalRuntimeContext.appState;

        const info = sandbox.paymentAlertInfo();

        expect(info.duesOverdue).toBe(false);
        expect(info.overduePerformanceIds.size).toBe(0);
        expect(info.hasAlert).toBe(false);
    });
    test('part sort uses part then name', () => {
        const sandbox = paymentSandbox();
        sandbox.paymentAdminSortKey = 'part';
        sandbox.paymentAdminSortDirection = 'asc';

        const rows = [
            { member: { name: 'B', part: 'Cl' }, payment: null, summary: {} },
            { member: { name: 'A', part: 'Cl' }, payment: null, summary: {} },
            { member: { name: 'C', part: 'Fl' }, payment: null, summary: {} },
        ];
        rows.sort(sandbox.paymentAdminCompareEntries);
        expect(rows.map((row) => row.member.name)).toEqual(['A', 'B', 'C']);
    });

    test('name sort uses kana name while displaying kanji name', () => {
        const sandbox = paymentSandbox();
        sandbox.paymentAdminSortKey = 'name';
        sandbox.paymentAdminSortDirection = 'asc';

        const rows = [
            { member: { name: '\u5c71\u7530', last_name_kana: '\u3084\u307e\u3060' }, payment: null, summary: {} },
            { member: { name: '\u963f\u90e8', last_name_kana: '\u3042\u3079' }, payment: null, summary: {} },
            { member: { name: '\u4f0a\u85e4', last_name_kana: '\u3044\u3068\u3046' }, payment: null, summary: {} },
        ];
        rows.sort(sandbox.paymentAdminCompareEntries);
        expect(rows.map((row) => row.member.name)).toEqual(['\u963f\u90e8', '\u4f0a\u85e4', '\u5c71\u7530']);
    });

    test('performance unpaid sort prioritizes unpaid status of nearer performance then part and name', () => {
        const sandbox = paymentSandbox();
        sandbox.window.portalRuntimeContext.appState.performances = [
            { id: 20, date: '2027-01-01' },
            { id: 10, date: '2026-09-01' },
        ];
        sandbox.window.portalRuntimeContext.appState.castings = [
            { performance_id: 10, members: [{ member_id: 1 }, { member_id: 2 }] },
            { performance_id: 20, members: [{ member_id: 1 }, { member_id: 2 }] },
        ];
        sandbox.appState = sandbox.window.portalRuntimeContext.appState;
        sandbox.paymentAdminSortKey = 'performance';
        sandbox.paymentAdminSortDirection = 'asc';

        const rows = [
            {
                member: { id: 1, name: 'B', part: 'Cl' },
                payment: { member_id: 1, performance_fees: { 10: true, 20: false } },
                summary: {},
            },
            {
                member: { id: 2, name: 'A', part: 'Fl' },
                payment: { member_id: 2, performance_fees: { 10: false, 20: true } },
                summary: {},
            },
        ];
        rows.sort(sandbox.paymentAdminCompareEntries);
        expect(rows[0].member.name).toBe('A');
    });

    test('member list click scrolls only through payment admin item handler', () => {
        const content = fs.readFileSync(
            path.resolve(__dirname, '../../src/static/js/modules/payments.js'),
            'utf8'
        );
        expect(content).toContain("const form = $('paymentAdminForm');");
        expect(content).toContain("form.scrollIntoView({ behavior: 'smooth', block: 'start' });");
        expect(content.indexOf("const form = $('paymentAdminForm');"))
            .toBeGreaterThan(content.indexOf("list.querySelectorAll('.payment-admin-item')"));
    });

    test('payment policy uses casting, orchestra performance order, join month and February 2026 baseline', () => {
        const sandbox = paymentSandbox();

        sandbox.window.portalRuntimeContext.appState.members = [
            { id: 1, name: 'A', joined_at: '2026-04' },
        ];

        sandbox.window.portalRuntimeContext.appState.performances = [
            { id: 10, title: 'Summer 2026', date: '2026-08-02' },
            { id: 20, title: 'Winter 2027', date: '2027-01-10' },
            { id: 30, title: 'Summer 2027', date: '2027-08-01' },
        ];

        sandbox.window.portalRuntimeContext.appState.castings = [
            { performance_id: 10, members: [{ member_id: 1 }] },
            { performance_id: 30, members: [{ member_id: 1 }] },
        ];

        sandbox.appState =
            sandbox.window.portalRuntimeContext.appState;

        const values =
            sandbox.paymentChargeableMonthsForMember(1)
                .map((value) => {
                    const year = Math.floor((value - 1) / 12);
                    const month = ((value - 1) % 12) + 1;
                    return `${year}-${String(month).padStart(2, '0')}`;
                });

        expect(values).toEqual([
            '2026-04',
            '2026-05',
            '2026-06',
            '2026-07',
            '2026-08',
            '2027-02',
            '2027-03',
            '2027-04',
            '2027-05',
            '2027-06',
            '2027-07',
            '2027-08',
        ]);
    });

    test('performance fee applies only to cast performances', () => {
        const sandbox = paymentSandbox();

        sandbox.window.portalRuntimeContext.appState.members = [
            { id: 1, name: 'A', joined_at: '2026-02' },
        ];

        sandbox.window.portalRuntimeContext.appState.performances = [
            { id: 10, title: 'Cast concert', date: '2026-08-02' },
            { id: 20, title: 'No cast concert', date: '2027-01-10' },
        ];

        sandbox.window.portalRuntimeContext.appState.castings = [
            { performance_id: 10, members: [{ member_id: 1 }] },
        ];

        sandbox.appState =
            sandbox.window.portalRuntimeContext.appState;

        expect(
            [...sandbox.paymentChargeablePerformanceIdsForMember(1)]
        ).toEqual(['10']);

        expect(
            sandbox.paymentPerformanceUnpaidTitles(
                { member_id: 1, performance_fees: {} },
                1
            )
        ).toEqual(['Cast concert']);
    });

    test('dues remaining counts only chargeable months through current month', () => {
        const sandbox = paymentSandbox();

        sandbox.window.portalRuntimeContext.appState.members = [
            { id: 1, name: 'A', joined_at: '2026-04' },
        ];

        sandbox.window.portalRuntimeContext.appState.performances = [
            { id: 10, title: 'Summer 2026', date: '2026-08-02' },
        ];

        sandbox.window.portalRuntimeContext.appState.castings = [
            { performance_id: 10, members: [{ member_id: 1 }] },
        ];

        sandbox.appState =
            sandbox.window.portalRuntimeContext.appState;

        expect(
            sandbox.paymentRemainingMonthCountForMember(
                {
                    member_id: 1,
                    paid_until_month: '2026-06'
                },
                1
            )
        ).toBe(2);
    });

    test('January 2026 and earlier performances are outside payment policy', () => {
        const sandbox = paymentSandbox();

        sandbox.window.portalRuntimeContext.appState.members = [
            { id: 1, name: 'A', joined_at: '2025-01' },
        ];

        sandbox.window.portalRuntimeContext.appState.performances = [
            { id: 5, title: 'January 2026', date: '2026-01-20' },
        ];

        sandbox.window.portalRuntimeContext.appState.castings = [
            { performance_id: 5, members: [{ member_id: 1 }] },
        ];

        sandbox.appState =
            sandbox.window.portalRuntimeContext.appState;

        expect(
            [...sandbox.paymentChargeablePerformanceIdsForMember(1)]
        ).toEqual([]);

        expect(
            sandbox.paymentChargeableMonthsForMember(1)
        ).toEqual([]);
    });

});
