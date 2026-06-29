const fs = require('node:fs');
const path = require('node:path');

describe('casting admin edit button', () => {
    const appJs = fs.readFileSync(path.resolve(__dirname, '../../src/static/js/app.js'), 'utf8');
    const castingAdminCode = appJs.slice(
        appJs.indexOf('function renderCastingAdmin()'),
        appJs.indexOf('async function saveCasting()')
    );

    test('registered casting edit buttons select records by casting id', () => {
        expect(castingAdminCode).toContain('data-casting-id=');
        expect(castingAdminCode).toContain('e.currentTarget.dataset.castingId');
        expect(castingAdminCode).toContain('loadCastingRecord(casting)');
    });

    test('loading a casting record does not clear copied members and extras', () => {
        expect(castingAdminCode).toContain('function setCastingEditor(casting, fallbackPerformanceId = null)');
        expect(castingAdminCode).toContain('appState.castingEditingMembers = Array.isArray(casting.members) ? casting.members.map((m) => ({ ...m })) : []');
        expect(castingAdminCode).toContain('appState.castingEditingExtras = Array.isArray(casting.extras) ? casting.extras.map((e) => ({ ...e })) : []');
        expect(castingAdminCode).not.toContain('clearCastingForm();\n    $(\'castingPieceInput\').value = appState.castingEditingPiece');
    });
});
