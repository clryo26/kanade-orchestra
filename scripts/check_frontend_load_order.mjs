#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const indexHtml = readFileSync('src/index.html', 'utf-8');
const legacyLoader = readFileSync('src/static/js/app.js', 'utf-8');

function collectIndexScripts(content) {
  const scripts = [];
  const regex = /<script\s+src="([^"]+)"/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    if (match[1].startsWith('/static/js/')) {
      scripts.push(match[1].replace('/static/js/', '/static/js/').split('?')[0]);
    }
  }
  return scripts;
}

function collectLegacyScripts(content) {
  const scripts = [];
  const regex = /'\/static\/js\/[^']+'/g;
  const matches = content.match(regex) || [];
  for (const token of matches) {
    scripts.push(token.slice(1, -1));
  }
  return scripts;
}

function ensureNoDuplicates(paths, sourceName) {
  const seen = new Set();
  const duplicates = new Set();
  for (const path of paths) {
    if (seen.has(path)) {
      duplicates.add(path);
    }
    seen.add(path);
  }
  if (duplicates.size > 0) {
    throw new Error(`${sourceName} has duplicate script entries: ${Array.from(duplicates).join(', ')}`);
  }
}

function ensureOrder(paths, sourceName) {
  const expected = [
    '/static/js/store/app_state.js',
    '/static/js/utils/runtime_context.js',
    '/static/js/main.js',
    '/static/js/modules/navigation/helpers.js',
    '/static/js/modules/navigation/tabs.js',
    '/static/js/modules/navigation/menu.js',
    '/static/js/modules/navigation/routes.js',
    '/static/js/modules/navigation/events.js',
    '/static/js/modules/navigation.js',
  ];

  let currentIndex = -1;
  for (const expectedPath of expected) {
    const foundIndex = paths.indexOf(expectedPath);
    if (foundIndex === -1) {
      throw new Error(`${sourceName} missing required script: ${expectedPath}`);
    }
    if (foundIndex <= currentIndex) {
      throw new Error(`${sourceName} order violation around ${expectedPath}`);
    }
    currentIndex = foundIndex;
  }
}

const indexScripts = collectIndexScripts(indexHtml);
const legacyScripts = collectLegacyScripts(legacyLoader);

ensureNoDuplicates(indexScripts, 'src/index.html');
ensureNoDuplicates(legacyScripts, 'src/static/js/app.js');
ensureOrder(indexScripts, 'src/index.html');
ensureOrder(legacyScripts, 'src/static/js/app.js');

console.log(`Frontend load-order check passed: index=${indexScripts.length}, legacy=${legacyScripts.length}`);
