const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

describe.each(['modules/common_helpers/pure.js', 'testable/pieces.js'])('encore labels: %s', (file) => {
    function load() {
        const sandbox = { window: { portalRuntimeContext: { appState: {} } }, module: { exports: {} } };
        vm.createContext(sandbox);
        vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../src/static/js', file), 'utf8'), sandbox);
        return file.startsWith('testable/') ? sandbox.module.exports : sandbox;
    }

    test('adds the encore suffix after the short and formal title', () => {
        const helpers = load();
        const piece = { title: '曲名', composer: '作曲者', alias: '略称', is_encore: true };
        expect(helpers.performancePieceLabel(piece)).toBe('略称(アンコール)');
        expect(helpers.performancePieceFormalLabel(piece)).toBe('作曲者: 曲名(アンコール)');
        expect(helpers.performancePieceLabel({ title: '曲名', encore: true })).toBe('曲名(アンコール)');
        expect(helpers.performancePieceLabel({ title: '通常曲' })).toBe('通常曲');
        expect(helpers.performancePieceLabel('文字列曲名')).toBe('文字列曲名');
    });

    test('matches saved rows under both the old and new encore names', () => {
        const helpers = load();
        const piece = { title: '曲名', composer: '作曲者', alias: '略称', is_encore: true };
        for (const label of ['(略称)', '(作曲者: 曲名)', '略称(アンコール)', '作曲者: 曲名(アンコール)']) {
            const row = { performance_id: 1, piece: label };
            expect(helpers.findPieceScopedItem([row], 1, piece)).toBe(row);
            expect(helpers.findPieceScopedItem([row], 2, piece)).toBeUndefined();
        }
    });
});
