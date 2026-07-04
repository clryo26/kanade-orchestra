const {
    memberPasswordBadgeState,
    memberSelectionFormPatch,
} = require('../../src/static/js/frontend_testable_logic.js');

describe('member password display', () => {
    test('member list shows password status instead of cached password value', () => {
        expect(memberPasswordBadgeState(true)).toEqual({
            label: '設定済み',
            className: 'text-bg-success'
        });
        expect(memberPasswordBadgeState(false)).toEqual({
            label: '未設定',
            className: 'text-bg-warning'
        });
    });

    test('selecting a member keeps password reset field empty', () => {
        expect(memberSelectionFormPatch({
            id: 10,
            name: '山田花子',
            last_name: '',
            first_name: '',
            part: 'Vl',
            permission: '一般'
        })).toEqual(expect.objectContaining({
            memberId: 10,
            memberLastName: '山田花子',
            memberPassword: '',
            memberPart: 'Vl',
            memberPermission: '一般'
        }));
    });
});
