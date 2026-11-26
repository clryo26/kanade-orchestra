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
        if (event.data && event.data.type === 'pitch' && Object.prototype.hasOwnProperty.call(record, 'pitchOverride')) {
          event.data.frame = record.pitchOverride === null
            ? { valid: false, reason: 'silent' }
            : { ...event.data.frame, valid: true, reason: 'ok', frequency: record.pitchOverride };
        }
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
  await expect(tab).toBeVisible();
  // After editing presets, the tab can be above the viewport. Center it so
  // Playwright's nearest-edge scrolling does not leave it under the sticky navbar.
  await tab.evaluate((element) => element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }));
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}

async function expectMeasuringA4(page) {
  const tuner = page.locator('#systemTunerHost');
  await expect(tuner.locator('[data-tuner-note]')).toHaveText('A4', { timeout: 15000 });
  await expect(tuner.locator('[data-tuner-solfege]')).toHaveCount(0);
  // The first frames after start can be transient; the smoothed reading must settle on 440 Hz.
  await expect.poll(async () => {
    const value = Number.parseFloat(await tuner.locator('[data-tuner-frequency]').textContent());
    return value > 439.5 && value < 440.5;
  }, { timeout: 5000 }).toBe(true);
  // No momentary off-pitch reading was ever displayed (onset confirmation).
  const shown = (await probe(page)).frequencies;
  expect(shown.filter((value) => value < 438 || value > 442)).toEqual([]);
}

