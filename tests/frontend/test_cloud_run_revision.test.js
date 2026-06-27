const {
    cloudRunRevisionLabel
} = require('../../src/static/js/frontend_testable_logic.js');

describe('cloud run revision label', () => {
    test('extracts Cloud Run revision suffix from service revision name', () => {
        expect(cloudRunRevisionLabel('kanade-orchestra-00060-hsf')).toBe('00060-hsf');
    });

    test('keeps unknown revision format as-is', () => {
        expect(cloudRunRevisionLabel('20260617-1')).toBe('20260617-1');
    });
});
