import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const menuSource = fs.readFileSync(path.join(root, 'src/static/js/modules/navigation/menu.js'), 'utf8');
const routesSource = fs.readFileSync(path.join(root, 'src/static/js/modules/navigation/routes.js'), 'utf8');
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
    expect(menuSource).toContain('void requestImprovementSuggestions()');
    expect(menuSource).not.toContain("typeof window.showImprovementSuggestions === 'function'");
    expect(routesSource).toContain('async function requestImprovementSuggestions()');
    expect(routesSource).toContain('await ensureImprovementSuggestionsLoaded()');
    expect(routesSource).toContain('await window.showImprovementSuggestions()');
    expect(css).not.toContain('.desktop-revision-footer');
    expect(css).not.toMatch(/\.portal-drawer\s+\.revision-inline\s*\{[^}]*display:\s*none\s*!important;/s);
  });

  it('classifies 修正中 as pending and 対応済 as completed', () => {
    expect(uiSource).toContain("item.status === '未対応' || item.status === '修正中'");
    expect(uiSource).toContain("item.status === '対応済'");
  });

  it('hides submitter names from the member list while keeping them in system management', () => {
    const memberStart = uiSource.indexOf('function memberCard(item, completed)');
    const memberEnd = uiSource.indexOf('function renderMemberLists()', memberStart);
    const memberBlock = uiSource.slice(memberStart, memberEnd);
    expect(memberBlock).not.toContain('item.registered_by');
    expect(memberBlock).toContain('formatDateTime(item.created_at)');

    const systemStart = uiSource.indexOf('function renderSystemList()');
    const systemEnd = uiSource.indexOf('async function loadSuggestions()', systemStart);
    const systemBlock = uiSource.slice(systemStart, systemEnd);
    expect(systemBlock).toContain('<th>登録者</th>');
    expect(systemBlock).toContain('escapeText(item.registered_by)');
  });

  it('splits the system list into pending (未対応・修正中) and completed sections', () => {
    const systemStart = uiSource.indexOf('function renderSystemList()');
    const systemEnd = uiSource.indexOf('async function loadSuggestions()', systemStart);
    const systemBlock = uiSource.slice(systemStart, systemEnd);
    expect(systemBlock).toContain('systemImprovementSuggestionPendingList');
    expect(systemBlock).toContain('systemImprovementSuggestionCompletedList');
    expect(systemBlock).toContain('未対応（未対応・修正中）');
    expect(systemBlock).toContain('未対応の改善案はありません。');
    expect(systemBlock).toContain('対応済みの改善案はありません。');
    expect(systemBlock).toContain('.sort(compareByRespondedAtDesc)');
  });

  it('orders completed items by responded_at desc with undated items last', () => {
    const start = uiSource.indexOf('function compareByRespondedAtDesc(a, b)');
    const end = uiSource.indexOf('function renderMemberLists()', start);
    expect(start).toBeGreaterThanOrEqual(0);
    const compare = new Function(`${uiSource.slice(start, end)}; return compareByRespondedAtDesc;`)();
    const sorted = [
      { id: 1, responded_at: '2026-10-01', created_at: '2026-09-01T00:00:00' },
      { id: 2, responded_at: null, created_at: '2026-10-10T00:00:00' },
      { id: 3, responded_at: '2026-10-15', created_at: '2026-08-01T00:00:00' },
      { id: 4, responded_at: '2026-10-01', created_at: '2026-09-05T00:00:00' },
      { id: 5, responded_at: '', created_at: '2026-10-20T00:00:00' },
    ].sort(compare);
    expect(sorted.map((item) => item.id)).toEqual([3, 1, 4, 2, 5]);
    expect(compare(sorted[1], sorted[2])).toBe(0);
    expect(compare(sorted[3], sorted[4])).toBe(0);
  });

  it('provides system laboratory PDF editor controls without Create behavior', () => {
    expect(uiSource).toContain('data-tab="system-laboratory"');
    expect(uiSource).toContain('id="system-laboratoryTab"');
    expect(uiSource).toContain('data-tab="system-pdf-editor"');
    expect(uiSource).toContain('id="system-pdf-editorTab"');
    expect(uiSource).toContain('id="pdfEditorFileInput"');
    expect(uiSource).toContain('accept="application/pdf,.pdf"');
    expect(uiSource).not.toContain('id="pdfEditorFileInput" type="file" multiple');
    expect(uiSource).toContain('selectedFiles.length !== 1');
    expect(uiSource).toContain("formData.append('file', file)");
    expect(uiSource).toContain('pdf-editor-part-select');
    expect(uiSource).toContain('pdf-editor-create-btn');
    expect(uiSource).not.toContain("querySelectorAll('.pdf-editor-create-btn')");
    expect(uiSource).not.toContain("querySelector('.pdf-editor-create-btn')");
    expect(uiSource).not.toContain('function createPdfEditor');
    expect(uiSource).not.toContain('function createPdf');
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
