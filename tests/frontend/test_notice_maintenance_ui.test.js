import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const notices = read('src/static/js/modules/notices.js');
const index = read('src/index.html');
const bootstrap = read('src/backend/routers/bootstrap.py');

describe('maintenance information and new notice board separation', () => {
    it('keeps legacy announcements as maintenance information with date sorting and latest five', () => {
        expect(notices).toContain('sortedMaintenanceInfo()');
        expect(notices).toContain("String(b.date || '').localeCompare(String(a.date || ''))");
        expect(notices).toContain('sortedMaintenanceInfo().slice(0, 5)');
        expect(notices).toContain('メンテナンス情報');
        expect(notices).toContain('過去の情報');
        expect(notices).toContain('メンテナンス情報一覧');
    });

    it('moves legacy maintenance management from admin to system UI without changing legacy API', () => {
        expect(notices).toContain('#adminPanel .toolbar [data-tab="announcement"]');
        expect(notices).toContain('data-tab="system-maintenance-info"');
        expect(notices).toContain("maintenanceTab.id = 'system-maintenance-infoTab'");
        expect(notices).toContain('/api/announcements');
    });

    it('places maintenance between menu groups and action buttons by wrapping menu rendering', () => {
        expect(notices).toContain('baseRenderMenuGroupsForNotices(container);');
        expect(notices).toContain("actions.insertAdjacentHTML('beforebegin', maintenanceInfoHomeHtml())");
    });

    it('shows new notices at portal top sorted by created_at and truncated with existing classes', () => {
        expect(notices).toContain("String(b.created_at || '').localeCompare(String(a.created_at || ''))");
        expect(notices).toContain('sortedPortalNotices().slice(0, 5)');
        expect(notices).toContain('portal-announcement-one-line');
        expect(notices).toContain('portal-announcement-title');
        expect(notices).toContain('renderPortalHomeWithNewNotices');
    });

    it('restricts registration and editing according to requested roles and ownership', () => {
        expect(notices).toContain("new Set(['一般', '管理者', 'システム管理者'])");
        expect(notices).toContain("new Set(['管理者', 'システム管理者'])");
        expect(notices).toContain('notice.created_by_member_id');
        expect(notices).toContain('appState.currentUserMemberId');
    });

    it('provides register, history, detail and requested back labels', () => {
        expect(notices).toContain('お知らせ登録');
        expect(notices).toContain('過去の一覧');
        expect(notices).toContain('お知らせ一覧');
        expect(notices).toContain('お知らせ詳細');
        expect(notices).toContain('ポータルメニューに戻る');
        expect(notices).toContain('一覧に戻る');
    });

    it('lazy-loads the new integration before portal UI binding and registers its backend router', () => {
        const portalViews = read('src/static/js/modules/portal_views.js');
        expect(index).not.toContain('/static/js/modules/notices.js');
        expect(portalViews).toContain('function ensurePortalNoticesModuleLoaded()');
        expect(portalViews).toContain("script.src = '/static/js/modules/notices.js?v=20260812-2'");
        expect(portalViews.indexOf('ensurePortalNoticesModuleLoaded()'))
            .toBeLessThan(portalViews.indexOf("const announceContainer = $('portalHomeAnnouncements');"));
        expect(portalViews).toContain('portalNoticesModuleLoadPromise');
        expect(portalViews).toContain('setupPortalHome();');
        expect(notices).toContain('window.__KANADE_PORTAL_NOTICES_MODULE_LOADED__ = true;');
        expect(bootstrap).toContain('from .notices import router as notices_router');
        expect(bootstrap).toContain('router.include_router(notices_router)');
    });
});
