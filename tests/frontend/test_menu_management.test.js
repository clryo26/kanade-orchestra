const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const source = (name) => fs.readFileSync(path.join(root, name), 'utf8');

function menus({ admin = true, system = true, extra = false, notifications } = {}) {
    const containers = new Map(['portalHomeMenu', 'portalDrawerMenu'].map((id) => [id, {
        innerHTML: '', querySelectorAll: () => [], querySelector: () => null,
    }]));
    const context = {
        window: null, document: { querySelectorAll: () => [] },
        paymentAlertInfo: () => ({ hasAlert: false }), orgShortName: () => '奏',
        canAccessAdmin: () => admin, canAccessSystemAdmin: () => system,
        canManageRecordings: () => admin, canManageSheets: () => admin,
        visibleMemberMenuItems: (items) => items.filter((item) => !extra ||
            !['member-payment', 'member-event', 'member-date-adjustment', 'member-desired-piece'].includes(item.tab)),
        escapeHtml: String, currentRevisionText: () => 'test', updateCloudRunRevision: vi.fn(),
    };
    context.window = context;
    context.portalRuntimeContext = { appState: {}, getById: (id) => containers.get(id) || null };
    vm.createContext(context);
    let menuSource = source('src/static/js/modules/navigation/menu.js');
    if (notifications === false) menuSource = menuSource.replace(/^.*\{ tab: 'notification-settings', label:.*\r?\n/m, '');
    if (notifications === true && !menuSource.includes("tab: 'notification-settings'")) {
        menuSource = menuSource.replace('const settingItems = [', "const settingItems = [\n        { tab: 'notification-settings', label: '通知設定' },");
    }
    vm.runInContext(menuSource, context);
    return { context, containers };
}

const keys = (context) => context.portalMenuGroups().flatMap((group) => group.items.map((item) => item.key));

test.each([false, true])('exact default menu keys match the catalog with notifications=%s', (notifications) => {
    const { context } = menus({ notifications });
    const configured = keys(context).filter((key) => key !== 'system');
    const backend = [...source('src/backend/services/menu_settings_service.py').matchAll(/\("([a-z-]+)", "[^"\n]+"\)/g)].map((match) => match[1]);
    expect(configured).toHaveLength(notifications ? 22 : 21);
    expect([...configured].sort()).toEqual(backend.filter((key) => notifications || key !== 'notification-settings').sort());
    expect(configured.includes('notification-settings')).toBe(notifications);
});

test.each([false, true])('every declared menu can be hidden and restored with notifications=%s', (notifications) => {
    const { context, containers } = menus({ notifications });
    const original = Array.from(keys(context));
    for (const key of original.filter((value) => value !== 'system')) {
        context.applyPortalMenuVisibility({ [key]: false });
        expect(Array.from(keys(context))).toEqual(original.filter((value) => value !== key));
        expect(containers.get('portalHomeMenu').innerHTML).toEqual(containers.get('portalDrawerMenu').innerHTML);
        context.applyPortalMenuVisibility({ [key]: true });
        expect(Array.from(keys(context))).toEqual(original);
    }
});

test('OFF hides the same item in home and drawer, retaining actions and routes', () => {
    const { context, containers } = menus();
    context.applyPortalMenuVisibility({ 'member-recording': false, 'notification-settings': false });
    const home = containers.get('portalHomeMenu').innerHTML;
    expect(home).toEqual(containers.get('portalDrawerMenu').innerHTML);
    expect(home).not.toContain('data-home-tab="member-recording"');
    expect(home).not.toContain('data-home-tab="notification-settings"');
    expect(home).toContain('data-drawer-action="manual"');
    expect(home).toContain('data-drawer-action="logout"');
    expect(home).toContain('data-home-tab="member-schedule"');
    context.applyPortalMenuVisibility({ 'member-recording': true });
    expect(containers.get('portalHomeMenu').innerHTML).toContain('data-home-tab="member-recording"');
});

test('groups disappear when empty and system entry ignores OFF', () => {
    const { context } = menus();
    context.applyPortalMenuVisibility({ 'member-schedule': false, 'member-practice-instruction': false, 'member-recording': false, system: false });
    expect(context.portalMenuGroups().map((group) => group.title)).not.toContain('練習情報');
    expect(keys(context)).toContain('system');
});

test('ON never overrides existing role restrictions', () => {
    const { context } = menus({ admin: false, system: false, extra: true });
    context.applyPortalMenuVisibility({ admin: true, system: true, upload: true, 'sheet-admin': true, 'member-payment': true });
    expect(keys(context)).not.toEqual(expect.arrayContaining(['admin']));
    for (const key of ['system', 'upload', 'sheet-admin', 'member-payment', 'member-event']) {
        expect(keys(context)).not.toContain(key);
    }
});

function management(request, { notifications = true } = {}) {
    const switches = [{ dataset: { menuKey: 'member-recording' }, checked: false, disabled: false }];
    const elements = new Map([
        ['systemMenuManagementList', { innerHTML: '', querySelectorAll: () => switches }],
        ['systemMenuManagementStatus', { textContent: '' }],
        ['systemMenuManagementSaveBtn', { disabled: false }],
    ]);
    const context = { window: null, request, escapeHtml: String, showAlert: vi.fn(), applyPortalMenuVisibility: vi.fn(),
        portalMenuGroups: vi.fn(() => [{ items: [{ key: 'member-recording' }, ...(notifications ? [{ key: 'notification-settings' }] : [])] }]),
    };
    context.window = context;
    context.portalRuntimeContext = { getById: (id) => elements.get(id) };
    vm.createContext(context);
    vm.runInContext(source('src/static/js/modules/admin_system/menu_management.js'), context);
    return { context, elements, switches };
}

test.each([false, true])('management excludes absent optional menus but keeps OFF menus with notifications=%s', (notifications) => {
    const { context, elements } = management(vi.fn(), { notifications });
    context.renderMenuManagementForm({ groups: [{ title: '設定', items: [
        { key: 'member-recording', label: '録音部屋' }, { key: 'notification-settings', label: '通知設定' },
    ] }], visibility: { 'member-recording': false, 'notification-settings': false }, optional_keys: ['notification-settings'] });
    const html = elements.get('systemMenuManagementList').innerHTML;
    expect(context.portalMenuGroups).toHaveBeenCalledWith({ includeHidden: true });
    expect([...html.matchAll(/data-menu-key="([^"]+)"/g)].map((match) => match[1])).toEqual(
        notifications ? ['member-recording', 'notification-settings'] : ['member-recording']
    );
    expect(html).not.toContain('checked');
});

test('editing does not apply until successful bulk save', async () => {
    const payload = { groups: [{ title: '練習情報', items: [{ key: 'member-recording', label: '録音部屋' }] }], visibility: { 'member-recording': false } };
    const request = vi.fn(async () => payload);
    const { context, elements } = management(request);
    expect(context.applyPortalMenuVisibility).not.toHaveBeenCalled();
    await context.saveSystemMenuSettings();
    expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({ visibility: payload.visibility });
    expect(context.applyPortalMenuVisibility).toHaveBeenCalledWith(payload.visibility);
    expect(elements.get('systemMenuManagementStatus').textContent).toBe('保存しました。');
});

test('failed save keeps live settings and draft, allowing retry', async () => {
    const { context, elements, switches } = management(vi.fn().mockRejectedValue(new Error('保存失敗')));
    await context.saveSystemMenuSettings();
    expect(context.applyPortalMenuVisibility).not.toHaveBeenCalled();
    expect(switches[0].checked).toBe(false);
    expect(switches[0].disabled).toBe(false);
    expect(elements.get('systemMenuManagementSaveBtn').disabled).toBe(false);
    expect(elements.get('systemMenuManagementStatus').textContent).toBe('保存失敗');
    expect(context.showAlert).not.toHaveBeenCalled();
});

test('failed management load disables save and never uses cache fallback', async () => {
    const request = vi.fn().mockRejectedValue(new Error('読み込み失敗'));
    const { context, elements } = management(request);
    await context.renderSystemMenuManagement();
    expect(request).toHaveBeenCalledWith('/api/system/menu-settings', { _forceRevalidate: true, _allowCacheFallback: false });
    expect(elements.get('systemMenuManagementSaveBtn').disabled).toBe(true);
    expect(context.applyPortalMenuVisibility).not.toHaveBeenCalled();
});

test('saving invalidates all bootstrap IndexedDB entries via the existing request runtime', () => {
    const context = { window: { portalRuntimeContext: { getById: vi.fn() } } };
    vm.createContext(context);
    vm.runInContext(source('src/static/js/modules/common_helpers/api_runtime.js'), context);
    expect(Array.from(context.mutationRelatedCacheKeys('/api/system/menu-settings'))).toEqual(
        expect.arrayContaining(['/api/bootstrap-lite', '/api/bootstrap-core', '/api/bootstrap', '/api/system/menu-settings'])
    );
});

test('bootstrap cache preview and latest response apply settings; legacy payload preserves them', () => {
    const { context, containers } = menus();
    Object.assign(context, {
        normalizeMemberSummaryCollection: (items) => items,
        refreshPartSelectOptions: vi.fn(), refreshVenueOptions: vi.fn(), applyOrgSettings: vi.fn(),
    });
    vm.runInContext(source('src/static/js/modules/bootstrap_loader.js'), context);
    context.updateManagerNavigationVisibility = vi.fn();
    context.applyBootstrapData({ menu_visibility: { 'member-recording': false } });
    expect(containers.get('portalHomeMenu').innerHTML).not.toContain('data-home-tab="member-recording"');
    context.applyBootstrapData({ performances: [] });
    expect(containers.get('portalDrawerMenu').innerHTML).not.toContain('data-home-tab="member-recording"');
    context.applyBootstrapData({ menu_visibility: { 'member-recording': true } });
    expect(containers.get('portalHomeMenu').innerHTML).toContain('data-home-tab="member-recording"');
    expect(containers.get('portalHomeMenu').innerHTML).toEqual(containers.get('portalDrawerMenu').innerHTML);
});
