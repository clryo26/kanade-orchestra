const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../../src/static/js');

const files = [
    'auth_feature.js',
    'modules/admin_system/environment_management.js',
    'modules/navigation/helpers.js',
    'modules/practice_casting.js',
    'modules/performance_day/events.js',
    'modules/improvement_suggestions.js',
];

describe('non-standard API fetch paths', () => {
    test.each(files)('%s uses the shared timeout transport', (relativePath) => {
        const source = fs.readFileSync(path.join(root, relativePath), 'utf8');

        expect(source).toContain('fetchWithTimeout(');
        expect(source).not.toMatch(/\bfetch\s*\(/);
    });

    test('legacy bootstrap request fallback remains isolated from normal startup', () => {
        const source = fs.readFileSync(path.join(root, 'modules/bootstrap_loader.js'), 'utf8');

        expect(source).toContain('if (!includeHeavyLists) {');
        expect(source).toContain('data = await legacyBootstrapData(includeHeavyLists);');
    });
});
