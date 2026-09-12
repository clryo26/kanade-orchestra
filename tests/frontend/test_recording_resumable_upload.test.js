import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const source = fs.readFileSync(
  path.resolve(process.cwd(), 'src/static/js/modules/upload_forms.js'),
  'utf8',
);

describe('recording resumable upload contract', () => {
  test('uses a GCS resumable session and 8 MiB chunks', () => {
    expect(source).toContain("'/api/drive/upload/session'");
    expect(source).toContain("'/api/drive/upload/complete'");
    expect(source).toContain('8 * 1024 * 1024');
    expect(source).toContain('Content-Range');
    expect(source).toContain('queryResumableOffset');
  });

  test('does not proxy the recording body through the session API', () => {
    expect(source).not.toContain("body: audioFormData(file) });\n            completed");
  });
});