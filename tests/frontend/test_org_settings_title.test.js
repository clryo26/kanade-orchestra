const {
    resolveOrgShortName,
    portalTitleTextFromOrg
} = require('../../src/static/js/frontend_testable_logic.js');

describe('org title fallback', () => {
    test('prefers short_name then abbreviation before generic fallback', () => {
        expect(resolveOrgShortName({ short_name: '奏' })).toBe('奏');
        expect(resolveOrgShortName({ organization_abbreviation: '奏' })).toBe('奏');
        expect(resolveOrgShortName({ abbreviation: '奏オケ' })).toBe('奏オケ');
        expect(resolveOrgShortName({ name: '奏オケ' })).toBe('奏オケ');
        expect(resolveOrgShortName({ organization_name: '楽団' })).toBe('楽団');
        expect(portalTitleTextFromOrg({ organization_abbreviation: '奏' })).toBe('奏ポータル');
    });
});
