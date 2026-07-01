const { loginRevisionUiContract } = require('../../src/static/js/frontend_testable_logic.js');

describe('login revision refresh controls', () => {
    const contract = loginRevisionUiContract();

    test('login screen renders refresh button and revision label', () => {
        expect(contract.reloadButtonId).toBe('portalLoginReloadBtn');
        expect(contract.revisionAttribute).toBe('data-revision-number');
    });

    test('login refresh button reloads the page', () => {
        expect(contract.loadingLabel).toBe('更新中...');
        expect(contract.refreshAction).toBe('window.location.reload()');
    });
});
