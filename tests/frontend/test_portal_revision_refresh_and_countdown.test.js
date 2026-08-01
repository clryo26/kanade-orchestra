const fs = require('node:fs');
const path = require('node:path');

function readSource(relativePath) {
    return fs.readFileSync(
        path.resolve(__dirname, '..', '..', relativePath),
        'utf8'
    );
}

function occurrenceCount(text, token) {
    return text.split(token).length - 1;
}

describe('portal revision-aware refresh contract', () => {
    const bootstrap = readSource(
        'src/static/js/modules/bootstrap_loader.js'
    );
    const diagnostics = readSource(
        'src/static/js/modules/admin_system/diagnostics.js'
    );
    const events = readSource(
        'src/static/js/modules/navigation/events.js'
    );
    const menu = readSource(
        'src/static/js/modules/navigation/menu.js'
    );

    test('stores and reads the revision loaded by the current tab', () => {
        expect(bootstrap).toContain(
            "sessionStorage.getItem('portalLoadedCloudRunRevision')"
        );
        expect(bootstrap).toContain(
            "sessionStorage.setItem(\n" +
            "                        'portalLoadedCloudRunRevision',"
        );
        expect(diagnostics).toContain(
            "sessionStorage.setItem(\n" +
            "                    'portalLoadedCloudRunRevision',"
        );
    });

    test('checks the latest revision without using a cached response', () => {
        expect(bootstrap).toContain(
            "requestJson(revisionUrl, { cache: 'no-store' })"
        );
        expect(bootstrap).toContain(
            'loadedRevision && latestRevision && loadedRevision !== latestRevision'
        );
        expect(bootstrap).toContain(
            'await reloadPortalForRevision(latestRevision)'
        );
    });

    test('reloads the versioned page for the latest revision', () => {
        expect(bootstrap).toContain(
            "reloadUrl.searchParams.set('_portal_revision', latestRevision)"
        );
        expect(bootstrap).toContain(
            'window.location.replace(reloadUrl.toString())'
        );
        expect(bootstrap).not.toContain("cache: 'reload'");
    });

    test('all three portal update controls use the revision-aware refresh', () => {
        expect(
            occurrenceCount(events, 'void refreshPortalWithRevisionCheck();')
        ).toBe(2);
        expect(
            occurrenceCount(menu, 'void refreshPortalWithRevisionCheck();')
        ).toBe(1);
    });
});

describe('performance countdown contract', () => {
    const portalViews = readSource(
        'src/static/js/modules/portal_views.js'
    );
    const memberRender = readSource(
        'src/static/js/modules/members/render.js'
    );
    const performanceDayMessage =
        '\u672c\u756a\u5f53\u65e5\uff01' +
        '\u9811\u5f35\u308a\u307e\u3057\u3087\u3046\uff01\uff01';

    test.each([
        ['portal home', portalViews],
        ['member performances', memberRender],
    ])('%s shows the performance-day message when countdown is zero', (
        _name,
        source
    ) => {
        expect(source).toContain('const countdownLabel = countdown === 0');
        expect(source).toContain(performanceDayMessage);
        expect(source).toContain('${countdownLabel}');
    });
});

describe('changed asset versions', () => {
    const indexHtml = readSource('src/index.html');

    test.each([
        '/static/js/modules/bootstrap_loader.js?v=20260802-1',
        '/static/js/modules/navigation/menu.js?v=20260802-1',
        '/static/js/modules/navigation/events.js?v=20260802-1',
        '/static/js/modules/admin_system/diagnostics.js?v=20260802-1',
        '/static/js/modules/portal_views.js?v=20260802-1',
        '/static/js/modules/members/render.js?v=20260802-1',
    ])('includes %s', (assetUrl) => {
        expect(indexHtml).toContain(assetUrl);
    });
});
