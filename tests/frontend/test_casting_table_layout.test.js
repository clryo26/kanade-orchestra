const fs = require('node:fs');
const path = require('node:path');
const { castingTableLayoutContract } = require('../../src/static/js/frontend_testable_logic.js');

describe('casting table layout', () => {
    test('member casting table keeps member names close to part labels', () => {
        const css = fs.readFileSync(path.resolve(__dirname, '../../src/static/css/style.css'), 'utf8');
        const contract = castingTableLayoutContract();

        expect(contract.tableClass).toBe('casting-table');
        expect(contract.partCellClass).toBe('casting-part-cell');
        expect(contract.membersCellClass).toBe('casting-members-cell');
        expect(css).toContain(`.${contract.tableClass} .${contract.partCellClass}`);
        expect(css).toContain(`padding-right: ${contract.css.partCellPaddingRight};`);
        expect(css).toContain(`padding-left: ${contract.css.membersCellPaddingLeft};`);
    });
});
