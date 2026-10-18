#!/usr/bin/env node
// Generates the metronome release ids from file content and writes them
// into every file (same idea as generate_tuner_release.mjs).
//
// - Shared audio files (src/static/js/modules/audio/*.js) get one id "a-…",
//   written into their `AUDIO_RELEASE_ID = '…'` line.
// - Metronome files (src/static/js/modules/metronome/*.js and
//   src/static/css/metronome.css) get one id "m-…". Its hash includes the
//   shared audio id, so a change of the shared code also changes every
//   metronome URL (design 2: 共有資産hashもconsumer manifestへ含める).
// - The launcher's `METRONOME_AUDIO_RELEASE_ID` names the audio release it
//   loads; the laboratory module carries the launcher URL with ?rev=m-….
//
// Usage:
//   node scripts/generate_metronome_release.mjs          # rewrite ids
//   node scripts/generate_metronome_release.mjs --check  # fail if ids are stale
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const METRONOME_DIR = join(projectRoot, 'src', 'static', 'js', 'modules', 'metronome');
const AUDIO_DIR = join(projectRoot, 'src', 'static', 'js', 'modules', 'audio');
const METRONOME_CSS = join(projectRoot, 'src', 'static', 'css', 'metronome.css');
const LAUNCHER_LOADER = join(projectRoot, 'src', 'static', 'js', 'modules', 'improvement_suggestions.js');
const M_PATTERN = /(METRONOME_RELEASE_ID = ')([^']*)(')/g;
const A_PATTERN = /(AUDIO_RELEASE_ID = ')([^']*)(')/g;
const LINK_PATTERN = /(METRONOME_AUDIO_RELEASE_ID = ')([^']*)(')/g;
const LAUNCHER_TAG_PATTERN = /(\/static\/js\/modules\/metronome\/launcher\.js\?rev=)([^"']*)/g;

function listJs(dir) {
  return readdirSync(dir).filter((n) => n.endsWith('.js')).sort().map((n) => join(dir, n));
}

export function audioFiles() {
  return listJs(AUDIO_DIR);
}

export function metronomeFiles() {
  const files = listJs(METRONOME_DIR);
  if (existsSync(METRONOME_CSS)) files.push(METRONOME_CSS);
  return files;
}

function normalized(content) {
  // Line endings normalised (Windows checkouts hash like CI); id lines blanked.
  return content.replace(/\r\n/g, '\n').replace(M_PATTERN, '$1$3').replace(A_PATTERN, '$1$3').replace(LINK_PATTERN, '$1$3');
}

function hashFiles(prefix, files, extra = '') {
  const hash = createHash('sha256');
  hash.update(extra);
  for (const file of files) {
    hash.update(relative(projectRoot, file).replace(/\\/g, '/'));
    hash.update('\0');
    hash.update(normalized(readFileSync(file, 'utf8')));
    hash.update('\0');
  }
  return `${prefix}-${hash.digest('hex').slice(0, 12)}`;
}

export function computeReleases() {
  const audio = hashFiles('a', audioFiles());
  const metronome = hashFiles('m', metronomeFiles(), audio);
  return { audio, metronome };
}

function idsIn(content, pattern) {
  return [...content.matchAll(pattern)].map((m) => m[2]);
}

export function checkReleases() {
  const { audio, metronome } = computeReleases();
  const problems = [];
  const rel = (f) => relative(projectRoot, f).replace(/\\/g, '/');
  for (const file of audioFiles()) {
    const ids = idsIn(readFileSync(file, 'utf8'), A_PATTERN);
    if (!ids.length) problems.push(`${rel(file)}: missing AUDIO_RELEASE_ID`);
    ids.filter((id) => id !== audio).forEach((id) => problems.push(`${rel(file)}: ${id} != ${audio}`));
  }
  for (const file of metronomeFiles().filter((f) => f.endsWith('.js'))) {
    const content = readFileSync(file, 'utf8');
    const ids = idsIn(content, M_PATTERN);
    if (!ids.length) problems.push(`${rel(file)}: missing METRONOME_RELEASE_ID`);
    ids.filter((id) => id !== metronome).forEach((id) => problems.push(`${rel(file)}: ${id} != ${metronome}`));
    idsIn(content, LINK_PATTERN).filter((id) => id !== audio).forEach((id) => problems.push(`${rel(file)}: audio ${id} != ${audio}`));
  }
  const loaderIds = idsIn(readFileSync(LAUNCHER_LOADER, 'utf8'), LAUNCHER_TAG_PATTERN);
  if (loaderIds.length !== 1) problems.push(`${rel(LAUNCHER_LOADER)}: expected one metronome launcher.js?rev= URL, found ${loaderIds.length}`);
  loaderIds.filter((id) => id !== metronome).forEach((id) => problems.push(`${rel(LAUNCHER_LOADER)}: launcher ${id} != ${metronome}`));
  return { audio, metronome, problems };
}

export function writeReleases() {
  const { audio, metronome } = computeReleases();
  for (const file of audioFiles()) {
    const content = readFileSync(file, 'utf8');
    const next = content.replace(A_PATTERN, `$1${audio}$3`);
    if (next !== content) writeFileSync(file, next, 'utf8');
  }
  for (const file of metronomeFiles().filter((f) => f.endsWith('.js'))) {
    const content = readFileSync(file, 'utf8');
    const next = content.replace(M_PATTERN, `$1${metronome}$3`).replace(LINK_PATTERN, `$1${audio}$3`);
    if (next !== content) writeFileSync(file, next, 'utf8');
  }
  const loader = readFileSync(LAUNCHER_LOADER, 'utf8');
  const nextLoader = loader.replace(LAUNCHER_TAG_PATTERN, `$1${metronome}`);
  if (nextLoader !== loader) writeFileSync(LAUNCHER_LOADER, nextLoader, 'utf8');
  return { audio, metronome };
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  if (process.argv.includes('--check')) {
    const { audio, metronome, problems } = checkReleases();
    if (problems.length) {
      console.error(`Metronome release ids are stale (expected ${metronome} / ${audio}). Run: npm run generate:metronome-release`);
      for (const p of problems) console.error(`  ${p}`);
      process.exit(1);
    }
    console.log(`Metronome release ids are current: ${metronome} (audio ${audio})`);
  } else {
    const { audio, metronome } = writeReleases();
    console.log(`Metronome release id: ${metronome} (audio ${audio})`);
  }
}
