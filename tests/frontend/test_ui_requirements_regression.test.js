const fs = require('node:fs');
const path = require('node:path');

describe('ui requirement regression', () => {
    test('member concert info uses HH:mm clock display', () => {
        const content = fs.readFileSync(path.resolve(__dirname, '../../src/static/js/modules/members/render.js'), 'utf8');
        expect(content).toContain('formatClockTime(perf.open_time)');
        expect(content).toContain('formatClockTime(perf.start_time)');
    });

    test('portal login and password setup labels are valid Japanese HTML', () => {
        const content = fs.readFileSync(
            path.resolve(__dirname, '../../src/static/js/auth_feature.js'),
            'utf8'
        );

        expect(content).toContain('placeholder="漢字またはふりがな"');
        expect(content).toContain('for="portalPartInput">パート</label>');
        expect(content).toContain('for="portalPasswordInput">パスワード</label>');
        expect(content).toContain('for="portalNewPasswordInput">新しいパスワード</label>');
        expect(content).toContain('新しいパスワード（確認）</label>');
        expect(content).toContain('ログインに戻る</button>');
        expect(content).toContain('もう一度ログインしてください。');
    });

    test('absence planned time display removes seconds', () => {
        const content = fs.readFileSync(
            path.resolve(__dirname, '../../src/static/js/modules/absences.js'),
            'utf8'
        );

        expect(content).toContain('function absencePlannedTimeLabel(value)');
        expect(content).toContain("text.match(/^(\\d{2}:\\d{2})/)");
        expect(content).toContain('absencePlannedTimeLabel(absence?.planned_time)');
    });
    test('member intro joined_at shows month label and founder badge uses subtle class', () => {
        const content = fs.readFileSync(path.resolve(__dirname, '../../src/static/js/modules/members/render.js'), 'utf8');
        const css = fs.readFileSync(path.resolve(__dirname, '../../src/static/css/style.css'), 'utf8');
        expect(content).toContain('joinedAtMonthLabel(member.joined_at)');
        expect(content).toContain('member-founder-badge');
        expect(css).toContain('.member-founder-badge');
    });

    test('flyer distribution form no longer renders planned member/date and uses assignment note', () => {
        const content = fs.readFileSync(path.resolve(__dirname, '../../src/static/js/modules/portal_views.js'), 'utf8');
        expect(content).not.toContain('flyer-planned-member-id');
        expect(content).not.toContain('flyer-planned-date');
        expect(content).toContain('flyer-assignment-note');
        expect(content).toContain('note: assignmentNote');
        expect(content).not.toContain('planned_member_id:');
        expect(content).not.toContain('planned_date:');
        expect(content).not.toContain('facility.note');
    });

    test('member event screen starts with collapsed create form and toggle button', () => {
        const content = fs.readFileSync(path.resolve(__dirname, '../../src/static/js/modules/members/events.js'), 'utf8');
        expect(content).toContain('memberEventOpenFormBtn');
        expect(content).toContain('memberEventCreateForm');
        expect(content).toContain('setMemberEventFormVisible(false)');
    });

    test('album photo delete button is limited to uploader or admin in frontend', () => {
        const content = fs.readFileSync(path.resolve(__dirname, '../../src/static/js/modules/albums.js'), 'utf8');
        expect(content).toContain('isAdmin || String(photo.uploaded_by_member_id || \'\') === String(currentUserId || \'\')');
    });

    test('casting display appends extra suffix without duplication', () => {
        const content = fs.readFileSync(path.resolve(__dirname, '../../src/static/js/modules/practice_casting/render.js'), 'utf8');
        expect(content).toContain('extraDisplayName');
        expect(content).toContain('base.includes(\'（エキストラ）\') ? base');
    });

    test('piece info menu uses updated label', () => {
        const helpers = fs.readFileSync(path.resolve(__dirname, '../../src/static/js/modules/navigation/helpers.js'), 'utf8');
        const menu = fs.readFileSync(path.resolve(__dirname, '../../src/static/js/modules/navigation/menu.js'), 'utf8');
        expect(helpers).toContain('\u697d\u66f2\u60c5\u5831');
        expect(menu).toContain('\u697d\u66f2\u60c5\u5831');
    });

    test('member casting view does not use all-pieces fallback label', () => {
        const content = fs.readFileSync(path.resolve(__dirname, '../../src/static/js/modules/practice_casting/render.js'), 'utf8');
        expect(content).not.toContain("r.piece || '\u5168\u66f2'");
    });

    test('casting extra part uses configured select with other option and custom input', () => {
        const content = fs.readFileSync(path.resolve(__dirname, '../../src/static/js/modules/practice_casting/render.js'), 'utf8');
        expect(content).toContain('sortedPartSettings()');
        expect(content).toContain('data-extra-part-select-index');
        expect(content).toContain('__other__');
        expect(content).toContain('data-extra-custom-part-index');
    });

    test('desired piece list hides registrant and own profile uses dedicated endpoint', () => {
        const desiredPieceContent = fs.readFileSync(
            path.resolve(__dirname, '../../src/static/js/modules/date_piece_promotion/render_desired_promotion.js'),
            'utf8'
        );
        const profileContent = fs.readFileSync(
            path.resolve(__dirname, '../../src/static/js/modules/portal_views.js'),
            'utf8'
        );

        expect(desiredPieceContent.indexOf('registered_by || item.name')).toBe(-1);
        expect(profileContent).toContain(
            "/api/members/${encodeURIComponent(memberId)}/profile"
        );
        expect(profileContent).not.toContain('...current,');
    });
});
