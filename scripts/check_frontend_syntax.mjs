#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const roots = ['src/static/js'];
const ignoredDirs = new Set(['node_modules', '.git', '.venv']);
const files = [];

function walk(path) {
  for (const entry of readdirSync(path)) {
    const fullPath = join(path, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      if (!ignoredDirs.has(entry)) walk(fullPath);
      continue;
    }
    if (entry.endsWith('.js')) files.push(fullPath);
  }
}

for (const root of roots) walk(root);
files.sort();

let failed = false;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) failed = true;
}

if (failed) {
  console.error('Frontend syntax check failed.');
  process.exit(1);
}

console.log(`Frontend syntax check passed: ${files.length} files`);
