import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const indexHtml = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
const uiSource = fs.readFileSync(path.join(root, 'src/static/js/modules/improvement_suggestions.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src/static/css/style.css'), 'utf8');

describe('improvement suggestion UI contract', () => {
  it('places revision and improvement entry point in the PC footer', () => {
    expect(indexHtml).toContain('desktop-revision-footer');
    expect(indexHtml).toContain('data-improvement-suggestion-open');
    expect(css).toContain('@media (min-width: 768px)');
    expect(css).toContain('.portal-drawer .revision-inline');
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
