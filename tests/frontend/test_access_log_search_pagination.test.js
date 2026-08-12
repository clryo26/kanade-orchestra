const fs = require('node:fs');
const path = require('node:path');

describe('access log search and pagination', () => {
    test('dedicated access-log module provides filters and fixed 100-row paging', () => {
        const content = fs.readFileSync(
            path.resolve(__dirname, '../../src/static/js/modules/admin_system/access_logs.js'),
            'utf8'
        );

        expect(content).toContain('var ACCESS_LOG_PAGE_SIZE = 100;');
        expect(content).toContain('accessLogDateFrom');
        expect(content).toContain('accessLogDateTo');
        expect(content).toContain('accessLogMemberId');
        expect(content).toContain('accessLogMemberPart');
        expect(content).toContain("date.setDate(date.getDate() + 1)");
        expect(content).toContain("params.set('page', String(page))");
        expect(content).toContain('accessLogPagination');
        expect(content).toContain('条件なしの場合は全ログを対象にします。');
        expect(content).not.toContain('/api/system/access-logs?limit=200');
    });

    test('access-log tab lazy-loads the dedicated module and prepares without auto-search', () => {
        const routes = fs.readFileSync(
            path.resolve(__dirname, '../../src/static/js/modules/navigation/routes.js'),
            'utf8'
        );

        expect(routes).toContain('/static/js/modules/admin_system/access_logs.js?v=20260812-1');
        expect(routes).toContain("if (typeof prepareAccessLogView !== 'function')");
        expect(routes).toContain('prepareAccessLogView();');
        expect(routes).not.toContain(
            "if (renderOnShow && tabName === 'system-access-log') renderAccessLogView();"
        );
    });
});
