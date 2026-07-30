const fs = require('node:fs');
const path = require('node:path');

describe('ui requirement regression', () => {
    test('member concert info uses HH:mm clock display', () => {
        const content = fs.readFileSync(path.resolve(__dirname, '../../src/static/js/modules/members/render.js'), 'utf8');
        expect(content).toContain('formatClockTime(perf.open_time)');
        expect(content).toContain('formatClockTime(perf.start_time)');
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
});
