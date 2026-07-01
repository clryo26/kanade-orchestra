const fs = require('node:fs');
const path = require('node:path');
const { sheetLibraryHeadingContract } = require('../../src/static/js/frontend_testable_logic.js');

describe('sheet library alignment', () => {
    test('performance and piece headings use left-aligned heading class', () => {
        const contract = sheetLibraryHeadingContract();

        expect(contract.performanceHeadingTag).toBe('strong');
        expect(contract.pieceHeadingTag).toBe('span');
        expect(contract.headingClass).toBe('sheet-library-heading');
    });

    test('sheet library heading class is explicitly left aligned', () => {
        const css = fs.readFileSync(path.resolve(__dirname, '../../src/static/css/style.css'), 'utf8');
        const contract = sheetLibraryHeadingContract();

        expect(css).toContain(`.${contract.headingClass}`);
        expect(css).toContain(`text-align: ${contract.textAlign};`);
    });
});
