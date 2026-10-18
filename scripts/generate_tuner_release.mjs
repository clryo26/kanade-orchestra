#!/usr/bin/env node
// Generates the single tuner release id from the content of every tuner file
// and writes it into each file's `TUNER_RELEASE_ID = '...'` line.
//
// Why: tuner assets are requested with ?rev=<id>, which the static handler
// caches as immutable for a year. Deriving the id from file content means a
// changed file always gets a new URL, and every file (including the Worker,
// the AudioWorklet and the Worker's importScripts dependencies) can report
// which release it belongs to so mixed versions are detected at runtime.
//
// Usage:
//   node scripts/generate_tuner_release.mjs          # rewrite ids
//   node scripts/generate_tuner_release.mjs --check  # fail if ids are stale
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// The tuner plays through the shared output manager (modules/audio): its
// release id ("a-…", computed by the metronome generator from the same files)
// is part of the tuner hash and is written into the tuner launcher, which
// loads the shared module with that id (metronome design 2 / 4.1).
import { computeReleases } from './generate_metronome_release.mjs';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const TUNER_JS_DIR = join(projectRoot, 'src', 'static', 'js', 'modules', 'tuner');
const TUNER_CSS = join(projectRoot, 'src', 'static', 'css', 'tuner.css');
// The laboratory module loads the launcher (index.html's initial scripts stay unchanged).
const LAUNCHER_LOADER = join(projectRoot, 'src', 'static', 'js', 'modules', 'improvement_suggestions.js');
const ID_PATTERN = /(TUNER_RELEASE_ID = ')([^']*)(')/g;
const AUDIO_ID_PATTERN = /(TUNER_AUDIO_RELEASE_ID = ')([^']*)(')/g;
const TUNER_LAUNCHER = join(TUNER_JS_DIR, 'launcher.js');
// The launcher URL carries the same id, so the launcher itself is cache-busted too.
const LAUNCHER_TAG_PATTERN = /(\/static\/js\/modules\/tuner\/launcher\.js\?rev=)([^"']*)/g;

export function tunerFiles() {
  const scripts = readdirSync(TUNER_JS_DIR)
    .filter((name) => name.endsWith('.js'))
    .sort()
    .map((name) => join(TUNER_JS_DIR, name));
  return [...scripts, TUNER_CSS];
}

function normalized(content) {
  // Line endings are normalised so Windows checkouts hash the same as CI.
  return content.replace(/\r\n/g, '\n').replace(ID_PATTERN, '$1$3').replace(AUDIO_ID_PATTERN, '$1$3');
}

export function computeTunerRelease(files = tunerFiles()) {
  const hash = createHash('sha256');
  hash.update(`audio:${computeReleases().audio}\0`);
  for (const file of files) {
    const rel = relative(projectRoot, file).replace(/\\/g, '/');
    hash.update(rel);
    hash.update('\0');
    hash.update(normalized(readFileSync(file, 'utf8')));
    hash.update('\0');
  }
  return `t-${hash.digest('hex').slice(0, 12)}`;
}

export function checkTunerRelease(files = tunerFiles()) {
  const expected = computeTunerRelease(files);
  const problems = [];
  for (const file of files.filter((item) => item.endsWith('.js'))) {
    const content = readFileSync(file, 'utf8');
    const ids = [...content.matchAll(ID_PATTERN)].map((match) => match[2]);
    const rel = relative(projectRoot, file).replace(/\\/g, '/');
    if (ids.length === 0) problems.push(`${rel}: missing TUNER_RELEASE_ID`);
    for (const id of ids) {
      if (id !== expected) problems.push(`${rel}: ${id} != ${expected}`);
    }
  }
  const audio = computeReleases().audio;
  const audioIds = [...readFileSync(TUNER_LAUNCHER, 'utf8').matchAll(AUDIO_ID_PATTERN)].map((match) => match[2]);
  if (audioIds.length !== 1) problems.push(`src/static/js/modules/tuner/launcher.js: expected one TUNER_AUDIO_RELEASE_ID, found ${audioIds.length}`);
  for (const id of audioIds) if (id !== audio) problems.push(`src/static/js/modules/tuner/launcher.js: audio ${id} != ${audio}`);
  const loaderRel = relative(projectRoot, LAUNCHER_LOADER).replace(/\\/g, '/');
  const launcherIds = [...readFileSync(LAUNCHER_LOADER, 'utf8').matchAll(LAUNCHER_TAG_PATTERN)].map((match) => match[2]);
  if (launcherIds.length !== 1) problems.push(`${loaderRel}: expected one launcher.js?rev= URL, found ${launcherIds.length}`);
  for (const id of launcherIds) {
    if (id !== expected) problems.push(`${loaderRel}: launcher ${id} != ${expected}`);
  }
  return { expected, problems };
}

export function writeTunerRelease(files = tunerFiles()) {
  const expected = computeTunerRelease(files);
  for (const file of files.filter((item) => item.endsWith('.js'))) {
    const content = readFileSync(file, 'utf8');
    const next = content.replace(ID_PATTERN, `$1${expected}$3`);
    if (next !== content) writeFileSync(file, next, 'utf8');
  }
  const audio = computeReleases().audio;
  const launcher = readFileSync(TUNER_LAUNCHER, 'utf8');
  const nextLauncher = launcher.replace(AUDIO_ID_PATTERN, `$1${audio}$3`);
  if (nextLauncher !== launcher) writeFileSync(TUNER_LAUNCHER, nextLauncher, 'utf8');
  const loader = readFileSync(LAUNCHER_LOADER, 'utf8');
  const nextLoader = loader.replace(LAUNCHER_TAG_PATTERN, `$1${expected}`);
  if (nextLoader !== loader) writeFileSync(LAUNCHER_LOADER, nextLoader, 'utf8');
  return expected;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  if (process.argv.includes('--check')) {
    const { expected, problems } = checkTunerRelease();
    if (problems.length) {
      console.error(`Tuner release ids are stale (expected ${expected}). Run: npm run generate:tuner-release`);
      for (const problem of problems) console.error(`  ${problem}`);
      process.exit(1);
    }
    console.log(`Tuner release ids are current: ${expected}`);
  } else {
    console.log(`Tuner release id: ${writeTunerRelease()}`);
  }
}
