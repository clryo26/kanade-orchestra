const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '../..');

function element() {
    return {
        innerHTML: '', hidden: false, dataset: {},
        querySelectorAll: vi.fn(() => []),
    };
}

function sandboxForPermissionManagement(request) {
    const elements = new Map([
        ['systemPermissionManagementList', element()],
        ['systemPermissionManagementStatus', element()],
    ]);
    const sandbox = {
        window: null, globalThis: null, console, request, showAlert: vi.fn(),
        escapeHtml: (value) => String(value ?? ''),
        withButtonStatus: (_button, _label, action) => action(),
        portalRuntimeContext: { appState: { members: [] }, getById: (id) => elements.get(id) || null },
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.runInNewContext(
        fs.readFileSync(path.join(ROOT, 'src/static/js/modules/admin_system/permission_management.js'), 'utf8'),
        sandbox,
    );
    return { sandbox, elements };
}

test('system permission management lists registered members and grants only the system permission', async () => {
    const request = vi.fn(async (url, options) => {
        if (url === '/api/system/members') return [{ id: 12, name: '団員A', part: 'Vn', permission: '一般' }];
        if (url === '/api/system/members/12/permission') {
            expect(options.method).toBe('PUT');
            expect(JSON.parse(options.body)).toEqual({ permission: 'システム管理者' });
            return { id: 12, permission: 'システム管理者' };
        }
        throw new Error(`unexpected request: ${url}`);
    });
    const { sandbox, elements } = sandboxForPermissionManagement(request);

    await sandbox.renderSystemPermissionManagement();
    expect(elements.get('systemPermissionManagementList').innerHTML).toContain('団員A');
    expect(elements.get('systemPermissionManagementList').innerHTML).toContain('現在の権限: 一般');
    expect(elements.get('systemPermissionManagementList').innerHTML).toContain('システム管理者を付与');

    await sandbox.grantSystemPermission('12');
    expect(request).toHaveBeenCalledWith('/api/system/members/12/permission', expect.any(Object));
});

test('member registration retains the disabled current-value display for system admin only', () => {
    const indexHtml = fs.readFileSync(path.join(ROOT, 'src/index.html'), 'utf8');
    const memberForm = fs.readFileSync(path.join(ROOT, 'src/static/js/modules/members/form.js'), 'utf8');
    expect(indexHtml).toMatch(/<option value="システム管理者" disabled>システム管理者<\/option>/);
    expect(indexHtml).toContain('<option value="一般">一般</option>');
    expect(indexHtml).toContain('<option value="エキストラ">エキストラ</option>');
    expect(indexHtml).toContain('<option value="管理者">管理者</option>');
    expect(indexHtml).toContain('data-tab="system-permission-management"');
    expect(memberForm).toContain("$('memberPermission').value = detail.permission || '一般';");
});
