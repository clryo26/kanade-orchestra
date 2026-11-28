const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { installPortalApiMocks } = require('./fixtures/mockApi');

// Kept local to each spec: no test-only layout or tab API overrides.
async function settleStickyTuner(page, root) {
  await expect(root).toBeVisible();
  await expect(root.locator('[data-tuner-panel]:not([hidden]) [data-tuner-loading]')).toHaveCount(0);
  await expect(page.locator('#portalLoadingBar')).toBeHidden();
  await expect(page.locator('#portalDrawer')).toBeHidden();
  await expect(page.locator('#portalDrawerBackdrop')).toBeHidden();
  await root.evaluate(async (element) => {
    await document.fonts.ready;
    const animations = [];
    for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
      animations.push(...ancestor.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity));
    }
    await Promise.all(animations.map((a) => a.finished));
  });
  let previous;
  let stable = 0;
  await expect.poll(async () => {
    const shape = await root.evaluate((element) => {
      const panel = element.querySelector('[data-tuner-panel]:not([hidden])');
      const nav = document.querySelector('nav.navbar.sticky-top');
      return [element.offsetWidth, element.offsetHeight, element.scrollHeight, panel.offsetHeight,
        document.scrollingElement.scrollHeight, nav?.getBoundingClientRect().height || 0].join(',');
    });
    stable = shape === previous ? stable + 1 : 0;
    previous = shape;
    return stable;
  }).toBeGreaterThanOrEqual(2);
}

async function stickyTunerSnapshot(root, id) {
  return root.evaluate(async (element, id) => {
    const bar = element.querySelector('[data-tuner-tabbar]');
    const button = id && bar.querySelector(`[data-tuner-tab="${id}"]`);
    const rect = (node) => node ? node.getBoundingClientRect().toJSON() : null;
    if (button) {
      const b = rect(button), r = rect(bar);
      if (b.left < r.left) bar.scrollLeft += b.left - r.left;
      else if (b.right > r.right) bar.scrollLeft += b.right - r.right;
    }
    const maximized = element.classList.contains('tuner-maximized');
    const scroller = maximized ? element : document.scrollingElement;
    // Always reach the current true bottom, including after lazy panel creation.
    // scrollTop assignment inherits CSS scroll-behavior (Bootstrap enables smooth
    // page scrolling). Move instantly so the snapshot cannot sample its animation.
    let bottomStableFrames = 0;
    let previousBottom;
    // Lazy content can change the bottom between frames. Keep targeting the
    // actual bottom, never a navbar-adjusted position, and retain the strict
    // assertion below if the bounded wait cannot reach a stable bottom.
    for (let i = 0; i < 120 && bottomStableFrames < 3; i += 1) {
      scroller.scrollTo({ top: scroller.scrollHeight - scroller.clientHeight, behavior: 'instant' });
      await new Promise(requestAnimationFrame);
      const bottom = scroller.scrollHeight - scroller.clientHeight;
      bottomStableFrames = bottom === previousBottom && Math.abs(scroller.scrollTop - bottom) <= 1
        ? bottomStableFrames + 1 : 0;
      previousBottom = bottom;
    }
    const ancestors = [];
    const following = [];
    for (let node = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      for (let sibling = node.nextElementSibling; sibling; sibling = sibling.nextElementSibling) {
        if (sibling.getClientRects().length) following.push({ tag: sibling.tagName, id: sibling.id, className: sibling.className, rect: rect(sibling) });
      }
      ancestors.push({ tag: node.tagName, id: node.id, overflowX: style.overflowX, overflowY: style.overflowY, transform: style.transform, rect: rect(node) });
    }
    const navbar = document.querySelector('nav.navbar.sticky-top');
    const navbarVisible = navbar && navbar.getClientRects().length && getComputedStyle(navbar).visibility === 'visible';
    const b = rect(button), r = rect(bar);
    const point = button ? {
      x: (Math.max(b.left, r.left, 0) + Math.min(b.right, r.right, innerWidth)) / 2,
      y: (b.top + b.bottom) / 2,
    } : null;
    const front = point ? document.elementFromPoint(point.x, point.y) : null;
    return {
      width: innerWidth, height: innerHeight, maximized,
      scroll: scroller.scrollTop, maxScroll: scroller.scrollHeight - scroller.clientHeight,
      bottomStableFrames, scrollBehavior: getComputedStyle(scroller).scrollBehavior,
      ancestors, navbar: rect(navbar), navbarVisible: Boolean(navbarVisible), root: rect(element), bar: r,
      following, pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      barOverflowX: getComputedStyle(bar).overflowX,
      transport: rect(document.querySelector('[data-metronome-transport]')),
      top: getComputedStyle(bar).top, paddingTop: getComputedStyle(element).paddingTop,
      offset: document.documentElement.style.getPropertyValue('--tuner-tabbar-top'),
      button: b, point, front: front ? { tag: front.tagName, id: front.id, className: front.className } : null,
      hit: Boolean(button && (front === button || button.contains(front))),
      clickPosition: button ? { x: point.x - b.left, y: point.y - b.top } : null,
    };
  }, id);
}

