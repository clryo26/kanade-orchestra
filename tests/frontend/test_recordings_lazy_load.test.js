const fs = require('fs');
const path = require('path');

function readSource(relativePath) {
    return fs.readFileSync(
        path.resolve(__dirname, '../..', relativePath),
        'utf8'
    );
}

describe('recordings lazy loading', () => {
    test('initial page excludes the recordings feature implementation', () => {
        const indexHtml = readSource('src/index.html');

        expect(indexHtml).toContain(
            '/static/js/modules/recordings.js?v=20260731-1'
        );
        expect(indexHtml).not.toContain(
            '/static/js/recordings_feature.js'
        );
    });

    test('recordings module loads the feature before rendering', () => {
        const source = readSource(
            'src/static/js/modules/recordings.js'
        );

        expect(source).toContain(
            'function ensureRecordingsFeatureLoaded()'
        );
        expect(source).toContain(
            "script.src = '/static/js/recordings_feature.js?v=20260731-1';"
        );
        expect(source).toMatch(
            /async function loadRecordings\(\)\s*\{\s*await ensureRecordingsFeatureLoaded\(\);/
        );
        expect(source).toMatch(
            /async function ensureRecordingsLoaded\(\)\s*\{\s*await ensureRecordingsFeatureLoaded\(\);/
        );
    });

    test('member home does not render recordings eagerly', () => {
        const source = readSource(
            'src/static/js/modules/members/render.js'
        );
        const match = source.match(
            /function renderMemberViews\(\)\s*\{([\s\S]*?)\n\}/
        );

        expect(match).not.toBeNull();
        expect(match[1]).not.toContain('renderRecordings();');
    });

    test('heavy initial rendering waits for the recordings feature', () => {
        const source = readSource(
            'src/static/js/modules/bootstrap_loader.js'
        );

        expect(source).toContain(
            'if (includeHeavyLists) void ensureRecordingsFeatureLoaded().then(renderRecordings);'
        );
    });
});
