const fs = require('node:fs');
const path = require('node:path');

describe('member password display', () => {
    const appJs = fs.readFileSync(path.resolve(__dirname, '../../src/static/js/app.js'), 'utf8');

    test('member list shows password status instead of cached password value', () => {
        const renderMembers = appJs.slice(
            appJs.indexOf('function renderMembers()'),
            appJs.indexOf('function renderAuthDevices()')
        );

        expect(renderMembers).toContain('member.password_set');
        expect(renderMembers).toContain('設定済み');
        expect(renderMembers).not.toContain('escapeHtml(member.password');
    });

    test('selecting a member keeps password reset field empty', () => {
        const selectMember = appJs.slice(
            appJs.indexOf('function selectMember(id)'),
            appJs.indexOf('async function deleteMember()')
        );

        expect(selectMember).toContain("$('memberPassword').value = ''");
        expect(selectMember).not.toContain('item.password ||');
    });
});
