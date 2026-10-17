const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { installPortalApiMocks } = require('./fixtures/mockApi');

// The fake-microphone WAV is synthesised at test time into the OS temp
// directory so that no audio file is ever committed or put into the source ZIP.
function writeToneWav(filePath, frequency, seconds = 4, sampleRate = 48000) {
  const samples = Math.floor(seconds * sampleRate);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const value = Math.round(0.25 * 32767 * Math.sin((2 * Math.PI * frequency * i) / sampleRate));
    data.writeInt16LE(value, i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(filePath, Buffer.concat([header, data]));
}

// One fixed file in the OS temp directory, rewritten with identical content on
// every evaluation (Playwright evaluates this file in more than one process,
// so per-run directories would leak). Written via rename so Chromium never
// reads a half-written file.
const wavDir = path.join(os.tmpdir(), 'portal-tuner-e2e');
const wavPath = path.join(wavDir, 'a440.wav');
fs.mkdirSync(wavDir, { recursive: true });
const wavTemp = `${wavPath}.${process.pid}.tmp`;
writeToneWav(wavTemp, 440);
fs.renameSync(wavTemp, wavPath);

// The default headless shell rejects getUserMedia (NotSupportedError) even
// with a fake device, so these tests use the full Chromium build in headless mode.
test.use({
  channel: 'chromium',
  launchOptions: {
    args: ['--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wavPath}`],
  },
});

// Records every AudioContext, microphone stream and Worker so the tests can
// prove that leaving the tuner really releases them.
async function instrument(page) {
  await page.addInitScript(() => {
    const record = { contexts: [], streams: [], workers: [], gum: 0, frequencies: [], axes: [] };
    window.__tunerProbe = record;
    // Every frequency ever shown, to catch momentary wrong readings (attacks, restarts).
    new MutationObserver(() => {
      const element = document.querySelector('#systemTunerHost [data-tuner-frequency]');
      const value = element ? Number.parseFloat(element.textContent) : NaN;
      if (Number.isFinite(value) && record.frequencies.at(-1) !== value) record.frequencies.push(value);
    }).observe(document, { subtree: true, childList: true, characterData: true });
    const OriginalContext = window.AudioContext;
    window.AudioContext = class extends OriginalContext {
      constructor(...args) {
        super(...args);
        record.contexts.push(this);
      }
      createOscillator() {
        this.__playback = true; // only the reference-tone path creates oscillators
        return super.createOscillator();
      }
    };
    const originalGum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      record.gum += 1;
      const stream = await originalGum(constraints);
      record.streams.push(stream);
      return stream;
    };
    const OriginalWorker = window.Worker;
    window.Worker = function (url, options) {
      const worker = new OriginalWorker(url, options);
      worker.addEventListener('message', (event) => {
        if (event.data && event.data.type === 'display-axis') record.axes.push([event.data.axis.min, event.data.axis.max]);
      });
      const terminate = worker.terminate.bind(worker);
      worker.terminate = () => { worker.__terminated = true; terminate(); };
      record.workers.push(worker);
      return worker;
    };
  });
}

async function probe(page) {
  return page.evaluate(() => {
    const record = window.__tunerProbe;
    return {
      gum: record.gum,
      contexts: record.contexts.map((ctx) => ctx.state),
      playbackContexts: record.contexts.filter((ctx) => ctx.__playback).map((ctx) => ctx.state),
      captureContexts: record.contexts.filter((ctx) => !ctx.__playback).map((ctx) => ctx.state),
      axes: record.axes.slice(),
      tracks: record.streams.flatMap((stream) => stream.getTracks().map((track) => track.readyState)),
      workers: record.workers.map((worker) => Boolean(worker.__terminated)),
      frequencies: record.frequencies.slice(),
    };
  });
}

async function expectReleased(page) {
  await expect.poll(async () => {
    const state = await probe(page);
    return state.tracks.every((s) => s === 'ended') &&
      state.contexts.every((s) => s === 'closed') &&
      state.workers.every(Boolean);
  }, { timeout: 5000 }).toBe(true);
}

async function login(page, permission = 'システム管理者') {
  await page.goto('/');
  await page.fill('#portalNameInput', '団員テスト');
  await page.selectOption('#portalPartInput', { label: 'Violin' });
  await page.fill('#portalPasswordInput', 'dummy-pass');
  await page.click('#portalLoginBtn');
  await expect(page.locator('#memberPanel')).toBeVisible();
}

async function openLaboratory(page) {
  await page.click('#portalDrawerToggle');
  await page.locator('#portalDrawerMenu').getByRole('button', { name: 'システム管理', exact: true }).click();
  await expect(page.locator('#systemPanel')).toBeVisible();
  await page.locator('#systemPanel .toolbar').getByRole('button', { name: '実験室', exact: true }).click();
  await expect(page.locator('#system-laboratoryTab')).toBeVisible();
}

async function openTuner(page) {
  await openLaboratory(page);
  await page.locator('#system-laboratoryTab').getByRole('button', { name: 'チューナー', exact: true }).click();
  await expect(page.locator('#system-tunerTab')).toBeVisible();
}

// Design (tabs): the reference tone moved to the "音源" tab; measuring keeps
// running while another tuner tab is shown.
async function showTunerTab(page, name) {
  const tab = page.locator('#systemTunerHost').getByRole('tab', { name, exact: true });
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}

async function expectMeasuringA4(page) {
  const tuner = page.locator('#systemTunerHost');
  await expect(tuner.locator('[data-tuner-note]')).toHaveText('A4', { timeout: 15000 });
  await expect(tuner.locator('[data-tuner-solfege]')).toHaveText('（ラ）');
  // The first frames after start can be transient; the smoothed reading must settle on 440 Hz.
  await expect.poll(async () => {
    const value = Number.parseFloat(await tuner.locator('[data-tuner-frequency]').textContent());
    return value > 439.5 && value < 440.5;
  }, { timeout: 5000 }).toBe(true);
  // No momentary off-pitch reading was ever displayed (onset confirmation).
  const shown = (await probe(page)).frequencies;
  expect(shown.filter((value) => value < 438 || value > 442)).toEqual([]);
}

test.describe('tuner with a granted fake microphone', () => {
  test.beforeEach(async ({ page, context }) => {
    await context.grantPermissions(['microphone']);
    await instrument(page);
    await installPortalApiMocks(page, { permission: 'システム管理者' });
  });

  test('first tap on an empty cache starts measuring; preloading never opens audio', async ({ page }) => {
    const tunerRequests = [];
    page.on('request', (request) => {
      if (request.url().includes('/static/js/modules/tuner/')) tunerRequests.push(request.url());
    });
    await login(page);
    expect(tunerRequests).toHaveLength(0); // nothing tuner-related in the initial page load
    await openLaboratory(page);
    await expect.poll(() => tunerRequests.some((url) => url.includes('launcher.js'))).toBe(true);
    await expect.poll(() => tunerRequests.some((url) => url.includes('index.js'))).toBe(true); // preload started
    expect(await probe(page)).toMatchObject({ gum: 0, contexts: [] });
    await expect(page.locator('#system-laboratoryTab').getByRole('button', { name: 'PDF編集', exact: true })).toBeVisible();
    await page.locator('#system-laboratoryTab').getByRole('button', { name: 'チューナー', exact: true }).click();
    await expectMeasuringA4(page);
    const tuner = page.locator('#systemTunerHost');
    // 440 Hz against A4 = 442 Hz is about -8 cents: "low".
    await expect(tuner.locator('[data-tuner-cents]')).toHaveText(/^−(7|8|9) cent$/);
    await expect(tuner.locator('[data-tuner-judgment]')).toContainText('低い');
    await expect(page.getByText('一度に一つの音を')).toHaveCount(0); // guidance sentence removed
    await expect(tuner.locator('[data-tuner-judgment]')).not.toHaveText('音を待っています');
    await expect(tuner.locator('[data-tuner-canvas]')).toBeVisible();
    const state = await probe(page);
    expect(state.gum).toBe(1);
    expect(state.contexts).toEqual(['running']);
    expect(state.workers).toEqual([false]);
    // Every tuner asset used the same release query.
    const revs = new Set(tunerRequests.map((url) => new URL(url).searchParams.get('rev')));
    expect(revs.size).toBe(1);
    expect(tunerRequests.some((url) => url.includes('analysis.worker.js'))).toBe(true);
    expect(tunerRequests.some((url) => url.includes('pitch.js'))).toBe(true);
    // audioWorklet.addModule() requests are not reported to page.on('request');
    // the worklet's release is verified by its runtime handshake instead.
  });

  // Holds back launcher.js until released, to tap before it arrives (slow network).
  async function delayLauncher(page) {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    await page.route('**/static/js/modules/tuner/launcher.js*', async (route) => {
      await gate;
      await route.continue();
    });
    return () => release();
  }

  test('a tap before the launcher arrives still prepares audio inside the tap', async ({ page }) => {
    const releaseLauncher = await delayLauncher(page);
    await login(page);
    await openLaboratory(page);
    await page.locator('#system-laboratoryTab').getByRole('button', { name: 'チューナー', exact: true }).click();
    expect(await page.evaluate(() => typeof window.PortalTunerLauncher)).toBe('undefined');
    // Created synchronously by the laboratory inside the click.
    expect((await probe(page)).contexts).toHaveLength(1);
    expect((await probe(page)).gum).toBe(0);
    releaseLauncher();
    await expectMeasuringA4(page);
    const state = await probe(page);
    expect(state.contexts).toEqual(['running']); // the tap's context was handed over, none added
    expect(state.gum).toBe(1);
  });

  test('leaving before the launcher arrives never asks for the microphone', async ({ page }) => {
    const releaseLauncher = await delayLauncher(page);
    await login(page);
    await openLaboratory(page);
    await page.locator('#system-laboratoryTab').getByRole('button', { name: 'チューナー', exact: true }).click();
    await page.locator('.navbar-brand').click(); // member panel; the tuner tab element itself stays unhidden
    await expect(page.locator('#memberPanel')).toBeVisible();
    releaseLauncher();
    await expect.poll(() => page.evaluate(() => typeof window.PortalTunerLauncher)).toBe('object');
    await page.waitForTimeout(1500);
    const state = await probe(page);
    expect(state.gum).toBe(0);
    expect(state.contexts.every((value) => value === 'closed')).toBe(true);
  });

  async function setPageVisibility(page, state) {
    await page.evaluate((value) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value });
      document.dispatchEvent(new Event('visibilitychange'));
    }, state);
  }

  test('background before the launcher arrives releases the tap context; returning still starts', async ({ page }) => {
    const releaseLauncher = await delayLauncher(page);
    await login(page);
    await openLaboratory(page);
    await page.locator('#system-laboratoryTab').getByRole('button', { name: 'チューナー', exact: true }).click();
    expect((await probe(page)).contexts).toHaveLength(1);
    await setPageVisibility(page, 'hidden');
    // Released by the laboratory module although the launcher has not arrived.
    await expect.poll(async () => (await probe(page)).contexts.every((value) => value === 'closed')).toBe(true);
    releaseLauncher();
    await expect.poll(() => page.evaluate(() => typeof window.PortalTunerLauncher)).toBe('object');
    await page.waitForTimeout(800);
    expect((await probe(page)).gum).toBe(0); // still hidden: nothing starts
    await setPageVisibility(page, 'visible');
    const tuner = page.locator('#systemTunerHost');
    const resume = tuner.getByRole('button', { name: 'タップして測定を再開' });
    await expect(tuner.locator('[data-tuner-note]').filter({ hasText: 'A4' }).or(resume)).toBeVisible({ timeout: 15000 });
  });

  test('page hide before the launcher arrives releases the tap context', async ({ page }) => {
    const releaseLauncher = await delayLauncher(page);
    await login(page);
    await openLaboratory(page);
    await page.locator('#system-laboratoryTab').getByRole('button', { name: 'チューナー', exact: true }).click();
    expect((await probe(page)).contexts).toHaveLength(1);
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await expect.poll(async () => (await probe(page)).contexts.every((value) => value === 'closed')).toBe(true);
    releaseLauncher();
  });

  test('a second tap does not start a second microphone', async ({ page }) => {
    await login(page);
    await openLaboratory(page);
    const button = page.locator('#system-laboratoryTab').getByRole('button', { name: 'チューナー', exact: true });
    await button.click();
    await expectMeasuringA4(page);
    await page.evaluate(() => {
      window.PortalTunerLauncher.prime();
      return window.PortalTunerLauncher.enter(document.getElementById('systemTunerHost'));
    });
    await page.waitForTimeout(500);
    const state = await probe(page);
    expect(state.gum).toBe(1);
    expect(state.contexts).toEqual(['running']);
  });

  // Design (Phase 1): A4 390.0-480.0 Hz in 0.1 Hz steps, presets and direct
  // input; stored as portalTunerSettings (a4Tenths). The old key is only a
  // read-once migration source and is never written again.
  test('reference A4: 0.1 Hz steps, presets, input limits, legacy migration and restore', async ({ page }) => {
    await page.addInitScript(() => {
      if (!sessionStorage.getItem('tunerE2eSeeded')) {
        sessionStorage.setItem('tunerE2eSeeded', '1');
        localStorage.removeItem('portalTunerSettings');
        localStorage.setItem('portalTunerReferenceA4Hz', '441');
      }
    });
    await login(page);
    await openTuner(page);
    await expectMeasuringA4(page);
    const tuner = page.locator('#systemTunerHost');
    const reference = tuner.locator('[data-tuner-reference]');
    const down = tuner.getByRole('button', { name: '基準周波数を0.1 Hz下げる' });
    const up = tuner.getByRole('button', { name: '基準周波数を0.1 Hz上げる' });
    // Migrated from the legacy value (441 Hz).
    await expect(reference).toHaveText('A4 = 441.0 Hz');
    for (const box of [await down.boundingBox(), await up.boundingBox()]) {
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    await up.click();
    await expect(reference).toHaveText('A4 = 441.1 Hz');
    await expect(tuner.locator('[data-tuner-announcer]')).toHaveText('基準周波数 A4 = 441.1 Hz');
    const stored = await page.evaluate(() => [localStorage.getItem('portalTunerSettings'), localStorage.getItem('portalTunerReferenceA4Hz')]);
    expect(JSON.parse(stored[0])).toMatchObject({ schemaVersion: 1, a4Tenths: 4411 });
    expect(stored[1]).toBe('441'); // the legacy key is never rewritten
    // Preset 440 Hz: 440 Hz input is now in tune.
    await tuner.locator('[data-tuner-presets]').getByRole('button', { name: '440 Hz' }).click();
    await expect(reference).toHaveText('A4 = 440.0 Hz');
    await expect(tuner.locator('[data-tuner-presets]').getByRole('button', { name: '440 Hz' })).toHaveAttribute('aria-pressed', 'true');
    await expect(tuner.locator('[data-tuner-cents]')).toHaveText(/^(−1|0|\+1) cent$/);
    await expect(tuner.locator('[data-tuner-judgment]')).toContainText('合っています');
    // Direct input: out of range is explained and not applied; the lower limit disables "−".
    const input = tuner.getByLabel('基準周波数を入力（390.0～480.0 Hz）');
    await input.fill('389.9');
    await tuner.locator('[data-tuner-a4-apply]').click();
    await expect(tuner.locator('[data-tuner-a4-error]')).toBeVisible();
    await expect(reference).toHaveText('A4 = 440.0 Hz');
    await input.fill('390');
    await tuner.locator('[data-tuner-a4-apply]').click();
    await expect(reference).toHaveText('A4 = 390.0 Hz');
    await expect(tuner.locator('[data-tuner-a4-error]')).toBeHidden();
    await expect(down).toBeDisabled();
    await expect(up).toBeEnabled();
    await input.fill('442.5');
    await tuner.locator('[data-tuner-a4-apply]').click();
    await expect(reference).toHaveText('A4 = 442.5 Hz');
    // Logout keeps the device setting; the next login restores it.
    await page.click('#portalDrawerToggle');
    await page.locator('#portalDrawer [data-drawer-action="logout"]').click();
    await expect(page.locator('#portalLoginPanel')).toBeVisible();
    expect(JSON.parse(await page.evaluate(() => localStorage.getItem('portalTunerSettings'))).a4Tenths).toBe(4425);
    await page.fill('#portalNameInput', '団員テスト');
    await page.selectOption('#portalPartInput', { label: 'Violin' });
    await page.fill('#portalPasswordInput', 'dummy-pass');
    await page.click('#portalLoginBtn');
    await expect(page.locator('#memberPanel')).toBeVisible();
    await openTuner(page);
    await expect(reference).toHaveText('A4 = 442.5 Hz');
  });

  test('switching tabs or panels releases microphone, audio and worker', async ({ page }) => {
    await login(page);
    await openTuner(page);
    await expectMeasuringA4(page);
    await page.locator('#systemPanel .toolbar').getByRole('button', { name: '実験室', exact: true }).click();
    await expectReleased(page);
    await page.locator('#system-laboratoryTab').getByRole('button', { name: 'チューナー', exact: true }).click();
    await expectMeasuringA4(page);
    await page.locator('.navbar-brand').click(); // member home: a different panel
    await expect(page.locator('#memberPanel')).toBeVisible();
    await expectReleased(page);
    expect((await probe(page)).gum).toBe(2);
  });

  test('browser back releases; forward restores the tuner (auto start or tap to resume)', async ({ page }) => {
    await login(page);
    await openTuner(page);
    await expectMeasuringA4(page);
    await page.goBack();
    await expect(page.locator('#system-laboratoryTab')).toBeVisible();
    await expectReleased(page);
    await page.goForward();
    await expect(page.locator('#system-tunerTab')).toBeVisible();
    const tuner = page.locator('#systemTunerHost');
    const resume = tuner.getByRole('button', { name: 'タップして測定を再開' });
    await expect(tuner.locator('[data-tuner-note]').filter({ hasText: 'A4' }).or(resume)).toBeVisible({ timeout: 15000 });
    if (await resume.isVisible()) await resume.click();
    await expectMeasuringA4(page);
  });

  test('logout and session expiry release the microphone', async ({ page }) => {
    await login(page);
    await openTuner(page);
    await expectMeasuringA4(page);
    await page.click('#portalDrawerToggle');
    await page.locator('#portalDrawer [data-drawer-action="logout"]').click();
    await expect(page.locator('#portalLoginPanel')).toBeVisible();
    await expectReleased(page);

    await page.fill('#portalNameInput', '団員テスト');
    await page.selectOption('#portalPartInput', { label: 'Violin' });
    await page.fill('#portalPasswordInput', 'dummy-pass');
    await page.click('#portalLoginBtn');
    await openTuner(page);
    await expectMeasuringA4(page);
    // Session expiry path: the API layer clears auth state (e.g. after a 401).
    await page.evaluate(() => clearPortalAuthState());
    await expectReleased(page);
  });

  test('going to the background releases; returning restarts once', async ({ page }) => {
    await login(page);
    await openTuner(page);
    await expectMeasuringA4(page);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expectReleased(page);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const tuner = page.locator('#systemTunerHost');
    const resume = tuner.getByRole('button', { name: 'タップして測定を再開' });
    await expect(tuner.locator('[data-tuner-note]').filter({ hasText: 'A4' }).or(resume)).toBeVisible({ timeout: 15000 });
    expect((await probe(page)).gum).toBe(2);
  });

  test('safety net: hiding the panel directly releases without an explicit leave', async ({ page }) => {
    await login(page);
    await openTuner(page);
    await expectMeasuringA4(page);
    await page.evaluate(() => { document.getElementById('systemPanel').hidden = true; });
    await expectReleased(page);
  });
});

