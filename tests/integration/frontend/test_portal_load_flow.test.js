const {
    loadAllEndpointFromOptions,
    renderInitialViewTargets
} = require('../../../src/static/js/frontend_testable_logic.js');

describe('IT-FE-FLOW integration', () => {
    test('IT-FE-FLOW-001 portal load path and initial view targets', () => {
        const endpoint = loadAllEndpointFromOptions({});
        const targets = renderInitialViewTargets(true);

        expect(endpoint).toBe('/api/bootstrap');
        expect(targets).toContain('renderPerformances');
        expect(targets).toContain('renderSchedules');
        expect(targets).toContain('renderAnnouncements');
        expect(targets).toContain('renderEvents');
        expect(targets).toContain('renderMembers');
        expect(targets).toContain('renderPortalHome');
    });

    test('IT-FE-FLOW-002 staged load keeps lightweight render set before heavy lists', () => {
        const endpoint = loadAllEndpointFromOptions({ includeHeavyLists: false });
        const targets = renderInitialViewTargets(false);

        expect(endpoint).toBe('/api/bootstrap-core');
        expect(targets).not.toContain('renderRecordings');
        expect(targets).not.toContain('renderSheetAdmin');
        expect(targets).toContain('renderPortalHome');
    });
});
