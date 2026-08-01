const fs = require('node:fs');
const path = require('node:path');

const {
    memberPasswordBadgeState,
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

    test('member admin uses reset button instead of password input field', () => {
        const html = fs.readFileSync(
            path.resolve(__dirname, '../../src/index.html'),
            'utf8'
        );

        expect(html).not.toContain('id="memberPassword"');
        expect(html).toContain('id="resetMemberPasswordBtn"');
        expect(html).toContain('パスワードリセット');
    });
});