async function checkStickyTuner(page, root, testInfo, label) {
  const captureBefore = await probe(page);
  // Reopening can retain ended streams in the probe; the current run must be live.
  expect(captureBefore.tracks.some((state) => state === 'live')).toBe(true);
  const record = async (id, phase) => {
    await settleStickyTuner(page, root);
    const sample = await stickyTunerSnapshot(root, id);
    await testInfo.attach(`${label}-${id}-${phase}`, { body: JSON.stringify(sample, null, 2), contentType: 'application/json' });
    const detail = JSON.stringify(sample);
    expect(Math.abs(sample.scroll - sample.maxScroll), detail).toBeLessThanOrEqual(1);
    expect(sample.bottomStableFrames, detail).toBeGreaterThanOrEqual(3);
    expect(sample.maxScroll, detail).toBeGreaterThanOrEqual(0);
    if (sample.maximized) {
      expect(sample.top, detail).toBe('0px');
      expect(sample.bar.top, detail).toBeGreaterThanOrEqual(sample.root.top - 1);
      // Padding and safe-area stay in the existing maximized scroll container.
      expect(sample.bar.top, detail).toBeLessThanOrEqual(sample.root.top + parseFloat(sample.paddingTop) + 1);
    } else {
      expect(sample.bar.top, detail).toBeGreaterThanOrEqual((sample.navbarVisible ? sample.navbar.bottom : 0) - 1);
      expect(parseFloat(sample.top), detail).toBeCloseTo(sample.navbarVisible ? sample.navbar.height : 0, 1);
      expect(sample.ancestors.filter((a) => !['HTML', 'BODY'].includes(a.tag) && /auto|scroll|hidden|clip/.test(a.overflowY)), detail).toEqual([]);
      expect(sample.ancestors.filter((a) => a.transform !== 'none'), detail).toEqual([]);
    }
    expect(sample.pageOverflow, detail).toBeLessThanOrEqual(1);
    expect(sample.barOverflowX, detail).toBe('auto');
    expect(sample.point.x, detail).toBeGreaterThanOrEqual(sample.button.left);
    expect(sample.point.x, detail).toBeLessThan(sample.button.right);
    expect(sample.point.x, detail).toBeGreaterThanOrEqual(0);
    expect(sample.point.x, detail).toBeLessThan(sample.width);
    expect(sample.point.y, detail).toBeGreaterThanOrEqual(0);
    expect(sample.point.y, detail).toBeLessThan(sample.height);
    expect(sample.hit, detail).toBe(true); // also catches the metronome transport covering a tab
    expect(sample.root.bottom, detail).toBeGreaterThanOrEqual(sample.bar.bottom - 1);
    return sample;
  };
  // Finish on measure so the existing maximize control is available to callers.
  for (const id of ['sound', 'analyzer', 'trainer', 'diagnosis', 'menu', 'measure']) {
    const before = await record(id, 'before');
    const button = root.locator(`[data-tuner-tab="${id}"]`);
    await button.click({ position: before.clickPosition });
    await expect(button).toHaveAttribute('aria-selected', 'true');
    await expect(root).toHaveAttribute('data-tab', id);
    await expect(root.locator(`[data-tuner-panel="${id}"]`)).toBeVisible();
    await record(id, 'after');
    await expect(root.locator('[data-tuner-chip-mic]')).toBeVisible();
    const captureAfter = await probe(page);
    expect(captureAfter.gum).toBe(captureBefore.gum);
    expect(captureAfter.tracks).toEqual(captureBefore.tracks);
    expect(captureAfter.tracks.some((state) => state === 'live')).toBe(true);
  }
}

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
  await expect(tuner.locator('[data-tuner-solfege]')).toHaveCount(0);
  await expect(tuner.locator('[data-tuner-readout]')).not.toContainText('（ラ）');
  // The first frames after start can be transient; the smoothed reading must settle on 440 Hz.
  await expect.poll(async () => {
    const value = Number.parseFloat(await tuner.locator('[data-tuner-frequency]').textContent());
    return value > 439.5 && value < 440.5;
  }, { timeout: 5000 }).toBe(true);
  // No momentary off-pitch reading was ever displayed (onset confirmation).
  const shown = (await probe(page)).frequencies;
  expect(shown.filter((value) => value < 438 || value > 442)).toEqual([]);
}

// Capture the real view when view.js registers it, before the launcher creates it.
// Only this test wrapper may inject readings after pause; other callers are evidence
// of a render/reset race, even if they happen to write the same text.
async function captureReadoutView(page) {
  await page.addInitScript(() => {
    Object.defineProperty(Element.prototype, 'requestFullscreen', { configurable: true, value: undefined });
    const capture = { view: null, injecting: false, measuring: false, calls: [], unexpected: [] };
    window.__readoutProbe = capture;
    const lib = window.PortalTunerLib = window.PortalTunerLib || {};
    let registered;
    Object.defineProperty(lib, 'view', {
      configurable: true,
      get() { return registered; },
      set(api) {
        const create = api.createTunerView;
        api.createTunerView = function (...args) {
          const view = create.apply(this, args);
          if (args[0].id === 'systemTunerHost') {
            capture.view = view;
            const show = view.showReading;
            view.showReading = function (...readings) {
              const call = {
                source: capture.injecting ? 'test' : 'production',
                state: readings[0]?.state || 'none', label: readings[0]?.note?.label || '—',
              };
              capture.calls.push(call);
              if (capture.measuring && !capture.injecting) {
                capture.unexpected.push({ ...call, stack: new Error().stack });
              }
              return show.apply(this, readings);
            };
          }
          return view;
        };
        registered = api;
      },
    });
  });
}

async function pauseReadoutForMeasurement(page) {
  await expectMeasuringA4(page);
  const root = page.locator('#systemTunerHost [data-tuner-root]');
  await root.locator('[data-tuner-pause]').click();
  await expect(root).toHaveAttribute('data-paused', 'true');
  await expect(root).toHaveAttribute('data-state', 'paused');
  await expect(root.locator('[data-tuner-status]')).toBeVisible();
  await expect(root.locator('[data-tuner-chip-mic]')).toBeVisible();
  await expectReleased(page);
  await expect(root.locator('[data-tuner-readout]')).toHaveAttribute('data-state', 'none');
  await expect(root.locator('[data-tuner-note]')).toHaveText('—');
  await expect(root.locator('[data-tuner-frequency]')).toHaveText('— Hz');
  await page.evaluate(async () => {
    for (let i = 0; i < 3; i += 1) await new Promise(requestAnimationFrame);
    window.__readoutProbe.measuring = true;
  });
  return root;
}

// Invoke only the captured production view. Keep caller tracking enabled across
// animation frames so an unrelated render/reset cannot make an assertion pass.
async function renderReadoutSnapshot(page, snapshot) {
  return page.evaluate(async (snapshot) => {
    const probe = window.__readoutProbe;
    probe.injecting = true;
    try { probe.view.showReading(snapshot); } finally { probe.injecting = false; }
    for (let i = 0; i < 3; i += 1) await new Promise(requestAnimationFrame);
    const root = probe.view.root;
    const text = (name) => root.querySelector(`[data-tuner-${name}]`).textContent;
    const needle = root.querySelector('[data-tuner-needle]');
    return {
      state: root.querySelector('[data-tuner-readout]').dataset.state,
      label: text('note'), frequency: text('frequency'), cents: text('cents'), judgment: text('judgment'),
      meterJudgment: root.querySelector('[data-tuner-meter]').dataset.judgment,
      needleHidden: needle.hidden, needleLeft: needle.style.left,
      paused: root.dataset.paused, rootState: root.dataset.state,
      unexpected: probe.unexpected.slice(),
    };
  }, snapshot);
}