test.describe('tuner judgment modes, display range and reference tone', () => {
  test.beforeEach(async ({ page, context }) => {
    await context.grantPermissions(['microphone']);
    await instrument(page);
    await installPortalApiMocks(page, { permission: 'システム管理者' });
  });

  test('just-intonation mode judges against the fixed pure third over the chosen root', async ({ page }) => {
    await login(page);
    await openTuner(page);
    await expectMeasuringA4(page);
    const tuner = page.locator('#systemTunerHost');
    await expect(tuner.getByRole('button', { name: '平均律' })).toHaveAttribute('aria-pressed', 'true');
    await expect(tuner.locator('[data-tuner-root-field]')).toBeHidden();
    await tuner.getByRole('button', { name: '純正律・長3度' }).click();
    await expect(tuner.getByRole('button', { name: '純正律・長3度' })).toHaveAttribute('aria-pressed', 'true');
    const rootSelect = tuner.getByLabel('根音（比較の基準にする音）');
    await expect(rootSelect).toHaveValue('60'); // C4
    await expect(tuner.locator('[data-tuner-target-line]')).toContainText('根音 C4 → 純正長3度 E4');
    // Root F4: target is the pure major third A4 = F4 x 5/4 (A4 = 442).
    const pureA4 = 442 * 2 ** ((65 - 69) / 12) * 5 / 4;
    await rootSelect.selectOption('65');
    await expect(tuner.locator('[data-tuner-target-line]')).toContainText(`根音 F4 → 純正長3度 A4（目標 ${pureA4.toFixed(2)} Hz）`);
    await expect(tuner.locator('[data-tuner-note]')).toHaveText('A4'); // detected note still shown
    await expect(tuner.locator('[data-tuner-cents]')).toHaveText(/^\+(5|6|7) cent$/);
    await expect(tuner.locator('[data-tuner-judgment]')).toContainText('高い');
    await expect(tuner.locator('[data-tuner-equal-diff]')).toHaveText(/^平均律の A4 との差：\u2212(7|8|9) cent$/);
    await expect(tuner.locator('[data-tuner-legend]')).toContainText('破線：純正律の目標');
    await expect(tuner.locator('[data-tuner-legend]')).toContainText('点線：同じ音の平均律');
    // Back to equal temperament: nearest-note judgment again.
    await tuner.getByRole('button', { name: '平均律' }).click();
    await expect(tuner.locator('[data-tuner-target-line]')).toBeHidden();
    await expect(tuner.locator('[data-tuner-cents]')).toHaveText(/^\u2212(7|8|9) cent$/);
    await expect(tuner.locator('[data-tuner-equal-diff]')).toBeHidden();
  });

  test('display range switches between 500 Hz-16 kHz (default) and 25 Hz-16 kHz without stopping detection', async ({ page }) => {
    await login(page);
    await openTuner(page);
    await expectMeasuringA4(page);
    const tuner = page.locator('#systemTunerHost');
    await expect(tuner.getByRole('button', { name: /倍音重視/ })).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => (await probe(page)).axes.at(-1)).toEqual([500, 16000]);
    await tuner.getByRole('button', { name: /全音域/ }).click();
    await expect(tuner.getByRole('button', { name: /全音域/ })).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => (await probe(page)).axes.at(-1)).toEqual([25, 16000]);
    await tuner.getByRole('button', { name: /倍音重視/ }).click();
    await expect.poll(async () => (await probe(page)).axes.at(-1)).toEqual([500, 16000]);
    // 440 Hz is below the 500 Hz display range, but note and Hz keep updating.
    await expect(tuner.locator('[data-tuner-note]')).toHaveText('A4');
    expect((await probe(page)).gum).toBe(1); // no restart of the microphone for a display change
    const box = await tuner.locator('[data-tuner-canvas]').boundingBox();
    expect(box.width).toBeGreaterThan(200);
  });

  test('reference tone: set, play, stop; measurement pauses and resumes with the fake microphone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 }); // iPhone portrait width
    await login(page);
    await openTuner(page);
    await expectMeasuringA4(page);
    const tuner = page.locator('#systemTunerHost');
    await showTunerTab(page, '音源');
    const play = tuner.locator('[data-tuner-play]'); // label changes to "再生中" while playing
    const stop = tuner.getByRole('button', { name: '停止', exact: true });
    await expect(play).toHaveText('再生');
    await expect(stop).toBeDisabled();
    await expect(tuner.getByLabel('再生する音名（A4基準に連動）')).toHaveValue('69');
    await expect(tuner.locator('[data-tuner-playback-summary]')).toContainText('A4 = 442.0 Hz');
    await expect(tuner.locator('[data-tuner-volume-value]')).toHaveText('40%');
    for (const button of [play, stop, tuner.getByRole('button', { name: '周波数（Hz）で指定' })]) {
      const box = await button.boundingBox();
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    // Invalid Hz input is explained and not played.
    await tuner.getByRole('button', { name: '周波数（Hz）で指定' }).click();
    await expect(tuner.getByRole('button', { name: '周波数（Hz）で指定' })).toHaveAttribute('aria-pressed', 'true');
    const hzInput = tuner.getByLabel(/再生する周波数/);
    await expect(hzInput).toHaveValue('442.0');
    await hzInput.fill('5000');
    await expect(tuner.locator('[data-tuner-playback-error]')).toContainText('28.0～4,700.0 Hz');
    await play.click();
    expect((await probe(page)).playbackContexts).toHaveLength(0);
    await hzInput.fill('523.3');
    await expect(tuner.locator('[data-tuner-playback-error]')).toBeHidden();
    await play.click();
    await expect(tuner.locator('[data-tuner-status]')).toContainText('基準音を再生中');
    await expect(tuner.locator('[data-tuner-note]')).toHaveText('\u2014'); // old reading cleared
    let state = await probe(page);
    expect(state.playbackContexts).toEqual(['running']);
    await expect.poll(async () => (await probe(page)).tracks.every((s) => s === 'ended')).toBe(true); // microphone released
    await expect.poll(async () => (await probe(page)).captureContexts.every((s) => s === 'closed')).toBe(true);
    // Repeated taps cannot start a second tone: the button is disabled and even a
    // scripted click on it creates nothing.
    await expect(play).toBeDisabled();
    await expect(play).toHaveText('再生中');
    await page.evaluate(() => document.querySelector('#systemTunerHost [data-tuner-play]').click());
    expect((await probe(page)).playbackContexts).toHaveLength(1);
    await stop.click();
    await expect(tuner.locator('[data-tuner-status]')).toBeHidden({ timeout: 15000 });
    await expectMeasuringA4(page); // back to the fake microphone (440 Hz), not the 523.3 Hz tone
    state = await probe(page);
    expect(state.playbackContexts).toEqual(['closed']);
    expect(state.gum).toBe(2);
  });

  test('just-intonation values go to the player unrounded and only on request', async ({ page }) => {
    await login(page);
    await openTuner(page);
    const tuner = page.locator('#systemTunerHost');
    await tuner.getByRole('button', { name: '純正律・長3度' }).click();
    await showTunerTab(page, '音源');
    await tuner.getByRole('button', { name: '判定対象音を再生欄に設定' }).click();
    // E4 pure = C4 (A4 = 442) x 5/4, shown with three decimals and no sound yet.
    const pureE4 = 442 * 2 ** ((60 - 69) / 12) * 5 / 4;
    await expect(tuner.locator('[data-tuner-playback-summary]')).toContainText(`${pureE4.toFixed(3)} Hz（純正長3度 E4（根音 C4））`);
    expect((await probe(page)).playbackContexts).toHaveLength(0);
    await showTunerTab(page, '測定');
    await tuner.getByLabel('根音（比較の基準にする音）').selectOption('62');
    await expect(tuner.locator('[data-tuner-playback-summary]')).toContainText(`${pureE4.toFixed(3)} Hz`); // no implicit follow
    await showTunerTab(page, '音源');
    await tuner.getByRole('button', { name: '根音を再生欄に設定' }).click();
    const rootD4 = 442 * 2 ** ((62 - 69) / 12);
    await expect(tuner.locator('[data-tuner-playback-summary]')).toContainText(`${rootD4.toFixed(3)} Hz（根音 D4）`);
  });

  test('leaving, logging out or going to the background while playing stops the tone; returning does not replay', async ({ page }) => {
    await login(page);
    await openTuner(page);
    await expectMeasuringA4(page);
    const tuner = page.locator('#systemTunerHost');
    const play = tuner.getByRole('button', { name: '再生', exact: true });
    await showTunerTab(page, '音源');
    await play.click();
    await expect(tuner.locator('[data-tuner-status]')).toContainText('基準音を再生中');
    await page.locator('#systemPanel .toolbar').getByRole('button', { name: '実験室', exact: true }).click();
    await expectReleased(page);
    await page.locator('#system-laboratoryTab').getByRole('button', { name: 'チューナー', exact: true }).click();
    await expectMeasuringA4(page);
    expect((await probe(page)).playbackContexts.every((s) => s === 'closed')).toBe(true); // no auto replay

    await showTunerTab(page, '音源');
    await play.click();
    await expect(tuner.locator('[data-tuner-status]')).toContainText('基準音を再生中');
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expectReleased(page);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const resume = tuner.getByRole('button', { name: 'タップして測定を再開' });
    // The status box (with "tap to resume") is shown on every tab; the reading on the measuring tab.
    await showTunerTab(page, '測定');
    await expect(tuner.locator('[data-tuner-note]').filter({ hasText: 'A4' }).or(resume)).toBeVisible({ timeout: 15000 });
    expect((await probe(page)).playbackContexts.every((s) => s === 'closed')).toBe(true);

    if (await resume.isVisible()) await resume.click();
    await expectMeasuringA4(page);
    await showTunerTab(page, '音源');
    await play.click();
    await expect(tuner.locator('[data-tuner-status]')).toContainText('基準音を再生中');
    await page.click('#portalDrawerToggle');
    await page.locator('#portalDrawer [data-drawer-action="logout"]').click();
    await expect(page.locator('#portalLoginPanel')).toBeVisible();
    await expectReleased(page);
  });

  test('playing again right after stop keeps the microphone off (restart cancelled)', async ({ page }) => {
    await login(page);
    await openTuner(page);
    await expectMeasuringA4(page);
    const tuner = page.locator('#systemTunerHost');
    await showTunerTab(page, '音源');
    await tuner.locator('[data-tuner-play]').click();
    await expect(tuner.locator('[data-tuner-status]')).toContainText('基準音を再生中');
    const gumBefore = (await probe(page)).gum;
    // Stop and play again well within the 250 ms restart delay.
    await page.evaluate(() => {
      document.querySelector('#systemTunerHost [data-tuner-stop]').click();
      document.querySelector('#systemTunerHost [data-tuner-play]').click();
    });
    await page.waitForTimeout(1500);
    const state = await probe(page);
    expect(state.gum).toBe(gumBefore); // no microphone while the tone plays
    expect(state.playbackContexts.filter((s) => s === 'running')).toHaveLength(1);
    expect(state.captureContexts.every((s) => s === 'closed')).toBe(true);
    await expect(tuner.locator('[data-tuner-status]')).toContainText('基準音を再生中');
    await tuner.getByRole('button', { name: '停止', exact: true }).click();
    await expectMeasuringA4(page);
  });

  test('stopping and leaving at once never brings the microphone back', async ({ page }) => {
    await login(page);
    await openTuner(page);
    await expectMeasuringA4(page);
    const tuner = page.locator('#systemTunerHost');
    await showTunerTab(page, '音源');
    await tuner.getByRole('button', { name: '再生', exact: true }).click();
    await expect(tuner.locator('[data-tuner-status]')).toContainText('基準音を再生中');
    const gumBefore = (await probe(page)).gum;
    // Stop schedules a delayed restart; leaving right away must cancel it.
    await page.evaluate(() => {
      document.querySelector('#systemTunerHost [data-tuner-stop]').click();
      document.querySelector('#systemPanel .toolbar [data-tab="system-laboratory"]').click();
    });
    await page.waitForTimeout(1500);
    const state = await probe(page);
    expect(state.gum).toBe(gumBefore);
    expect(state.contexts.every((s) => s === 'closed')).toBe(true);
  });

  test('generated tone: sine at the set frequency with fades (OfflineAudioContext)', async ({ page }) => {
    await login(page);
    await openTuner(page); // loads the tuner modules
    await expect.poll(() => page.evaluate(() => typeof (window.PortalTunerLib && window.PortalTunerLib.playback))).toBe('object');
    const result = await page.evaluate(async () => {
      const lib = window.PortalTunerLib.playback;
      const sampleRate = 48000;
      const ctx = new OfflineAudioContext(1, sampleRate * 0.6, sampleRate);
      const engine = lib.createPlaybackEngine({ createContext: () => ctx, setTimeout: () => 0, clearTimeout: () => {} });
      engine.start(440, lib.volumeToGain(40));
      ctx.suspend(0.25).then(() => { engine.setFrequency(660); ctx.resume(); });
      ctx.suspend(0.45).then(() => { engine.stop(); ctx.resume(); });
      const data = (await ctx.startRendering()).getChannelData(0);
      const peak = (from, to) => { let m = 0; for (let i = Math.floor(from * sampleRate); i < Math.floor(to * sampleRate); i += 1) m = Math.max(m, Math.abs(data[i])); return m; };
      const frequency = (from, to) => {
        let crossings = 0;
        const a = Math.floor(from * sampleRate);
        const b = Math.floor(to * sampleRate);
        for (let i = a + 1; i < b; i += 1) if (data[i - 1] < 0 && data[i] >= 0) crossings += 1;
        return crossings / (to - from);
      };
      return {
        firstMs: peak(0, 0.001),
        steady: peak(0.1, 0.2),
        f1: frequency(0.05, 0.24),
        f2: frequency(0.3, 0.44),
        afterStop: peak(0.5, 0.6),
        duringFadeOut: peak(0.465, 0.475),
      };
    });
    expect(result.firstMs).toBeLessThan(0.01); // fade-in: starts near zero, no click
    expect(result.steady).toBeGreaterThan(0.095);
    expect(result.steady).toBeLessThan(0.105); // 40 % = gain 0.1
    expect(Math.abs(result.f1 - 440)).toBeLessThan(10);
    expect(Math.abs(result.f2 - 660)).toBeLessThan(10);
    expect(result.duringFadeOut).toBeLessThan(result.steady);
    expect(result.afterStop).toBeLessThan(0.001); // silent after the fade-out
  });
});

