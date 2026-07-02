#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { globSync } from 'glob';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const targetFiles = globSync('src/static/js/**/*.js', {
  cwd: projectRoot,
  absolute: true,
  nodir: true,
  windowsPathsNoEscape: true,
});

const allowWindowAppStateFiles = new Set([
  normalizePath(resolve(projectRoot, 'src/static/js/store/app_state.js')),
  normalizePath(resolve(projectRoot, 'src/static/js/utils/runtime_context.js')),
]);

const allowPortalAppStateFiles = new Set([
  normalizePath(resolve(projectRoot, 'src/static/js/store/app_state.js')),
  normalizePath(resolve(projectRoot, 'src/static/js/utils/runtime_context.js')),
]);

function normalizePath(path) {
  return path.replace(/\\/g, '/');
}

function removeCommentsAndStrings(code) {
  let output = '';
  let i = 0;
  let state = 'normal';
  let templateDepth = 0;

  while (i < code.length) {
    const ch = code[i];
    const next = code[i + 1];

    if (state === 'normal') {
      if (ch === '/' && next === '/') {
        state = 'lineComment';
        output += '  ';
        i += 2;
        continue;
      }
      if (ch === '/' && next === '*') {
        state = 'blockComment';
        output += '  ';
        i += 2;
        continue;
      }
      if (ch === "'") {
        state = 'singleQuote';
        output += ' ';
        i += 1;
        continue;
      }
      if (ch === '"') {
        state = 'doubleQuote';
        output += ' ';
        i += 1;
        continue;
      }
      if (ch === '`') {
        state = 'template';
        templateDepth = 0;
        output += ' ';
        i += 1;
        continue;
      }
      output += ch;
      i += 1;
      continue;
    }

    if (state === 'lineComment') {
      if (ch === '\n') {
        state = 'normal';
        output += '\n';
      } else {
        output += ' ';
      }
      i += 1;
      continue;
    }

    if (state === 'blockComment') {
      if (ch === '*' && next === '/') {
        state = 'normal';
        output += '  ';
        i += 2;
      } else {
        output += ch === '\n' ? '\n' : ' ';
        i += 1;
      }
      continue;
    }

    if (state === 'singleQuote') {
      if (ch === '\\') {
        output += '  ';
        i += 2;
        continue;
      }
      if (ch === "'") {
        state = 'normal';
      }
      output += ch === '\n' ? '\n' : ' ';
      i += 1;
      continue;
    }

    if (state === 'doubleQuote') {
      if (ch === '\\') {
        output += '  ';
        i += 2;
        continue;
      }
      if (ch === '"') {
        state = 'normal';
      }
      output += ch === '\n' ? '\n' : ' ';
      i += 1;
      continue;
    }

    if (state === 'template') {
      if (ch === '\\') {
        output += '  ';
        i += 2;
        continue;
      }
      if (ch === '`' && templateDepth === 0) {
        state = 'normal';
        output += ' ';
        i += 1;
        continue;
      }
      if (ch === '$' && next === '{') {
        templateDepth += 1;
        output += '  ';
        i += 2;
        continue;
      }
      if (ch === '}' && templateDepth > 0) {
        templateDepth -= 1;
      }
      output += ch === '\n' ? '\n' : ' ';
      i += 1;
    }
  }

  return output;
}

function lineAndColumnFromIndex(text, index) {
  const before = text.slice(0, index);
  const line = before.split('\n').length;
  const lastBreak = before.lastIndexOf('\n');
  const col = index - lastBreak;
  return { line, col };
}

const checks = [
  {
    id: 'window.appState',
    pattern: /\bwindow\.appState\b/g,
    allowFiles: allowWindowAppStateFiles,
    message: 'Use window.getAppState() or window.portalRuntimeContext.appState instead of window.appState',
  },
  {
    id: 'window.portalAppState',
    pattern: /\bwindow\.portalAppState\b/g,
    allowFiles: allowPortalAppStateFiles,
    message: 'Use window.getAppState() or window.portalRuntimeContext.appState instead of window.portalAppState',
  },
];

const violations = [];

for (const absPath of targetFiles) {
  const normalized = normalizePath(absPath);
  const source = readFileSync(absPath, 'utf-8');
  const sanitized = removeCommentsAndStrings(source);

  for (const check of checks) {
    if (check.allowFiles.has(normalized)) {
      continue;
    }
    let match;
    while ((match = check.pattern.exec(sanitized)) !== null) {
      const position = lineAndColumnFromIndex(sanitized, match.index);
      violations.push({
        file: normalizePath(relative(projectRoot, absPath)),
        line: position.line,
        col: position.col,
        rule: check.id,
        message: check.message,
      });
    }
    check.pattern.lastIndex = 0;
  }
}

if (violations.length > 0) {
  console.error('Frontend state-access rule violations found:');
  for (const item of violations) {
    console.error(`- ${item.file}:${item.line}:${item.col} [${item.rule}] ${item.message}`);
  }
  process.exit(1);
}

console.log(`Frontend state-access check passed: ${targetFiles.length} files scanned, 0 violations.`);
