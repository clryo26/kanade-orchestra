const fs = require('node:fs');
const path = require('node:path');
const { performanceFormLayoutContract } = require('../../src/static/js/frontend_testable_logic.js');

describe('performance form layout', () => {
    test('flyer image field is rendered below the piece list', () => {
        const html = fs.readFileSync(path.resolve(__dirname, '../../src/index.html'), 'utf8');
        const contract = performanceFormLayoutContract();
        const pieceListIndex = html.indexOf(`id="${contract.pieceListId}"`);
        const flyerFileIndex = html.indexOf(`id="${contract.flyerFileId}"`);

        expect(pieceListIndex).toBeGreaterThan(-1);
        expect(flyerFileIndex).toBeGreaterThan(pieceListIndex);
    });

    test('member performance list renders formal piece names', () => {
        const contract = performanceFormLayoutContract();
        expect(contract.memberPerformance.pieceLabelMode).toBe('formal');
    });

    test('member performance flyer is rendered below piece names', () => {
        const contract = performanceFormLayoutContract();
        expect(contract.memberPerformance.flyerPreviewClass).toBe('performance-flyer-preview');
        expect(contract.memberPerformance.pieceListBeforeFlyer).toBe(true);
    });
});