test.describe('advanced tuner: tabs, pause, saving off, voices and narrow screens', () => {
  test.beforeEach(async ({ page, context }) => {
    await context.grantPermissions(['microphone']);
    await instrument(page);
    // Records every IndexedDB open (history must stay closed while saving is off).
    await page.addInitScript(() => {
      window.__tunerIdbOpens = [];
      const factory = window.indexedDB;
      if (factory) {
        const open = factory.open.bind(factory);
        factory.open = (name, version) => { window.__tunerIdbOpens.push(name); return open(name, version); };
      }
    });
    await installPortalApiMocks(page, { permission: 'システム管理者' });
  });

  test('switching tuner tabs keeps measuring; the state chips stay visible on every tab', async ({ page }) => {
    await login(page);
    await openTuner(page);
    await expectMeasuringA4(page);
    const tuner = page.locator('#systemTunerHost');
    for (const name of ['音源', '解析', '練習', '診断', '履歴・楽器・設定', '測定']) {
      await showTunerTab(page, name);
      await expect(tuner.locator('[data-tuner-chip-mic]')).toBeVisible();
    }
    const state = await probe(page);
    expect(state.gum).toBe(1); // no restart for an internal tab change
    expect(state.tracks.every((s) => s === 'live')).toBe(true);
    await expectMeasuringA4(page);
    // Leaving the tuner (portal tab) still releases everything.
    await page.locator('#systemPanel .toolbar').getByRole('button', { name: '実験室', exact: true }).click();
    await expectReleased(page);
  });

  test('"表示を固定" keeps the microphone; "測定を一時停止" releases it until the user resumes', async ({ page }) => {
    await login(page);
    await openTuner(page);
    await expectMeasuringA4(page);
    const tuner = page.locator('#systemTunerHost');
    await tuner.locator('[data-tuner-freeze]').click();
    await expect(tuner.locator('[data-tuner-chip-frozen]')).toBeVisible();
    expect((await probe(page)).tracks.every((s) => s === 'live')).toBe(true);
    await tuner.locator('[data-tuner-freeze]').click();
    await tuner.locator('[data-tuner-pause]').click();
    await expect.poll(async () => (await probe(page)).tracks.every((s) => s === 'ended'), { timeout: 5000 }).toBe(true);
    await expect.poll(async () => (await probe(page)).captureContexts.every((s) => s === 'closed')).toBe(true);
    await page.waitForTimeout(1000);
    expect((await probe(page)).gum).toBe(1); // no automatic restart
    await tuner.locator('[data-tuner-pause]').click();
    await expectMeasuringA4(page);
    expect((await probe(page)).gum).toBe(2);
  });

  test('with history saving off (default) no IndexedDB is opened and nothing is sent to /api/tuner', async ({ page }) => {
    const tunerRequests = [];
    page.on('request', (request) => { if (request.url().includes('/api/tuner')) tunerRequests.push(request.url()); });
    await login(page);
    await openTuner(page);
    await expectMeasuringA4(page);
    for (const name of ['解析', '練習', '診断', '履歴・楽器・設定', '測定']) {
      await showTunerTab(page, name);
      await page.waitForTimeout(300);
    }
    await expectMeasuringA4(page);
    const opens = await page.evaluate(() => window.__tunerIdbOpens.slice());
    expect(opens.filter((name) => name === 'portalTunerAdvanced')).toEqual([]);
    expect(tunerRequests).toEqual([]);
  });

  test('four voices: summed output stays below full scale and fades in from silence (OfflineAudioContext)', async ({ page }) => {
    await login(page);
    await openTuner(page);
    await expect.poll(() => page.evaluate(() => typeof (window.PortalTunerLib && window.PortalTunerLib.playback))).toBe('object');
    const result = await page.evaluate(async () => {
      const lib = window.PortalTunerLib.playback;
      const sampleRate = 48000;
      const ctx = new OfflineAudioContext(1, sampleRate * 0.8, sampleRate);
      const engine = lib.createPlaybackEngine({ createContext: () => ctx, setTimeout: () => 0, clearTimeout: () => {} });
      const voices = [261.63, 329.63, 392.0, 523.25].map((frequency) => ({ frequency, waveform: 'harmonic' }));
      const started = engine.startVoices(voices, { gain: 1 }).started; // asks for more than allowed
      ctx.suspend(0.5).then(() => { engine.stop(); ctx.resume(); });
      const data = (await ctx.startRendering()).getChannelData(0);
      const peak = (from, to) => { let m = 0; for (let i = Math.floor(from * sampleRate); i < Math.floor(to * sampleRate); i += 1) m = Math.max(m, Math.abs(data[i])); return m; };
      return { started, firstMs: peak(0, 0.001), steady: peak(0.1, 0.45), afterStop: peak(0.7, 0.8), maxGain: lib.MAX_GAIN };
    });
    expect(result.started).toBe(true);
    expect(result.firstMs).toBeLessThan(0.01);
    expect(result.steady).toBeGreaterThan(0.01);
    expect(result.steady).toBeLessThanOrEqual(result.maxGain + 1e-6); // master limit holds for the sum
    expect(result.afterStop).toBeLessThan(0.001);
  });

  test('temperament and sound presets: save, recall without playing, delete', async ({ page }) => {
    await login(page);
    await openTuner(page);
    await expectMeasuringA4(page);
    const tuner = page.locator('#systemTunerHost');
    const temperament = tuner.getByLabel('音律（すべての選択肢）');
    await temperament.selectOption('pythagorean');
    await showTunerTab(page, '履歴・楽器・設定');
    await tuner.locator('[data-tuner-menu-section="settings"]').click();
    await tuner.locator('[data-tuner-temperament-preset-name]').fill('ピタゴラス');
    await tuner.locator('[data-tuner-temperament-preset-save]').click();
    await expect(tuner.locator('[data-tuner-temperament-presets]')).toContainText('ピタゴラス');
    await showTunerTab(page, '測定');
    await tuner.getByRole('button', { name: '平均律' }).click();
    await expect(temperament).toHaveValue('equal');
    await showTunerTab(page, '履歴・楽器・設定');
    await tuner.locator('[data-tuner-temperament-presets]').getByRole('button', { name: '呼び出す' }).click();
    await showTunerTab(page, '測定');
    await expect(temperament).toHaveValue('pythagorean');
    // Sound preset: two voices and a timed pattern; recalling never plays.
    await showTunerTab(page, '音源');
    await tuner.locator('[data-tuner-voice-add]').click();
    await tuner.locator('[data-tuner-pattern]').selectOption('timed');
    await tuner.locator('[data-tuner-sound-preset-name]').fill('二音');
    await tuner.locator('[data-tuner-sound-preset-save]').click();
    await tuner.locator('[data-tuner-voice-remove="1"]').click();
    await tuner.locator('[data-tuner-pattern]').selectOption('hold');
    await tuner.locator('[data-tuner-sound-preset]').selectOption({ label: '二音' });
    await tuner.locator('[data-tuner-sound-preset-use]').click();
    await expect(tuner.locator('[data-tuner-pattern]')).toHaveValue('timed');
    await expect(tuner.locator('[data-tuner-voice-source]')).toHaveCount(2);
    expect((await probe(page)).playbackContexts).toHaveLength(0);
    await tuner.locator('[data-tuner-sound-preset-delete]').click();
    await expect(tuner.locator('[data-tuner-sound-preset]')).toContainText('保存した設定はありません');
    // Settings saving is off by default: nothing about presets is stored.
    const stored = await page.evaluate(() => localStorage.getItem('portalTunerSettings'));
    expect(stored === null || !JSON.parse(stored).prefs).toBe(true);
  });

  for (const width of [277, 320, 390, 430]) {
    test(`no horizontal scrolling at ${width} px on any tuner tab`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await login(page);
      await openTuner(page);
      await expectMeasuringA4(page);
      for (const name of ['測定', '音源', '解析', '練習', '診断', '履歴・楽器・設定']) {
        await showTunerTab(page, name);
        await page.waitForTimeout(200);
        const overflow = await page.evaluate(() => {
          const host = document.querySelector('#systemTunerHost');
          const doc = document.documentElement;
          const wide = Array.from(host.querySelectorAll('*')).filter((el) => {
            if (!el.offsetParent || el.closest('.tuner-table-wrap, .tuner-tabbar')) return false;
            return el.getBoundingClientRect().right > doc.clientWidth + 1;
          }).map((el) => el.className || el.tagName).slice(0, 5);
          return { page: doc.scrollWidth - doc.clientWidth, wide };
        });
        expect(overflow, name).toEqual({ page: 0, wide: [] });
      }
    });
  }
});