async function measureReadout(page, width, mode, testInfo) {
  const result = await page.evaluate(async ({ width, mode }) => {
    const probe = window.__readoutProbe;
    const root = probe.view.root;
    const lib = window.PortalTunerLib;
    const readout = root.querySelector('[data-tuner-readout]');
    const note = root.querySelector('[data-tuner-note]');
    const noteArea = note.parentElement;
    const label = readout.querySelector('.tuner-readout-label');
    const frequency = root.querySelector('[data-tuner-frequency]');
    const meter = root.querySelector('[data-tuner-meter]');
    const panel = root.querySelector('[data-tuner-panel="measure"]');
    const frames = async () => {
      for (let i = 0; i < 3; i += 1) await new Promise(requestAnimationFrame);
    };
    await document.fonts.ready;
    // Button clicks can scroll focused controls. Reset every scroll ancestor once
    // per mode, then hold that position throughout the reading sequence.
    for (let element = root; element; element = element.parentElement) {
      element.scrollTop = 0;
      element.scrollLeft = 0;
    }
    window.scrollTo(0, 0);
    await frames();
    const rect = (element) => {
      const r = element.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    };
    const textRect = (element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const r = range.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    };
    const dimensions = (element) => ({
      clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
      clientHeight: element.clientHeight, scrollHeight: element.scrollHeight,
    });
    const visible = (element) => !element.hidden && getComputedStyle(element).display !== 'none' &&
      getComputedStyle(element).visibility === 'visible' && rect(element).width > 0 && rect(element).height > 0;
    const status = root.querySelector('[data-tuner-status]');
    const chip = root.querySelector('[data-tuner-chip-mic]');
    const fixedStatus = { box: rect(status), chip: rect(chip), text: status.textContent, chipText: chip.textContent };
    const inputs = [{ snapshot: null, label: '—', frequency: '— Hz', state: 'none' }];
    const add = (midi, spelling, naming, state = 'active', expected) => {
      const spelled = lib.targetModel.spell(midi, spelling);
      const named = naming === 'solfege' ? { ...spelled, label: spelled.solfege + spelled.octave, solfege: '' } : spelled;
      // Explicit representatives keep a naming regression from defining its own oracle.
      if (expected && named.label !== expected) throw new Error(`Expected ${expected}, generated ${named.label}`);
      const hz = lib.music.noteFrequency(midi, 440);
      inputs.push({
        snapshot: { state, note: named, frequency: hz, centsRounded: 0, judgment: 'in-tune', needlePercent: 50 },
        label: expected || named.label, frequency: hz.toFixed(1) + ' Hz', state,
      });
    };
    const representatives = [
      [60, 'default', 'en', 'C4'], [69, 'default', 'en', 'A4'],
      [61, 'sharp', 'en', 'C♯4'], [66, 'sharp', 'en', 'F♯4'],
      [70, 'flat', 'en', 'B♭4'], [24, 'default', 'en', 'C1'],
      [108, 'default', 'en', 'C8'], [66, 'sharp', 'solfege', 'ファ♯4'],
      [102, 'sharp', 'solfege', 'ファ♯7'], [66, 'flat', 'solfege', 'ソ♭4'],
    ];
    for (const [midi, spelling, naming, expected] of representatives) {
      add(midi, spelling, naming, 'active', expected);
      add(midi, spelling, naming, 'held', expected);
      inputs.push({ snapshot: { state: 'none' }, label: '—', frequency: '— Hz', state: 'none' });
    }
    // Literal oracles for two/three/four digits, rounding and trailing zero;
    // these also receive the full containment/height checks in every mode.
    for (const [hz, expected] of [[32.74, '32.7 Hz'], [440, '440.0 Hz'], [466.16, '466.2 Hz'], [2959.96, '2960.0 Hz']]) {
      const named = lib.music.describeNote(lib.music.nearestMidi(hz, 440));
      inputs.push({
        snapshot: { state: 'active', note: named,
          frequency: hz, centsRounded: 0, judgment: 'in-tune', needlePercent: 50 },
        label: named.label, frequency: expected, state: 'active',
      });
    }
    // Compare actual rendered widths across all single-accidental spellings and
    // one-digit octaves, rather than assuming character count predicts width.
    const seen = new Set();
    for (let midi = 24; midi <= 108; midi += 1) {
      for (const spelling of ['default', 'sharp', 'flat']) {
        for (const naming of ['en', 'solfege']) {
          const spelled = lib.targetModel.spell(midi, spelling);
          const key = naming === 'solfege' ? spelled.solfege + spelled.octave : spelled.label;
          if (!seen.has(key)) { seen.add(key); add(midi, spelling, naming); }
        }
      }
    }
    // Return through the named representatives to silence, not just increasing widths.
    for (const [midi, spelling, naming, expected] of representatives.slice().reverse()) {
      add(midi, spelling, naming, 'active', expected);
    }
    inputs.push({ snapshot: null, label: '—', frequency: '— Hz', state: 'none' });
    const samples = [];
    const errors = [];
    let widest = { label: '', width: 0 };
    const inside = (inner, outer) => inner.left >= outer.left - 0.5 && inner.top >= outer.top - 0.5 &&
      inner.right <= outer.right + 0.5 && inner.bottom <= outer.bottom + 0.5;
    for (const input of inputs) {
      probe.injecting = true;
      try { probe.view.showReading(input.snapshot); } finally { probe.injecting = false; }
      // Await font fallback for the newly inserted Japanese/accidental glyphs too.
      await document.fonts.ready;
      await frames();
      const sample = {
        input: { label: input.label, frequency: input.frequency, state: input.state },
        actual: { label: note.textContent, frequency: frequency.textContent, state: readout.dataset.state },
        root: { state: root.dataset.state, paused: root.dataset.paused, maximized: root.classList.contains('tuner-maximized') },
        readout: rect(readout), noteArea: rect(noteArea), note: rect(note), noteText: textRect(note),
        label: textRect(label), frequency: textRect(frequency), meter: rect(meter),
        panel: rect(panel), rootBounds: rect(root),
        scroll: { note: dimensions(noteArea), readout: dimensions(readout), panel: dimensions(panel), root: dimensions(root) },
        unexpected: probe.unexpected.slice(),
      };
      const check = (ok, reason) => { if (!ok) errors.push({ reason, sample }); };
      check(visible(panel) && visible(readout) && visible(noteArea) && visible(note), 'visible nonzero measurement');
      check(visible(status) && visible(chip) && chip.dataset.state === 'paused' &&
        status.textContent === fixedStatus.text && chip.textContent === fixedStatus.chipText &&
        Math.abs(rect(status).height - fixedStatus.box.height) <= 0.5 &&
        Math.abs(rect(chip).height - fixedStatus.chip.height) <= 0.5, 'paused status remains visible and fixed');
      check(sample.root.state === 'paused' && sample.root.paused === 'true', 'paused root');
      check(sample.root.maximized === mode.startsWith('maximized'), 'display mode');
      check(sample.actual.label === input.label && sample.actual.frequency === input.frequency &&
        sample.actual.state === input.state, 'exact text and state survive multiple frames');
      check(sample.unexpected.length === 0, 'production showReading interrupted controlled measurement');
      check(inside(sample.noteText, sample.noteArea) && inside(sample.note, sample.noteArea) &&
        inside(sample.noteText, sample.readout) && inside(sample.note, sample.readout) &&
        inside(sample.noteArea, sample.readout), 'note text and element containment on all four edges');
      check(inside(sample.label, sample.readout) && inside(sample.frequency, sample.readout), 'label/frequency containment');
      check(sample.label.bottom <= sample.noteArea.top + 0.5 &&
        sample.noteArea.bottom <= sample.frequency.top + 0.5, 'rows do not overlap');
      for (const key of ['note', 'readout']) {
        const d = sample.scroll[key];
        check(d.scrollWidth <= d.clientWidth + 1 && d.scrollHeight <= d.clientHeight + 1, `${key} scroll containment`);
      }
      check(sample.scroll.panel.scrollWidth <= sample.scroll.panel.clientWidth + 1, 'measurement panel horizontal overflow');
      if (sample.root.maximized) check(sample.scroll.root.scrollWidth <= sample.scroll.root.clientWidth + 1, 'maximized root horizontal overflow');
      if (sample.scroll.panel.scrollWidth > sample.scroll.panel.clientWidth + 1 ||
        (sample.root.maximized && sample.scroll.root.scrollWidth > sample.scroll.root.clientWidth + 1)) {
        // Identify whether the readout or an existing surrounding control is wide;
        // a failure must not invite changes to the meter/settings/tab bar.
        sample.horizontalOverflow = Array.from(root.querySelectorAll('*')).filter((element) => {
          if (!visible(element)) return false;
          const bounds = rect(element);
          return bounds.right > sample.rootBounds.right + 1 || bounds.left < sample.rootBounds.left - 1 ||
            (panel.contains(element) && (bounds.right > sample.panel.right + 1 || bounds.left < sample.panel.left - 1));
        }).map((element) => ({ element: element.className, readout: readout.contains(element), bounds: rect(element) }));
      }
      // A generous box must not pass by hiding text at any of its ancestors.
      for (let element = note; element && element !== panel; element = element.parentElement) {
        const style = getComputedStyle(element);
        check(!['hidden', 'clip'].includes(style.overflowX) && !['hidden', 'clip'].includes(style.overflowY) &&
          style.textOverflow !== 'ellipsis' && style.clipPath === 'none' && style.maskImage === 'none' &&
          style.visibility === 'visible' && style.opacity !== '0', 'no clipping, masking or hidden note');
      }
      if (sample.noteText.width > widest.width) widest = { label: input.label, width: sample.noteText.width };
      samples.push(sample);
      if (errors.length) break; // retain complete diagnostics for the first failing input
    }
    const spread = (get) => Math.max(...samples.map(get)) - Math.min(...samples.map(get));
    const variation = {
      readout: spread((s) => s.readout.height), note: spread((s) => s.noteArea.height),
      meterTop: spread((s) => s.meter.top),
    };
    for (const [key, value] of Object.entries(variation)) {
      if (value > 0.5) errors.push({ reason: `${key} variation ${value} exceeds 0.5 CSS px`, samples });
    }
    return { width, mode, widest, variation, first: samples[0], last: samples.at(-1), errors, unexpected: probe.unexpected };
  }, { width, mode });
  console.log(`tuner readout widest: ${JSON.stringify({ width, mode, ...result.widest })}`);
  await testInfo.attach(`readout-${width}-${mode}`, { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
  expect(result.errors, JSON.stringify(result)).toEqual([]);
  return result.first;
}

test.describe('tuner tabbar at the actual scroll bottom', () => {
  for (const width of [390, 1280]) {
    for (const navbar of ['visible', 'absent', 'hidden']) {
      test(`${width}px navbar ${navbar}: normal, resized, maximized and restored`, async ({ page, context }, testInfo) => {
        test.setTimeout(240000);
        await page.setViewportSize({ width, height: 844 });
        await context.grantPermissions(['microphone']);
        // Exercise the CSS maximized fallback independently of Fullscreen support.
        await page.addInitScript(() => {
          Object.defineProperty(Element.prototype, 'requestFullscreen', { configurable: true, value: undefined });
        });
        await instrument(page);
        await installPortalApiMocks(page, { permission: 'システム管理者' });
        await login(page);
        await openTuner(page);
        await expectMeasuringA4(page);
        const root = page.locator('#systemTunerHost [data-tuner-root]');
        if (navbar !== 'visible') {
          // Only change the environment condition; retain all tuner/sibling layout.
          await page.locator('nav.navbar.sticky-top').evaluate((nav, mode) => {
            if (mode === 'absent') nav.remove();
            else nav.style.display = 'none';
          }, navbar);
          // The real resize entrance reacquires the navbar (no synthetic events).
          await page.setViewportSize({ width: width + 1, height: 844 });
          await page.setViewportSize({ width, height: 844 });
          await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--tuner-tabbar-top'))).toBe('0px');
        }
        await checkStickyTuner(page, root, testInfo, `${width}-normal-${navbar}`);
        const otherWidth = width === 390 ? 1280 : 390;
        await page.setViewportSize({ width: otherWidth, height: 844 });
        await checkStickyTuner(page, root, testInfo, `${otherWidth}-resized-${navbar}`);
        await page.setViewportSize({ width, height: 844 });
        await root.locator('[data-tuner-maximize]').click();
        await expect(root).toHaveClass(/tuner-maximized/);
        await checkStickyTuner(page, root, testInfo, `${width}-maximized-${navbar}`);
        // While maximized, update the normal offset too; restore must use it.
        await page.setViewportSize({ width: otherWidth, height: 844 });
        await checkStickyTuner(page, root, testInfo, `${otherWidth}-maximized-resized-${navbar}`);
        await root.locator('[data-tuner-maximize]').click();
        await expect(root).not.toHaveClass(/tuner-maximized/);
        await checkStickyTuner(page, root, testInfo, `${otherWidth}-restored-${navbar}`);
        await expectMeasuringA4(page);
        await page.locator('#systemPanel .toolbar').getByRole('button', { name: '実験室', exact: true }).click();
        await expectReleased(page);
      });
    }
  }
});

test.describe('tuner readout stable geometry', () => {
  for (const width of [277, 390, 1280]) {
    for (const maximized of [false, true]) {
      test(`${width}px ${maximized ? 'maximized and restored' : 'normal'} readout`, async ({ page, context }, testInfo) => {
        test.setTimeout(180000);
        await page.setViewportSize({ width, height: 844 });
        await context.grantPermissions(['microphone']);
        await instrument(page);
        await captureReadoutView(page);
        await installPortalApiMocks(page, { permission: 'システム管理者' });
        await login(page);
        await openTuner(page);
        const root = await pauseReadoutForMeasurement(page);
        const before = await measureReadout(page, width, 'normal', testInfo);
        if (maximized) {
          await root.locator('[data-tuner-maximize]').click();
          await expect(root).toHaveClass(/tuner-maximized/);
          await measureReadout(page, width, 'maximized', testInfo);
          await root.locator('[data-tuner-maximize]').click();
          await expect(root).not.toHaveClass(/tuner-maximized/);
          const after = await measureReadout(page, width, 'restored', testInfo);
          expect(Math.abs(after.readout.height - before.readout.height)).toBeLessThanOrEqual(0.5);
          expect(Math.abs(after.noteArea.height - before.noteArea.height)).toBeLessThanOrEqual(0.5);
        }
      });
    }
  }
});

test.describe('tuner readout unchanged behavior', () => {
  test.beforeEach(async ({ page, context }) => {
    await context.grantPermissions(['microphone']);
    await instrument(page);
    await captureReadoutView(page);
    await installPortalApiMocks(page, { permission: 'システム管理者' });
    await login(page);
    await openTuner(page);
    await pauseReadoutForMeasurement(page);
  });

  test('held renders the supplied snapshot; none and null clear all reading fields', async ({ page }) => {
    const notes = await page.evaluate(() => ({
      active: window.PortalTunerLib.music.describeNote(61),
      held: window.PortalTunerLib.music.describeNote(58),
    }));
    expect(notes.active.label).toBe('C♯4');
    expect(notes.held.label).toBe('B♭3');
    const active = { state: 'active', note: notes.active, frequency: 277.18,
      centsRounded: 12, judgment: 'sharp', needlePercent: 62 };
    const held = { state: 'held', note: notes.held, frequency: 233.08,
      centsRounded: -8, judgment: 'flat', needlePercent: 42 };
    const cases = [
      [active, { state: 'active', label: 'C♯4', frequency: '277.2 Hz', cents: '+12 cent',
        judgment: '高い ▶', meterJudgment: 'sharp', needleHidden: false, needleLeft: '62%' }],
      // Different from the previous active value: showReading must not retain it.
      [held, { state: 'held', label: 'B♭3', frequency: '233.1 Hz', cents: '−8 cent',
        judgment: '◀ 低い', meterJudgment: 'flat', needleHidden: false, needleLeft: '42%' }],
    ];
    const cleared = { state: 'none', label: '—', frequency: '— Hz', cents: '— cent',
      judgment: '音を待っています', meterJudgment: 'none', needleHidden: true, needleLeft: '50%' };
    // Stale fields in a none snapshot must not leak into the cleared display.
    cases.push([{ ...held, state: 'none' }, cleared], [active, cases[0][1]], [null, cleared]);
    for (const [snapshot, expected] of cases) {
      expect(await renderReadoutSnapshot(page, snapshot)).toEqual({
        ...expected, paused: 'true', rootState: 'paused', unexpected: [],
      });
    }
  });

  test('filter holds the same reading through 1000ms, clears at 1001ms and recovers', async ({ page }) => {
    // Explicit filter timestamps exercise the actual hold boundary without
    // changing browser clocks, production settings or the paused render loop.
    const snapshots = await page.evaluate(() => {
      const lib = window.PortalTunerLib;
      const filter = lib.displayFilter.createDisplayFilter();
      let active;
      for (let now = 50; now <= 2000; now += 50) {
        active = filter.push({ valid: true, frequency: 440 }, now, 440);
      }
      const held500 = filter.push({ valid: false }, 2500, 440);
      const held1000 = filter.push({ valid: false }, 3000, 440);
      const none1001 = filter.push({ valid: false }, 3001, 440);
      filter.push({ valid: true, frequency: 440 }, 3050, 440);
      const recovered = filter.push({ valid: true, frequency: 440 }, 3100, 440);
      const fixed = filter.setTarget({ temperament: 'equal', fixedMidi: 60 }, 3100, 440);
      return { active, held500, held1000, none1001, recovered, fixed };
    });
    for (const name of ['active', 'held500', 'held1000', 'recovered', 'fixed']) {
      expect(snapshots[name].note.label, name).toBe('A4');
      expect(snapshots[name].frequency, name).toBeCloseTo(440, 8);
    }
    expect(snapshots.held500).toEqual({ ...snapshots.active, state: 'held' });
    expect(snapshots.held1000).toEqual({ ...snapshots.active, state: 'held' });
    expect(snapshots.none1001).toEqual({ state: 'none' });
    expect(snapshots.recovered.state).toBe('active');
    expect(snapshots.fixed.targetNote.label).toBe('C4');
    expect(snapshots.fixed.centsRounded).toBe(900);
    for (const name of ['active', 'held500', 'held1000', 'none1001', 'recovered', 'fixed']) {
      const snapshot = snapshots[name];
      const rendered = await renderReadoutSnapshot(page, snapshot);
      expect(rendered, name).toMatchObject({
        state: snapshot.state, label: name === 'none1001' ? '—' : 'A4',
        frequency: name === 'none1001' ? '— Hz' : '440.0 Hz',
        cents: name === 'none1001' ? '— cent' : name === 'fixed' ? '+900 cent' : '0 cent',
        judgment: name === 'none1001' ? '音を待っています' : name === 'fixed' ? '高い ▶' : '● 合っています',
        needleHidden: name === 'none1001', needleLeft: name === 'fixed' ? '100%' : '50%',
        paused: 'true', rootState: 'paused', unexpected: [],
      });
    }
  });
});

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
    await expect(tuner.locator('[data-tuner-announcer]')).toHaveText('A4 ラ', { timeout: 5000 });
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

  // Measuring A4: integer 390-480 Hz in 1 Hz steps, presets and direct
  // input; stored as portalTunerSettings (a4Tenths). The old key is only a
  // read-once migration source and is never written again.
  test('reference A4: 1 Hz steps, integer input limits, legacy migration and restore', async ({ page }) => {
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
    const announcer = tuner.locator('[data-tuner-announcer]');
    const down = tuner.getByRole('button', { name: '基準周波数を1 Hz下げる', exact: true });
    const up = tuner.getByRole('button', { name: '基準周波数を1 Hz上げる', exact: true });
    // Migrated from the legacy value (441 Hz).
    await expect(reference).toHaveText('A4 = 441 Hz');
    for (const box of [await down.boundingBox(), await up.boundingBox()]) {
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    await up.click();
    await expect(reference).toHaveText('A4 = 442 Hz');
    await expect(announcer).toHaveText('基準周波数 A4 = 442 Hz');
    const stored = await page.evaluate(() => [localStorage.getItem('portalTunerSettings'), localStorage.getItem('portalTunerReferenceA4Hz')]);
    expect(JSON.parse(stored[0])).toMatchObject({ schemaVersion: 1, a4Tenths: 4420 });
    expect(stored[1]).toBe('441'); // the legacy key is never rewritten
    await down.click();
    await expect(reference).toHaveText('A4 = 441 Hz');
    await expect(announcer).toHaveText('基準周波数 A4 = 441 Hz');
    expect(JSON.parse(await page.evaluate(() => localStorage.getItem('portalTunerSettings'))).a4Tenths).toBe(4410);
    // Preset 440 Hz: 440 Hz input is now in tune.
    await tuner.locator('[data-tuner-presets]').getByRole('button', { name: '440 Hz' }).click();
    await expect(reference).toHaveText('A4 = 440 Hz');
    await expect(tuner.locator('[data-tuner-presets]').getByRole('button', { name: '440 Hz' })).toHaveAttribute('aria-pressed', 'true');
    await expect(tuner.locator('[data-tuner-cents]')).toHaveText(/^(−1|0|\+1) cent$/);
    await expect(tuner.locator('[data-tuner-judgment]')).toContainText('合っています');
    // Direct input: out of range is explained and not applied; the lower limit disables "−".
    const input = tuner.getByLabel('基準周波数を入力（390～480 Hz）');
    await expect(input).toHaveAttribute('inputmode', 'numeric');
    await input.fill('389');
    await tuner.locator('[data-tuner-a4-apply]').click();
    await expect(tuner.locator('[data-tuner-a4-error]')).toBeVisible();
    await expect(tuner.locator('[data-tuner-a4-error]')).toHaveText('390～480 Hz の範囲で入力してください。');
    await expect(reference).toHaveText('A4 = 440 Hz');
    await input.fill('390');
    await tuner.locator('[data-tuner-a4-apply]').click();
    await expect(reference).toHaveText('A4 = 390 Hz');
    await expect(tuner.locator('[data-tuner-a4-error]')).toBeHidden();
    await expect(down).toBeDisabled();
    await expect(up).toBeEnabled();
    await input.fill('480');
    await tuner.locator('[data-tuner-a4-apply]').click();
    await expect(reference).toHaveText('A4 = 480 Hz');
    await expect(tuner.locator('[data-tuner-a4-error]')).toBeHidden();
    await expect(up).toBeDisabled();
    await expect(down).toBeEnabled();
    for (const [text, message] of [
      ['481', '390～480 Hz の範囲で入力してください。'],
      ['442.5', '390～480 の整数で入力してください。'],
      ['442.0', '390～480 の整数で入力してください。'],
    ]) {
      await input.fill(text);
      await tuner.locator('[data-tuner-a4-apply]').click();
      await expect(tuner.locator('[data-tuner-a4-error]')).toBeVisible();
      await expect(tuner.locator('[data-tuner-a4-error]')).toHaveText(message);
      await expect(reference).toHaveText('A4 = 480 Hz');
    }
    for (const text of ['443', '４４３']) {
      await input.fill(text);
      await tuner.locator('[data-tuner-a4-apply]').click();
      await expect(reference).toHaveText('A4 = 443 Hz');
      await expect(tuner.locator('[data-tuner-a4-error]')).toBeHidden();
    }
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

  test('saved fractional A4 and detail preferences start measuring without page errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      localStorage.setItem('portalTunerSettings', JSON.stringify({
        schemaVersion: 1, a4Tenths: 4425, persistSettings: true, prefs: { displayMode: 'detail' },
      }));
    });
    await login(page);
    await openTuner(page);
    await expectMeasuringA4(page);
    const tuner = page.locator('#systemTunerHost');
    await expect(tuner.locator('[data-tuner-reference]')).toHaveText('A4 = 443 Hz');
    await expect(tuner.locator('[data-tuner-detail]')).toHaveCount(0);
    await expect(tuner.locator('[data-tuner-detail-panel]')).toHaveCount(0);
    expect((await probe(page)).tracks).toContain('live');
    expect(errors).toEqual([]);
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

  test('measurement keeps only equal temperament and fixed note selection', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await login(page);
    await openTuner(page);
    await expectMeasuringA4(page);
    const tuner = page.locator('#systemTunerHost');
    for (const attr of ['mode', 'temperament', 'root-field', 'root-select', 'role-field', 'role', 'seventh-field', 'seventh', 'octave-field', 'octave-shift', 'pythagorean-field', 'pyth-start', 'custom-field', 'custom-grid', 'custom-pc', 'temperament-note', 'target-line', 'equal-diff']) {
      await expect(tuner.locator(`[data-tuner-${attr}]`)).toHaveCount(0);
    }
    await expect(tuner.locator('#tunerModeLabel')).toHaveCount(0);
    const fixed = tuner.getByLabel('判定する音', { exact: true });
    await expect(fixed).toHaveValue('');
    await expect(fixed.locator('option')).toHaveCount(86); // auto + C1..C8
    await expect(fixed.locator('option').nth(1)).toHaveAttribute('value', '24');
    await expect(fixed.locator('option').last()).toHaveAttribute('value', '108');
    for (const [midi, cents] of [['24', /\+(4491|4492|4493) cent/], ['108', /−(3907|3908|3909) cent/]]) {
      await fixed.selectOption(midi);
      await expect(fixed).toHaveValue(midi);
      await expect(tuner.locator('[data-tuner-note]')).toHaveText('A4');
      await expect(tuner.locator('[data-tuner-cents]')).toHaveText(cents);
    }
    await fixed.selectOption('60');
    await expect(tuner.locator('[data-tuner-note]')).toHaveText('A4');
    // Fake microphone is 440 Hz, reference is 442 Hz: 900 - 7.85 cent.
    await expect(tuner.locator('[data-tuner-cents]')).toHaveText(/\+(891|892|893) cent/);
    await fixed.selectOption('');
    await expect(tuner.locator('[data-tuner-cents]')).toHaveText(/−(7|8|9) cent/);
    await expect(tuner.locator('[data-tuner-legend]')).toContainText('平均律');
    await showTunerTab(page, '音源');
    for (const attr of ['set-root', 'set-target']) {
      await expect(tuner.locator(`[data-tuner-${attr}]`)).toHaveCount(1);
      await expect(tuner.locator(`[data-tuner-${attr}]`)).toBeHidden();
    }
    await showTunerTab(page, '測定');
    await expect(tuner.locator('[data-tuner-set-root]')).toBeHidden();
    await expect(tuner.locator('[data-tuner-set-target]')).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('reference marks follow meter range, reset and re-entry without changing readings', async ({ page }) => {
    await login(page);
    await openTuner(page);
    await expectMeasuringA4(page);
    const tuner = page.locator('#systemTunerHost');
    const expectReferences = async (range) => {
      const positions = { 10: [-18.5, 128], 25: [22.6, 81.2], 50: [36.3, 65.6], 100: [43.15, 57.8] };
      for (const [index, cent] of [-13.7, 15.6].entries()) {
        const marks = tuner.locator(`[data-tuner-reference-cent="${cent}"]`);
        await expect(marks).toHaveCount(2); // stem and its accessible label
        for (const mark of await marks.all()) {
          // Even hidden references keep their true position, never a clamped edge.
          expect(await mark.evaluate((el) => parseFloat(el.style.left))).toBeCloseTo(positions[range][index], 5);
          if (range === 10) await expect(mark).toBeHidden();
          else {
            await expect(mark).toBeVisible();
            const geometry = await mark.evaluate((el) => {
              const box = el.getBoundingClientRect();
              const parent = el.parentElement.getBoundingClientRect();
              return { left: parseFloat(el.style.left), x: box.x + (el.classList.contains('tuner-meter-reference-label') ? box.width / 2 : 0), origin: parent.x, width: el.parentElement.clientWidth };
            });
            const expected = positions[range][index];
            expect(geometry.left).toBeCloseTo(expected, 5);
            expect(Math.abs(geometry.x - geometry.origin - geometry.width * expected / 100)).toBeLessThan(2);
          }
        }
      }
    };
    await expectReferences(50); // initial render, before any preference events
    await showTunerTab(page, '履歴・楽器・設定');
    await tuner.locator('[data-tuner-menu-section="settings"]').click();
    await tuner.locator('[data-tuner-persist]').check();
    for (const range of [10, 25, 50, 100, 10, 25]) {
      await showTunerTab(page, '履歴・楽器・設定');
      await tuner.locator('[data-tuner-menu-section="settings"]').click();
      await tuner.locator('[data-tuner-meter-range]').selectOption(String(range));
      await showTunerTab(page, '測定');
      await expectReferences(range);
      await expect(tuner.locator('[data-tuner-note]')).toHaveText('A4');
      await expect(tuner.locator('[data-tuner-cents]')).toHaveText(/−(7|8|9) cent/);
      await expect(tuner.locator('[data-tuner-frequency]')).toHaveText(/440\.\d Hz/);
      await expect(tuner.locator('[data-tuner-judgment]')).toContainText('低い');
      const percent = await tuner.locator('[data-tuner-needle]').evaluate((el) => parseFloat(el.style.left));
      expect(Math.abs(percent - (50 + 50 * (1200 * Math.log2(440 / 442)) / range))).toBeLessThan(50 / range);
    }
    await expect(tuner.locator('.tuner-meter-reference-label').first()).toHaveText('参考：純正長3度 −13.7 cent');
    await expect(tuner.locator('.tuner-meter-reference-label').last()).toHaveText('参考：純正短3度 +15.6 cent');
    expect(await tuner.locator('.tuner-meter-references').evaluate((el) => Boolean(el.closest('[aria-live], [role="status"], [role="alert"]')))).toBe(false);
    // A tolerance edit changes the pass band, while references remain static.
    await showTunerTab(page, '履歴・楽器・設定');
    await tuner.locator('[data-tuner-menu-section="settings"]').click();
    await tuner.locator('[data-tuner-tolerance]').selectOption('10');
    await showTunerTab(page, '測定');
    await expect(tuner.locator('[data-tuner-judgment]')).toContainText('合っています');
    await expect(tuner.locator('[data-tuner-cents]')).toHaveText(/−(7|8|9) cent/);
    await expectReferences(25);
    // Moving the target changes the reading and clamps the needle, not marks.
    await tuner.locator('[data-tuner-fixed-note]').selectOption('60');
    await expect(tuner.locator('[data-tuner-note]')).toHaveText('A4');
    await expect(tuner.locator('[data-tuner-cents]')).toHaveText(/\+(891|892|893) cent/);
    await expect(tuner.locator('[data-tuner-judgment]')).toContainText('高い');
    await expect(tuner.locator('[data-tuner-needle]')).toHaveJSProperty('hidden', false);
    expect(await tuner.locator('[data-tuner-needle]').evaluate((el) => parseFloat(el.style.left))).toBe(100);
    await expectReferences(25);
    await tuner.locator('[data-tuner-fixed-note]').selectOption('');
    await expect(tuner.locator('[data-tuner-judgment]')).toContainText('合っています');
    await page.locator('#systemPanel .toolbar').getByRole('button', { name: '実験室', exact: true }).click();
    await expectReleased(page);
    await page.locator('#system-laboratoryTab').getByRole('button', { name: 'チューナー', exact: true }).click();
    await showTunerTab(page, '測定');
    await expectMeasuringA4(page);
    await expectReferences(25);
    await tuner.locator('[data-tuner-pause]').click(); // references survive silence
    await expect(tuner.locator('[data-tuner-needle]')).toBeHidden();
    await expectReferences(25);
    await showTunerTab(page, '履歴・楽器・設定');
    await tuner.locator('[data-tuner-menu-section="settings"]').click();
    await tuner.locator('[data-tuner-tolerance]').selectOption('10');
    await showTunerTab(page, '測定');
    await expectReferences(25);
    await showTunerTab(page, '履歴・楽器・設定');
    await tuner.locator('[data-tuner-reset-prefs]').click();
    await showTunerTab(page, '測定');
    await expectReferences(50);
  });

  for (const width of [277, 390]) {
    test(`reference stems and labels have distinct borders at ${width} px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await login(page);
      await openTuner(page);
      const tuner = page.locator('#systemTunerHost');
      // R1: a bare minor-reference selector also draws a spurious vertical
      // dotted border at the label's left edge, away from the true reference.
      for (const forcedColors of ['none', 'active']) {
        await page.emulateMedia({ forcedColors });
        for (const [kind, style] of [['major', 'dashed'], ['minor', 'dotted']]) {
          const stem = tuner.locator(`.tuner-meter-reference.tuner-meter-reference-${kind}`);
          const label = tuner.locator(`.tuner-meter-reference-label.tuner-meter-reference-${kind}`);
          await expect(stem).toBeVisible();
          await expect(stem).toHaveCSS('border-left-style', style);
          await expect(stem).toHaveCSS('border-left-width', '2px');
          await expect(stem).toHaveCSS('pointer-events', 'none');
          await expect(label).toBeVisible();
          await expect(label).toHaveCSS('border-left-width', '0px');
          await expect(label).toHaveCSS('border-right-width', '0px');
          await expect(label).toHaveCSS('border-bottom-style', style);
          await expect(label).toHaveCSS('border-bottom-width', '1px');
          await expect(label).toHaveCSS('pointer-events', 'none');
        }
      }
    });
  }

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

  test('direct Hz settings do not play or follow measurement settings', async ({ page }) => {
    await login(page);
    await openTuner(page);
    const tuner = page.locator('#systemTunerHost');
    await showTunerTab(page, '音源');
    await expect(tuner.locator('[data-tuner-playback-just]')).toBeHidden();
    await tuner.getByRole('button', { name: '周波数（Hz）で指定', exact: true }).click();
    await tuner.locator('[data-tuner-playback-hz]').fill('333.3');
    await expect(tuner.locator('[data-tuner-playback-summary]')).toContainText('333.300 Hz');
    expect((await probe(page)).playbackContexts).toHaveLength(0);
    await showTunerTab(page, '測定');
    await tuner.getByLabel('判定する音', { exact: true }).selectOption('62');
    await tuner.locator('[data-tuner-step="1"]').click();
    await showTunerTab(page, '音源');
    await expect(tuner.locator('[data-tuner-playback-summary]')).toContainText('333.300 Hz');
    await expect(tuner.locator('[data-tuner-playback-just]')).toBeHidden();
    expect((await probe(page)).playbackContexts).toHaveLength(0);
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

  test('"測定を一時停止" releases the microphone until the user resumes', async ({ page }) => {
    await login(page);
    await openTuner(page);
    await expectMeasuringA4(page);
    const tuner = page.locator('#systemTunerHost');
    for (const selector of ['[data-tuner-freeze]', '[data-tuner-chip-frozen]', '[data-tuner-detail]', '[data-tuner-detail-panel]']) {
      await expect(tuner.locator(selector)).toHaveCount(0);
    }
    const measurement = tuner.getByRole('tabpanel', { name: '測定', exact: true });
    await expect(measurement).not.toContainText('表示を固定');
    await expect(measurement).not.toContainText('詳細表示');
    expect((await probe(page)).tracks.every((s) => s === 'live')).toBe(true);
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

  test('legacy saved targets become equal and non-equal preset recall stays silent', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('portalTunerSettings', JSON.stringify({ schemaVersion: 1, a4Tenths: 4420, persistSettings: true,
        prefs: { judgment: { temperament: 'just-major', fixedMidi: 60 }, presets: { temperament: [
          ...['minor-third', 'major-third', 'just-major', 'just-minor', 'pythagorean', 'custom'].map((temperament) => ({
            id: temperament, name: `旧音律 ${temperament}`, data: { temperament, fixedMidi: 69 },
          })),
        ] } },
      }));
    });
    await login(page);
    await openTuner(page);
    const tuner = page.locator('#systemTunerHost');
    await expect(tuner.locator('[data-tuner-fixed-note]')).toHaveValue('60');
    await expect(tuner.locator('[data-tuner-cents]')).toHaveText(/\+(891|892|893) cent/);
    await showTunerTab(page, '音源');
    await expect(tuner.locator('[data-tuner-set-root]')).toBeHidden();
    await expect(tuner.locator('[data-tuner-set-target]')).toBeHidden();
    await showTunerTab(page, '履歴・楽器・設定');
    await tuner.locator('[data-tuner-menu-section="settings"]').click();
    const before = await page.evaluate(() => localStorage.getItem('portalTunerSettings'));
    await page.evaluate(() => {
      const el = document.querySelector('[data-tuner-announcer]');
      window.__presetAnnouncements = [];
      new MutationObserver(() => window.__presetAnnouncements.push(el.textContent)).observe(el, { subtree: true, childList: true, characterData: true });
    });
    for (const temperament of ['minor-third', 'major-third', 'just-major', 'just-minor', 'pythagorean', 'custom']) {
      await tuner.locator(`[data-tuner-temperament-preset-use="${temperament}"]`).click();
      await expect(tuner.locator('[data-tuner-temperament-presets]')).toContainText(`旧音律 ${temperament}`);
    }
    expect(await page.evaluate(() => localStorage.getItem('portalTunerSettings'))).toBe(before);
    expect(await page.evaluate(() => window.__presetAnnouncements.some((text) => text.includes('呼び出しました')))).toBe(false);
    expect((await probe(page)).playbackContexts).toHaveLength(0);
    await showTunerTab(page, '測定');
    await expect(tuner.locator('[data-tuner-fixed-note]')).toHaveValue('60');
    await tuner.locator('[data-tuner-pause]').click();
    await tuner.locator('[data-tuner-pause]').click();
    await expect(tuner.locator('[data-tuner-fixed-note]')).toHaveValue('60');
    await expect(tuner.locator('[data-tuner-cents]')).toHaveText(/\+(891|892|893) cent/);
    await showTunerTab(page, '音源');
    await expect(tuner.locator('[data-tuner-set-root]')).toHaveCount(1);
    await expect(tuner.locator('[data-tuner-set-target]')).toHaveCount(1);
    await expect(tuner.locator('[data-tuner-playback-just]')).toBeHidden();
    await page.locator('#systemPanel .toolbar').getByRole('button', { name: '実験室', exact: true }).click();
    await expectReleased(page);
    await page.locator('#system-laboratoryTab').getByRole('button', { name: 'チューナー', exact: true }).click();
    await showTunerTab(page, '測定');
    await expect(tuner.locator('[data-tuner-fixed-note]')).toHaveValue('60');
    await expect(tuner.locator('[data-tuner-note]')).toHaveText('A4', { timeout: 15000 });
    await expect(tuner.locator('[data-tuner-cents]')).toHaveText(/\+(891|892|893) cent/);
    await showTunerTab(page, '音源');
    for (const attr of ['set-root', 'set-target']) {
      await expect(tuner.locator(`[data-tuner-${attr}]`)).toHaveCount(1);
      await expect(tuner.locator(`[data-tuner-${attr}]`)).toBeHidden();
    }
  });

  test('temperament and sound presets: save, recall without playing, delete', async ({ page }) => {
    await login(page);
    await openTuner(page);
    await expectMeasuringA4(page);
    const tuner = page.locator('#systemTunerHost');
    const fixed = tuner.getByLabel('判定する音', { exact: true });
    await fixed.selectOption('60');
    await showTunerTab(page, '履歴・楽器・設定');
    await tuner.locator('[data-tuner-menu-section="settings"]').click();
    await tuner.locator('[data-tuner-temperament-preset-name]').fill('平均律C4');
    await tuner.locator('[data-tuner-temperament-preset-save]').click();
    await expect(tuner.locator('[data-tuner-temperament-presets]')).toContainText('平均律C4');
    await showTunerTab(page, '測定');
    await fixed.selectOption('69');
    await showTunerTab(page, '履歴・楽器・設定');
    await tuner.locator('[data-tuner-temperament-presets]').getByRole('button', { name: '呼び出す' }).click();
    await expect(tuner.locator('[data-tuner-announcer]')).toHaveText('音律「平均律C4」を呼び出しました');
    await showTunerTab(page, '測定');
    await expect(fixed).toHaveValue('60');
    expect((await probe(page)).playbackContexts).toHaveLength(0); // equal preset recall alone never plays
    await showTunerTab(page, '履歴・楽器・設定');
    await tuner.locator('[data-tuner-temperament-preset-delete]').click();
    await expect(tuner.locator('[data-tuner-temperament-preset-use]')).toHaveCount(0);
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
