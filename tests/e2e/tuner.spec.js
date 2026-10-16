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
    const record = { contexts: [], streams: [], workers: [], gum: 0, frequencies: [] };
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
    await expect(tuner.getByText('一度に一つの音を、長めに鳴らしてください')).toBeVisible();
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

  test('reference A4 changes immediately, stops at the range ends and is restored', async ({ page }) => {
    await login(page);
    await openTuner(page);
    await expectMeasuringA4(page);
    const tuner = page.locator('#systemTunerHost');
    const reference = tuner.locator('[data-tuner-reference]');
    const down = tuner.getByRole('button', { name: '基準周波数を下げる' });
    const up = tuner.getByRole('button', { name: '基準周波数を上げる' });
    await expect(reference).toHaveText('A4 = 442 Hz');
    for (const box of [await down.boundingBox(), await up.boundingBox()]) {
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    await down.click();
    await down.click();
    await expect(reference).toHaveText('A4 = 440 Hz');
    await expect(tuner.locator('[data-tuner-cents]')).toHaveText(/^(−1|0|\+1) cent$/);
    await expect(tuner.locator('[data-tuner-judgment]')).toContainText('合っています');
    await expect(tuner.locator('[data-tuner-announcer]')).toHaveText('基準周波数 A4 = 440 Hz');
    await page.evaluate(() => localStorage.setItem('portalTunerReferenceA4Hz', '431'));
    // Leave and come back so the stored value is read again.
    await page.locator('#systemPanel .toolbar').getByRole('button', { name: '実験室', exact: true }).click();
    await page.locator('#system-laboratoryTab').getByRole('button', { name: 'チューナー', exact: true }).click();
    await expect(reference).toHaveText('A4 = 431 Hz');
    await down.click();
    await expect(reference).toHaveText('A4 = 430 Hz');
    await expect(down).toBeDisabled();
    await expect(up).toBeEnabled();
    expect(await page.evaluate(() => localStorage.getItem('portalTunerReferenceA4Hz'))).toBe('430');
    // Logout keeps the device setting; the next login restores it.
    await page.click('#portalDrawerToggle');
    await page.locator('#portalDrawer [data-drawer-action="logout"]').click();
    await expect(page.locator('#portalLoginPanel')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('portalTunerReferenceA4Hz'))).toBe('430');
    await page.fill('#portalNameInput', '団員テスト');
    await page.selectOption('#portalPartInput', { label: 'Violin' });
    await page.fill('#portalPasswordInput', 'dummy-pass');
    await page.click('#portalLoginBtn');
    await expect(page.locator('#memberPanel')).toBeVisible();
    await openTuner(page);
    await expect(reference).toHaveText('A4 = 430 Hz');
    await page.evaluate(() => localStorage.setItem('portalTunerReferenceA4Hz', '442.5'));
    await page.locator('#systemPanel .toolbar').getByRole('button', { name: '実験室', exact: true }).click();
    await page.locator('#system-laboratoryTab').getByRole('button', { name: 'チューナー', exact: true }).click();
    await expect(reference).toHaveText('A4 = 442 Hz');
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