// Override only pitch payloads; release/protocol/epoch checks and the real
// microphone lifecycle remain active. Wait for the production filter to settle.
async function setMeasuredPitch(page, frequency) {
  await page.evaluate((value) => { window.__tunerProbe.pitchOverride = value; }, frequency);
  const tuner = page.locator('#systemTunerHost');
  if (frequency === null) {
    await expect(tuner.locator('[data-tuner-note]')).toHaveText('—', { timeout: 5000 });
    await expect(tuner.locator('[data-tuner-frequency]')).toHaveText('— Hz');
  } else {
    await expect.poll(async () => Number.parseFloat(await tuner.locator('[data-tuner-frequency]').textContent()), { timeout: 5000 }).toBeCloseTo(frequency, 0);
    await expect(tuner.locator('[data-tuner-readout]')).toHaveAttribute('data-state', 'active');
  }
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

  // A4 uses whole-Hz steps and integer input; storage stays in tenths. Presets and direct
  // input; stored as portalTunerSettings (a4Tenths). The old key is only a
  // read-once migration source and is never written again.
  test('reference A4: 1 Hz steps, presets, input limits, legacy migration and restore', async ({ page }) => {
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
    const down = tuner.getByRole('button', { name: '基準周波数を1 Hz下げる' });
    const up = tuner.getByRole('button', { name: '基準周波数を1 Hz上げる' });
    // Migrated from the legacy value (441 Hz).
    await expect(reference).toHaveText('A4 = 441 Hz');
    for (const box of [await down.boundingBox(), await up.boundingBox()]) {
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    await up.click();
    await expect(reference).toHaveText('A4 = 442 Hz');
    await expect(tuner.locator('[data-tuner-announcer]')).toHaveText('基準周波数 A4 = 442 Hz');
    const stored = await page.evaluate(() => [localStorage.getItem('portalTunerSettings'), localStorage.getItem('portalTunerReferenceA4Hz')]);
    expect(JSON.parse(stored[0])).toMatchObject({ schemaVersion: 1, a4Tenths: 4420 });
    expect(stored[1]).toBe('441'); // the legacy key is never rewritten
    await down.click();
    await expect(reference).toHaveText('A4 = 441 Hz');
    // Preset 440 Hz: 440 Hz input is now in tune.
    await tuner.locator('[data-tuner-presets]').getByRole('button', { name: '440 Hz' }).click();
    await expect(reference).toHaveText('A4 = 440 Hz');
    await expect(tuner.locator('[data-tuner-presets]').getByRole('button', { name: '440 Hz' })).toHaveAttribute('aria-pressed', 'true');
    await expect(tuner.locator('[data-tuner-cents]')).toHaveText(/^(−1|0|\+1) cent$/);
    await expect(tuner.locator('[data-tuner-judgment]')).toContainText('合っています');
    // Direct input: out of range is explained and not applied; the lower limit disables "−".
    const input = tuner.getByLabel('基準周波数を入力（390～480 Hz）');
    await expect(input).toHaveAttribute('inputmode', 'numeric');
    for (const invalid of ['442.5', '389', '481', '']) {
      await input.fill(invalid);
      await tuner.locator('[data-tuner-a4-apply]').click();
      await expect(tuner.locator('[data-tuner-a4-error]')).toBeVisible();
      await expect(reference).toHaveText('A4 = 440 Hz');
      expect(JSON.parse(await page.evaluate(() => localStorage.getItem('portalTunerSettings'))).a4Tenths).toBe(4400);
    }
    await input.fill('390');
    await tuner.locator('[data-tuner-a4-apply]').click();
    await expect(reference).toHaveText('A4 = 390 Hz');
    await expect(tuner.locator('[data-tuner-a4-error]')).toBeHidden();
    await expect(down).toBeDisabled();
    await expect(up).toBeEnabled();
    await input.fill('480');
    await tuner.locator('[data-tuner-a4-apply]').click();
    await expect(reference).toHaveText('A4 = 480 Hz');
    await expect(up).toBeDisabled();
    await expect(down).toBeEnabled();
    await input.fill('４４３');
    await tuner.locator('[data-tuner-a4-apply]').click();
    await expect(reference).toHaveText('A4 = 443 Hz');
    await expect(tuner.locator('[data-tuner-a4-error]')).toBeHidden();
    // Logout keeps the device setting; the next login restores it.
    await page.click('#portalDrawerToggle');
    await page.locator('#portalDrawer [data-drawer-action="logout"]').click();
    await expect(page.locator('#portalLoginPanel')).toBeVisible();
    expect(JSON.parse(await page.evaluate(() => localStorage.getItem('portalTunerSettings'))).a4Tenths).toBe(4430);
    await page.fill('#portalNameInput', '団員テスト');
    await page.selectOption('#portalPartInput', { label: 'Violin' });
    await page.fill('#portalPasswordInput', 'dummy-pass');
    await page.click('#portalLoginBtn');
    await expect(page.locator('#memberPanel')).toBeVisible();
    await openTuner(page);
    await expect(reference).toHaveText('A4 = 443 Hz');
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

  test('measurement is equal-only and pure-third marks follow the meter range', async ({ page }) => {
    await login(page);
    await openTuner(page);
    await expectMeasuringA4(page);
    const tuner = page.locator('#systemTunerHost');
    for (const attr of ['solfege', 'mode', 'temperament', 'root-select', 'custom-grid', 'detail', 'detail-panel', 'freeze', 'chip-frozen', 'root-field', 'role-field', 'seventh-field', 'octave-field', 'pythagorean-field', 'custom-field', 'temperament-note', 'target-line', 'equal-diff']) {
      await expect(tuner.locator(`[data-tuner-${attr}]`)).toHaveCount(0);
    }
    await expect(tuner.locator('[data-tuner-root]')).toHaveAttribute('data-mode', 'equal');
    await expect(tuner.locator('[data-tuner-meter-caption]')).toHaveText('最寄りの音（平均律）とのずれ');
    await expect(tuner.locator('[data-tuner-legend]')).toContainText('破線：最寄りの音（平均律）の周波数');
    const explanation = tuner.getByText('目印：純正長3度 −13.7 cent／純正短3度 +15.6 cent', { exact: true });
    await expect(explanation).toBeVisible();
    expect(await explanation.evaluate((el) => Boolean(el.closest('[aria-hidden="true"]')))).toBe(false);
    await expect(tuner.locator('[data-tuner-meter-mark]')).toHaveCount(2);
    for (const range of [50, 25, 100, 10]) {
      await showTunerTab(page, '履歴・楽器・設定');
      await tuner.locator('[data-tuner-menu-section="settings"]').click();
      await tuner.locator('[data-tuner-meter-range]').selectOption(String(range));
      await showTunerTab(page, '測定');
      for (const [name, cents] of [['major-third', -13.7], ['minor-third', 15.6]]) {
        const mark = tuner.locator(`[data-tuner-meter-mark="${name}"]`);
        if (range === 10) await expect(mark).toBeHidden();
        else {
          await expect(mark).toBeVisible();
          // Measure the rendered position, including CSS, rather than just its inline style.
          const percent = await mark.evaluate((el) => {
            const parent = el.parentElement.getBoundingClientRect();
            const box = el.getBoundingClientRect();
            return 100 * (box.x + box.width / 2 - parent.x) / parent.width;
          });
          expect(percent).toBeCloseTo(50 + 50 * cents / range, 0);
        }
      }
    }
    await showTunerTab(page, '音源');
    await expect(tuner.locator('[data-tuner-playback-just]')).toBeHidden();
  });

  test('fixed-note selection changes the judgment and auto restores nearest-note detection', async ({ page }) => {
    await login(page);
    await openTuner(page);
    await expectMeasuringA4(page);
    await setMeasuredPitch(page, 442);
    const tuner = page.locator('#systemTunerHost');
    const fixed = tuner.locator('[data-tuner-fixed-note]');
    await expect(fixed).toBeEnabled();
    await expect(fixed.locator('option[value=""]')).toHaveText('自動（最寄りの音）');
    await expect(fixed.locator('option[value="70"]')).toContainText('B♭4');
    await fixed.selectOption('70');
    await expect(tuner.locator('[data-tuner-cents]')).toHaveText(/^−(99|100|101) cent$/);
    await expect(tuner.locator('[data-tuner-meter]')).toHaveAttribute('data-judgment', 'flat');
    expect(await page.evaluate(() => window.PortalTunerBody.api.getTargetConfig())).toMatchObject({ temperament: 'equal', fixedMidi: 70 });
    await fixed.selectOption('');
    await expect(tuner.locator('[data-tuner-cents]')).toHaveText(/^(−1|0|\+1) cent$/);
    await expect(tuner.locator('[data-tuner-meter]')).toHaveAttribute('data-judgment', 'in-tune');
    await expect(tuner.locator('[data-tuner-note]')).toHaveText('A4');
    expect(await page.evaluate(() => window.PortalTunerBody.api.getTargetConfig().fixedMidi)).toBeNull();
  });

  for (const [temperament, fixedMidi] of [['major-third', null], ['minor-third', null], ['pythagorean', 70], ['custom', 70]]) {
    test(`legacy ${temperament}/detail settings start in equal temperament with fixedMidi=${fixedMidi}`, async ({ page }) => {
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.addInitScript(({ temperament, fixedMidi }) => {
        localStorage.setItem('portalTunerSettings', JSON.stringify({ schemaVersion: 1, a4Tenths: 4420, persistSettings: true, prefs: {
          judgment: { temperament, rootMidi: 62, fixedMidi }, displayMode: 'detail',
        } }));
      }, { temperament, fixedMidi });
      await login(page);
      await openTuner(page);
      await setMeasuredPitch(page, 442);
      const tuner = page.locator('#systemTunerHost');
      await expect(tuner.locator('[data-tuner-note]')).toHaveText('A4');
      await expect(tuner.locator('[data-tuner-fixed-note]')).toHaveValue(fixedMidi === null ? '' : String(fixedMidi));
      await expect(tuner.locator('[data-tuner-cents]')).toHaveText(fixedMidi === null ? /^(−1|0|\+1) cent$/ : /^−(99|100|101) cent$/);
      await expect(tuner.locator('[data-tuner-detail-panel]')).toHaveCount(0);
      expect(await page.evaluate(() => window.PortalTunerBody.api.getTargetConfig())).toMatchObject({ temperament: 'equal', fixedMidi });
      expect(errors).toEqual([]);
    });
  }

  for (const width of [320, 390]) {
    test(`readout height and meter top stay fixed at ${width}px, normal and maximized`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await login(page);
      await openTuner(page);
      await expectMeasuringA4(page);
      const tuner = page.locator('#systemTunerHost');
      const maximize = tuner.locator('[data-tuner-maximize]');
      for (const maximized of [false, true]) {
        if (maximized) await maximize.click();
        await expect(maximize).toHaveAttribute('aria-pressed', String(maximized));
        let baseline;
        for (const [frequency, label] of [[null, '—'], [440, 'A4'], [554.365, 'C♯5'], [233.082, 'B♭3'], [1046.5, 'C6']]) {
          await setMeasuredPitch(page, frequency);
          await expect(tuner.locator('[data-tuner-note]')).toHaveText(label);
          // Compare document coordinates so auto-scrolling for the maximize
          // button does not masquerade as layout movement.
          const geometry = await tuner.evaluate((host) => {
            const readout = host.querySelector('[data-tuner-readout]');
            const meter = host.querySelector('[data-tuner-meter]');
            const note = host.querySelector('[data-tuner-note]');
            const frequency = host.querySelector('[data-tuner-frequency]');
            const line = (el) => {
              const style = getComputedStyle(el);
              const range = document.createRange();
              range.selectNodeContents(el);
              return { height: el.getBoundingClientRect().height, lineHeight: parseFloat(style.lineHeight), lines: range.getClientRects().length, nowrap: style.whiteSpace };
            };
            return { height: readout.getBoundingClientRect().height, top: meter.getBoundingClientRect().top + window.scrollY, note: line(note), frequency: line(frequency) };
          });
          baseline ||= geometry;
          expect(Math.abs(geometry.height - baseline.height), `${label}: readout`).toBeLessThanOrEqual(1);
          expect(Math.abs(geometry.top - baseline.top), `${label}: meter`).toBeLessThanOrEqual(1);
          for (const line of [geometry.note, geometry.frequency]) {
            expect(line.lines).toBe(1);
            expect(line.nowrap).toBe('nowrap');
            expect(Math.abs(line.height - line.lineHeight)).toBeLessThanOrEqual(1);
          }
        }
      }
      await maximize.click();
      await expect(maximize).toHaveAttribute('aria-pressed', 'false');
    });
  }

  test('note-naming preferences still switch English/solfege without parenthesized text', async ({ page }) => {
    await login(page);
    await openTuner(page);
    await expectMeasuringA4(page);
    const tuner = page.locator('#systemTunerHost');
    for (const [name, expected] of [['ドレミのみ', 'ラ4'], ['英語のみ', 'A4']]) {
      await showTunerTab(page, '履歴・楽器・設定');
      await tuner.locator('[data-tuner-menu-section="settings"]').click();
      await tuner.getByRole('radio', { name, exact: true }).check();
      await showTunerTab(page, '測定');
      await expect(tuner.locator('[data-tuner-note]')).toHaveText(expected);
      await expect(tuner.locator('[data-tuner-solfege]')).toHaveCount(0);
    }
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
    // Shared output (metronome design 4.1): stopping ends the tuner's lease at
    // once (nothing can sound); the page manager keeps the context until it is
    // idle for 60 s or every consumer left, and leaving closes it.
    expect(await page.evaluate(() => window.PortalAudioLib.pageManager.consumers())).toEqual([]);
    expect(state.gum).toBe(2);
    await page.locator('#systemPanel .toolbar').getByRole('button', { name: '実験室', exact: true }).click();
    await expect.poll(async () => (await probe(page)).playbackContexts).toEqual(['closed']);
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

  test('removed freeze controls stay absent; pause releases the microphone until the user resumes', async ({ page }) => {
    await login(page);
    await openTuner(page);
    await expectMeasuringA4(page);
    const tuner = page.locator('#systemTunerHost');
    await expect(tuner.locator('[data-tuner-freeze]')).toHaveCount(0);
    await expect(tuner.locator('[data-tuner-chip-frozen]')).toHaveCount(0);
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

  test('tabs remain clickable after scrolling settings below the sticky navbar (C1)', async ({ page }) => {
    await login(page);
    await openTuner(page);
    await expectMeasuringA4(page);
    const tuner = page.locator('#systemTunerHost');
    const before = await probe(page);
    await showTunerTab(page, '履歴・楽器・設定');
    await tuner.locator('[data-tuner-menu-section="settings"]').click();
    // Reproduce the CI failure: editing the bottom of settings leaves the
    // tab bar above the viewport, where nearest-edge scrolling hits the navbar.
    await tuner.locator('[data-tuner-temperament-preset-name]').fill('スクロール回帰確認');
    await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
    const sound = tuner.getByRole('tab', { name: '音源', exact: true });
    expect(await sound.evaluate((el) => el.getBoundingClientRect().top)).toBeLessThan(0);
    await showTunerTab(page, '音源'); // real pointer click; no force or synthetic click
    await expect(tuner.locator('[data-tuner-voice-add]')).toBeVisible();
    await showTunerTab(page, '測定');
    await expectMeasuringA4(page);
    const after = await probe(page);
    expect(after.gum).toBe(before.gum);
    expect(after.captureContexts).toEqual(before.captureContexts);
    expect(after.workers).toEqual(before.workers);
    expect(after.tracks.every((state) => state === 'live')).toBe(true);
  });

  test('temperament presets report equal-only recall; save/delete and sound presets still work', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('portalTunerSettings', JSON.stringify({ schemaVersion: 1, a4Tenths: 4400, persistSettings: true, prefs: {
        presets: { temperament: ['pythagorean', 'custom', 'major-third', 'minor-third', 'equal', 'future-mode'].map((temperament, i) => ({ id: `t${i}`, name: temperament, savedAt: 1, data: { temperament, fixedMidi: temperament === 'equal' ? null : 70 } })), sound: [] },
      } }));
    });
    await login(page);
    await openTuner(page);
    await expectMeasuringA4(page);
    const tuner = page.locator('#systemTunerHost');
    for (const [i, name] of ['pythagorean', 'custom', 'major-third', 'minor-third', 'equal', 'future-mode'].entries()) {
      await showTunerTab(page, '履歴・楽器・設定');
      await tuner.locator('[data-tuner-menu-section="settings"]').click();
      await expect(tuner.locator('[data-tuner-temperament-presets]')).toContainText(name);
      await tuner.locator(`[data-tuner-temperament-preset-use="t${i}"]`).click();
      const announcement = tuner.locator('[data-tuner-announcer]');
      if (i < 4) {
        await expect(announcement).toHaveText(`測定は平均律に固定のため、「${name}」の音律は適用されません（判定する音のみ反映しました）`);
        await expect(announcement).not.toContainText('呼び出しました');
      } else await expect(announcement).toHaveText(`音律「${name}」を呼び出しました`);
      await showTunerTab(page, '測定');
      await expect(tuner.locator('[data-tuner-root]')).toHaveAttribute('data-mode', 'equal');
      await expect(tuner.locator('[data-tuner-fixed-note]')).toHaveValue(name === 'equal' ? '' : '70');
      await expect(tuner.locator('[data-tuner-cents]')).toHaveText(name === 'equal' ? /^(−1|0|\+1) cent$/ : /^−(99|100|101) cent$/);
    }
    await showTunerTab(page, '履歴・楽器・設定');
    await tuner.locator('[data-tuner-menu-section="settings"]').click();
    await tuner.locator('[data-tuner-temperament-preset-name]').fill('現在の平均律');
    await tuner.locator('[data-tuner-temperament-preset-save]').click();
    await expect(tuner.locator('[data-tuner-temperament-presets]')).toContainText('現在の平均律');
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('portalTunerSettings')).prefs.presets.temperament);
    expect(saved.at(-1).data).toMatchObject({ temperament: 'equal', fixedMidi: 70 });
    await tuner.locator(`[data-tuner-temperament-preset-delete="${saved.at(-1).id}"]`).click();
    await expect(tuner.locator('[data-tuner-temperament-presets]')).not.toContainText('現在の平均律');
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
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('portalTunerSettings')).prefs.presets.sound)).toEqual([]);
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
