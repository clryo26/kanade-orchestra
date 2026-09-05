import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const indexHtml = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
const bootstrapLoader = fs.readFileSync(
    path.join(root, 'src/static/js/modules/bootstrap_loader.js'),
    'utf8'
);
const bootstrapInit = fs.readFileSync(
    path.join(root, 'src/static/js/modules/common_helpers/bootstrap_init.js'),
    'utf8'
);

describe('startup progress messages', () => {
    it('shows a useful message before JavaScript startup begins', () => {
        expect(indexHtml).toContain(
            '<p id="portalStartupMessage">起動を準備しています...</p>'
        );
    });

    it('maps actual startup markers to visible processing stages', () => {
        expect(bootstrapLoader).toContain("name === 'IDB_START'");
        expect(bootstrapLoader).toContain(
            "window.portalStartup.setMessage('端末データを準備しています...')"
        );
        expect(bootstrapLoader).toContain("name === 'UI_BIND_START'");
        expect(bootstrapLoader).toContain(
            "window.portalStartup.setMessage('画面を準備しています...')"
        );
        expect(bootstrapLoader).toContain("name === 'AUTH_START'");
        expect(bootstrapLoader).toContain(
            "window.portalStartup.setMessage('認証を確認しています...')"
        );
    });

    it('keeps the existing authenticated data-loading stage', () => {
        expect(bootstrapInit).toContain('データを読み込んでいます');
    });

    it('does not add another initial script tag', () => {
        const matches = indexHtml.match(/<script\b/g);
        expect(matches).not.toBeNull();
        expect(matches.length).toBe(43);
    });
});
