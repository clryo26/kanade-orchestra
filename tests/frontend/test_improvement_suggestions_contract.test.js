import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const menuSource = fs.readFileSync(path.join(root, 'src/static/js/modules/navigation/menu.js'), 'utf8');
const uiSource = fs.readFileSync(path.join(root, 'src/static/js/modules/improvement_suggestions.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src/static/css/style.css'), 'utf8');

describe('improvement suggestion UI contract', () => {
  it('places revision and improvement entry point below the drawer actions on all devices', () => {
    const actionsStart = menuSource.indexOf('<div class="portal-drawer-actions">');
    const metaStart = menuSource.indexOf('<div class="portal-drawer-meta');
    expect(actionsStart).toBeGreaterThanOrEqual(0);
    expect(metaStart).toBeGreaterThan(actionsStart);

    const actionsBlock = menuSource.slice(actionsStart, metaStart);
    expect(actionsBlock).toContain('data-drawer-action="manual"');
    expect(actionsBlock).toContain('data-drawer-action="logout"');
    expect(actionsBlock).toContain('data-drawer-action="reload"');
    expect(actionsBlock).not.toContain('revision-inline');

    const metaEnd = menuSource.indexOf('</div>', metaStart);
    const metaBlock = menuSource.slice(metaStart, metaEnd);
    expect(metaBlock).toContain('revision-inline');
    expect(metaBlock).toContain('data-drawer-action="improvement"');
    expect(metaBlock.indexOf('revision-inline')).toBeLessThan(metaBlock.indexOf('data-drawer-action="improvement"'));

    expect(menuSource).toContain("container.querySelector('[data-drawer-action=\"improvement\"]')");
    expect(menuSource).toContain("typeof window.showImprovementSuggestions === 'function'");
    expect(menuSource).toContain('void window.showImprovementSuggestions()');
    expect(css).not.toContain('.desktop-revision-footer');
    expect(css).not.toMatch(/\.portal-drawer\s+\.revision-inline\s*\{[^}]*display:\s*none\s*!important;/s);
  });

  it('classifies 修正中 as pending and 対応済 as completed', () => {
    expect(uiSource).toContain("item.status === '未対応' || item.status === '修正中'");
    expect(uiSource).toContain("item.status === '対応済'");
  });

  it('provides system improvement management controls', () => {
    expect(uiSource).toContain('改善案管理');
    expect(uiSource).toContain('systemImprovementSuggestionResolution');
    expect(uiSource).toContain('value="修正中"');
    expect(uiSource).toContain('systemImprovementSuggestionRespondedAt');
    expect(uiSource).toContain('systemImprovementSuggestionEditBtn');
    expect(uiSource).toContain('systemImprovementSuggestionDeleteBtn');
  });
});
