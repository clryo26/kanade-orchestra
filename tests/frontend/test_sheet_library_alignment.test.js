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

    test('recording room uses sheet library collapse classes', () => {
        const source = fs.readFileSync(path.resolve(__dirname, '../../src/static/js/recordings_feature.js'), 'utf8');
        const contract = sheetLibraryHeadingContract();

        expect(source).toContain('sheet-library-details recording-date-group');
        expect(source).toContain('sheet-library-details recording-piece-group');
        expect(source).toContain(contract.headingClass);
        expect(source).not.toContain('files-collapsed');
        expect(source).not.toContain('recording-summary');
    });
});