test.describe('tuner without microphone permission', () => {
  test('shows the reason and how to allow the microphone', async ({ page }) => {
    await instrument(page);
    await installPortalApiMocks(page, { permission: 'システム管理者' });
    await login(page);
    await openTuner(page);
    const tuner = page.locator('#systemTunerHost');
    await expect(tuner.getByText('マイクの使用が許可されていません')).toBeVisible({ timeout: 15000 });
    await expect(tuner.getByText(/Webサイトの設定/)).toBeVisible();
    await expect(tuner.getByRole('button', { name: 'もう一度試す' })).toBeVisible();
    await expectReleased(page);
  });
});

test.describe('tuner access', () => {
  test('non-administrators cannot start the tuner', async ({ page, context }) => {
    await context.grantPermissions(['microphone']);
    await instrument(page);
    await installPortalApiMocks(page, { permission: '一般' });
    await login(page, '一般');
    await expect(page.locator('#portalHomeMenu [data-home-system]')).toHaveCount(0);
    expect(await page.evaluate(() => typeof window.PortalTunerLauncher)).toBe('undefined');
    // Even if the launcher were loaded, it refuses to prime for non-administrators.
    await page.addScriptTag({ url: '/static/js/modules/tuner/launcher.js' });
    const primed = await page.evaluate(() => window.PortalTunerLauncher.prime());
    expect(primed).toBeNull();
    expect(await probe(page)).toMatchObject({ gum: 0, contexts: [] });
  });
});
