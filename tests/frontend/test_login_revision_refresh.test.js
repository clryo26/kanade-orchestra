const fs = require('node:fs');
const path = require('node:path');

describe('login revision refresh controls', () => {
    const appJs = fs.readFileSync(path.resolve(__dirname, '../../src/static/js/app.js'), 'utf8');

    test('login screen renders refresh button and revision label', () => {
        const showPortalLogin = appJs.slice(
            appJs.indexOf('function showPortalLogin()'),
            appJs.indexOf('async function handlePortalLogin()')
        );

        expect(showPortalLogin).toContain('id="portalLoginReloadBtn"');
        expect(showPortalLogin).toContain('data-revision-number');
        expect(showPortalLogin).toContain('updateCloudRunRevision()');
    });

    test('login refresh button reloads the page', () => {
        const showPortalLogin = appJs.slice(
            appJs.indexOf('function showPortalLogin()'),
            appJs.indexOf('async function handlePortalLogin()')
        );

        expect(showPortalLogin).toContain('portalLoginReloadBtn');
        expect(showPortalLogin).toContain("setLoadingBar('更新中...')");
        expect(showPortalLogin).toContain('window.location.reload()');
    });
});
