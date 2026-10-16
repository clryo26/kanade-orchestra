const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function settingsContext({ target = '', permission = '一般', verified = true, ios = false } = {}) {
    const appState = { portalAuthVerified: verified, currentUserPermission: permission, currentUserMemberId: 1 };
    const window = {
        portalRuntimeContext: { appState }, location: { href: `https://portal.example/?notification=${encodeURIComponent(target)}` },
        history: { state: { portalNavigation: true }, replaceState: vi.fn() }, isSecureContext: true,
        matchMedia: () => ({ matches: false }), PushManager: {}, Notification: {}
    };
    const sandbox = {
        window, URL, navigator: { userAgent: ios ? 'iPhone' : 'Chrome', serviceWorker: {} },
        document: { getElementById: vi.fn(), querySelector: vi.fn(() => ({ click: vi.fn() })) },
        showMemberTab: vi.fn(), openPortalNoticeHistory: vi.fn(), openMaintenanceHistory: vi.fn(), showSystemPanel: vi.fn(),
        localStorage: { getItem: vi.fn(), removeItem: vi.fn(), setItem: vi.fn() }
    };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../src/static/js/modules/notifications/settings.js'), 'utf8'), sandbox);
    return sandbox;
}

describe('notification target routing', () => {
    it('preserves the target until authentication completes', async () => {
        const ctx = settingsContext({ target: 'member-schedule', verified: false });
        await ctx.window.PortalNotifications.restoreTarget();
        expect(ctx.showMemberTab).not.toHaveBeenCalled();
        expect(ctx.window.history.replaceState).not.toHaveBeenCalled();
    });
    it('uses existing member navigation and preserves the browser history state', async () => {
        const ctx = settingsContext({ target: 'member-schedule' });
        await ctx.window.PortalNotifications.restoreTarget();
        expect(ctx.showMemberTab).toHaveBeenCalledWith('member-schedule');
        expect(ctx.window.history.replaceState).toHaveBeenCalledWith(ctx.window.history.state, '', 'https://portal.example/');
    });
    it.each(['https://evil.example', 'system-improvement-suggestion'])('rejects unsafe or unauthorized target %s', async (target) => {
        const ctx = settingsContext({ target });
        await ctx.window.PortalNotifications.restoreTarget();
        expect(ctx.showMemberTab).not.toHaveBeenCalled();
        expect(ctx.showSystemPanel).not.toHaveBeenCalled();
    });
    it('does not open event adjustments for extras', async () => {
        const ctx = settingsContext({ target: 'member-event', permission: 'エキストラ' });
        await ctx.window.PortalNotifications.restoreTarget();
        expect(ctx.showMemberTab).not.toHaveBeenCalled();
    });
    it('opens system admin suggestions through the existing system panel', async () => {
        const ctx = settingsContext({ target: 'system-improvement-suggestion', permission: 'システム管理者' });
        await ctx.window.PortalNotifications.restoreTarget();
        expect(ctx.showSystemPanel).toHaveBeenCalledOnce();
    });
    it('explains the iPhone Home Screen requirement', () => {
        expect(settingsContext({ ios: true }).window.PortalNotifications.capabilities()).toContain('ホーム画面');
    });
    it('does not prompt for permission or subscribe when the module is loaded', () => {
        const ctx = settingsContext();
        expect(ctx.navigator.serviceWorker).toEqual({});
    });
});

function workerContext() {
    const listeners = {};
    const self = {
        addEventListener: (type, handler) => { listeners[type] = handler; },
        registration: { showNotification: vi.fn(async () => {}) },
        location: { origin: 'https://portal.example' },
        clients: { matchAll: vi.fn(async () => []), openWindow: vi.fn(async () => {}) }
    };
    const sandbox = { self, URL };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../src/static/sw.js'), 'utf8'), sandbox);
    return { self, listeners };
}

describe('push-only service worker', () => {
    it('shows background notifications and does not intercept fetches', async () => {
        const { self, listeners } = workerContext();
        let pending;
        listeners.push({ data: { json: () => ({ title: '通知', body: '本文', tag: 'event', target: 'member-sheet' }) }, waitUntil: (value) => { pending = value; } });
        await pending;
        expect(self.registration.showNotification).toHaveBeenCalledWith('通知', expect.objectContaining({ body: '本文', tag: 'event' }));
        expect(listeners.fetch).toBeUndefined();
    });
    it('opens only the portal origin even with an external payload target', async () => {
        const { self, listeners } = workerContext();
        let pending;
        listeners.notificationclick({ notification: { close: vi.fn(), data: { target: 'https://evil.example' } }, waitUntil: (value) => { pending = value; } });
        await pending;
        expect(new URL(self.clients.openWindow.mock.calls[0][0]).origin).toBe('https://portal.example');
    });
    it('reuses an existing portal window', async () => {
        const { self, listeners } = workerContext();
        const client = { url: 'https://portal.example/', navigate: vi.fn(async () => {}), focus: vi.fn(async () => {}) };
        self.clients.matchAll.mockResolvedValue([client]);
        let pending;
        listeners.notificationclick({ notification: { close: vi.fn(), data: { target: 'member-recording' } }, waitUntil: (value) => { pending = value; } });
        await pending;
        expect(client.navigate).toHaveBeenCalledOnce();
        expect(client.focus).toHaveBeenCalledOnce();
        expect(self.clients.openWindow).not.toHaveBeenCalled();
    });
});
