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
      barOverflowX: getComputedStyle(bar).overflowX, barFlexShrink: getComputedStyle(bar).flexShrink,
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
      expect(sample.barFlexShrink, detail).toBe('0');
      // The existing 44px touch targets must not collapse in the flex scroller.
      expect(sample.bar.height, detail).toBeGreaterThanOrEqual(44);
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
    // A scrollable flex item can collapse while its 44px buttons overflow it.
    // Keep the whole existing touch target inside the bar's vertical clip.
    expect(sample.button.height, detail).toBeGreaterThanOrEqual(44);
    expect(sample.bar.top, detail).toBeLessThanOrEqual(sample.button.top + 1);
    expect(sample.bar.bottom, detail).toBeGreaterThanOrEqual(sample.button.bottom - 1);
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


// Metronome in the laboratory (MT-10 / MT-18 / MT-19 / MT-20 in a headless
// browser). Audible accuracy, iOS, Bluetooth and real instruments are device
// checks (MD-01..19) and are not claimed here.

// The full Chromium build: the headless shell has no fake microphone.
test.use({
  channel: 'chromium',
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] },
});

async function instrument(page) {
  await page.addInitScript(() => {
    const record = { contexts: [], gum: 0, streams: [] };
    window.__metronomeProbe = record;
    const Original = window.AudioContext;
    window.AudioContext = class extends Original {
      constructor(...args) {
        super(...args);
        record.contexts.push(this);
      }
    };
    if (navigator.mediaDevices) {
      const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (c) => {
        record.gum += 1;
        const s = await gum(c);
        record.streams.push(s);
        return s;
      };
    }
  });
}

async function probe(page) {
  return page.evaluate(() => {
    const r = window.__metronomeProbe;
    return {
      gum: r.gum,
      contexts: r.contexts.map((c) => c.state),
      tracks: r.streams.flatMap((s) => s.getTracks().map((t) => t.readyState)),
    };
  });
}

async function login(page) {
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

async function openMetronome(page) {
  await openLaboratory(page);
  await page.locator('#system-laboratoryTab').getByRole('button', { name: 'メトロノーム', exact: true }).click();
  await expect(page.locator('#system-metronomeTab')).toBeVisible();
  await expect(page.locator('#systemMetronomeHost [data-metronome-root]')).toBeVisible();
}

const host = (page) => page.locator('#systemMetronomeHost');

async function showTab(page, name) {
  const tab = host(page).getByRole('tab', { name, exact: true });
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}

test.describe('metronome for system administrators', () => {
  test.beforeEach(async ({ page, context }) => {
    await context.grantPermissions(['microphone']);
    await instrument(page);
    await installPortalApiMocks(page, { permission: 'システム管理者' });
  });

  test('opens without audio or microphone; play starts the click and stop / leaving releases it', async ({ page }) => {
    const requests = [];
    page.on('request', (r) => { if (r.url().includes('/static/js/modules/metronome/') || r.url().includes('/static/js/modules/audio/')) requests.push(r.url()); });
    await login(page);
    expect(requests).toHaveLength(0); // nothing metronome-related in the initial page load
    await openMetronome(page);
    // Entering the screen creates no AudioContext and never asks for the microphone.
    expect(await probe(page)).toMatchObject({ gum: 0, contexts: [] });
    await expect(host(page).locator('[data-metronome-chip-input]')).toHaveText('マイク：使っていません');
    // One release query for every metronome asset; the shared audio uses its own id.
    const metronomeRevs = new Set(requests.filter((u) => u.includes('/metronome/')).map((u) => new URL(u).searchParams.get('rev')));
    const audioRevs = new Set(requests.filter((u) => u.includes('/audio/')).map((u) => new URL(u).searchParams.get('rev')));
    expect(metronomeRevs.size).toBe(1);
    expect([...metronomeRevs][0]).toMatch(/^m-[0-9a-f]{12}$/);
    expect([...audioRevs][0]).toMatch(/^a-[0-9a-f]{12}$/);
    expect(requests.some((u) => u.includes('view_analysis') || u.includes('onset_adapter') || u.includes('storage_local'))).toBe(false);

    const play = host(page).locator('[data-metronome-play]');
    await play.click();
    await expect(host(page).locator('[data-metronome-chip-state]')).toHaveText(/再生中|カウント/);
    await expect.poll(async () => (await probe(page)).contexts).toEqual(['running']);
    await expect(host(page).locator('[data-metronome-position]')).toContainText('小節', { timeout: 5000 });
    expect((await probe(page)).gum).toBe(0); // the click never needs the microphone
    await play.click(); // stop
    await expect(host(page).locator('[data-metronome-chip-state]')).toHaveText('停止中');

    await play.click();
    await expect.poll(async () => (await probe(page)).contexts.at(-1)).toBe('running');
    const metronomeContexts = (await probe(page)).contexts.length;
    // Leaving the screen (laboratory list, then the tuner) closes the
    // metronome output at once; the tuner's own contexts are not counted.
    await openLaboratory(page);
    await expect.poll(async () => (await probe(page)).contexts.slice(0, metronomeContexts).every((s) => s === 'closed')).toBe(true);
    await page.locator('#system-laboratoryTab').getByRole('button', { name: 'チューナー', exact: true }).click();
    await expect(page.locator('#system-tunerTab')).toBeVisible();
    expect((await probe(page)).contexts.slice(0, metronomeContexts).every((s) => s === 'closed')).toBe(true);
  });

  test('lazy screens load and edit: layers, meter sequence, practice, score and analysis', async ({ page }) => {
    await login(page);
    await openMetronome(page);
    await showTab(page, '高度なリズム');
    await expect(host(page).locator('[data-metronome-density]')).toContainText('音の数');
    await host(page).locator('[data-metronome-add-layer]').click();
    await expect(host(page).locator('[data-metronome-layer]')).toHaveCount(1);
    await expect(host(page).locator('[data-metronome-poly-mode]')).toHaveAttribute('data-metronome-poly-mode', /grid|per-layer/);
    await host(page).locator('[data-metronome-meter-sequence]').fill('3/4, 2/4');
    await host(page).locator('[data-metronome-meter-sequence-apply]').click();
    await expect(host(page).getByText('2 小節の拍子を順に繰り返します')).toBeVisible();

    await showTab(page, '楽曲');
    await expect(host(page).locator('[data-metronome-bar-runs]')).toContainText('3/4');
    await host(page).locator('[data-metronome-score-meter]').fill('4/4');
    await host(page).locator('[data-metronome-score-count]').fill('4');
    await host(page).locator('[data-metronome-add-bars]').click();
    // Bars cannot follow an endless repeat (it must end at the last bar).
    await expect(host(page).locator('[data-metronome-score-status]')).toContainText('その後ろには小節を追加できません');
    await expect(host(page).locator('[data-metronome-score-events]')).toContainText('止めるまで');
    await host(page).locator('[data-metronome-score-events]').getByRole('button', { name: '削除' }).click();
    await host(page).locator('[data-metronome-add-bars]').click();
    await expect(host(page).locator('[data-metronome-score-status]')).toContainText('4 小節を追加しました');
    await expect(host(page).locator('[data-metronome-bar-runs]')).toContainText('3～6小節：4/4');

    await showTab(page, '練習');
    await expect(host(page).locator('[data-metronome-history-mode]')).toHaveValue('none'); // history is off by default
    await expect(host(page).locator('[data-metronome-chip-save]')).toHaveText('記録：保存しない');
    await host(page).locator('[data-metronome-add-step]').click();
    await expect(host(page).locator('[data-metronome-steps]')).toContainText('1. 演奏');

    await showTab(page, '演奏解析');
    await expect(host(page).locator('[data-metronome-mic]')).toBeVisible();
    await expect(host(page).getByText('この画面を読み込めませんでした')).toHaveCount(0);
    expect((await probe(page)).gum).toBe(0); // showing the analysis screen opens no microphone
    // No history database before the user chose to keep history.
    const dbs = await page.evaluate(async () => (indexedDB.databases ? (await indexedDB.databases()).map((d) => d.name) : []));
    expect(dbs).not.toContain('portalMetronomeHistory');
  });

  test('the microphone opens only by an explicit tap and stopping it keeps the click', async ({ page }) => {
    await login(page);
    await openMetronome(page);
    await host(page).locator('[data-metronome-play]').click();
    await expect.poll(async () => (await probe(page)).contexts).toEqual(['running']);
    await showTab(page, '演奏解析');
    await host(page).locator('[data-metronome-mic]').click();
    await expect(host(page).locator('[data-metronome-chip-input]')).toContainText('使用中', { timeout: 10000 });
    let state = await probe(page);
    expect(state.gum).toBe(1);
    expect(state.contexts).toHaveLength(2); // its own input context, separate from the output
    await host(page).getByRole('button', { name: 'マイクを止める', exact: true }).click();
    await expect.poll(async () => (await probe(page)).tracks.every((t) => t === 'ended')).toBe(true);
    state = await probe(page);
    expect(state.contexts[0]).toBe('running'); // the click keeps playing
    await expect(host(page).locator('[data-metronome-chip-state]')).toHaveText(/再生中/);
  });

  test('phone width: no horizontal scroll and large touch targets for play / stop', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 740 });
    await login(page);
    await openMetronome(page);
    for (const name of ['基本', '拍子・リズム', '高度なリズム', '練習', '楽曲', '演奏解析', '設定']) {
      await showTab(page, name);
      const overflow = await page.evaluate(() => {
        const root = document.querySelector('#systemMetronomeHost [data-metronome-root]');
        return root.scrollWidth - root.clientWidth;
      });
      expect(overflow, name).toBeLessThanOrEqual(1);
    }
    const box = await host(page).locator('[data-metronome-play]').boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(44);
    const tabBox = await host(page).getByRole('tab', { name: '基本', exact: true }).boundingBox();
    expect(tabBox.height).toBeGreaterThanOrEqual(44);
  });
});

for (const width of [390, 1280]) {
  test(`analysis tuner ${width}px: bottom tabs, maximization, close and reopen`, async ({ page, context }, testInfo) => {
    test.setTimeout(240000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: 844 });
    await context.grantPermissions(['microphone']);
    await page.addInitScript(() => {
      Object.defineProperty(Element.prototype, 'requestFullscreen', { configurable: true, value: undefined });
    });
    await instrument(page);
    await installPortalApiMocks(page, { permission: 'システム管理者' });
    await login(page);
    await openMetronome(page);
    await showTab(page, '演奏解析');
    const root = host(page).locator('[data-tuner-root]');
    for (let opening = 0; opening < 2; opening += 1) {
      await host(page).getByRole('button', { name: 'チューナーを表示する', exact: true }).click();
      const start = host(page).getByRole('button', { name: 'チューナーで測定を始める', exact: true });
      await start.click();
      // The first tap may load the launcher. Follow the production retry prompt.
      await page.waitForFunction(() => Boolean(window.PortalTunerLauncher));
      // Wait for either a mounted view or the real retry state; avoid racing enter().
      await expect.poll(async () => (await root.count()) > 0 ||
        ((await start.isVisible()) && (await start.isEnabled()))).toBe(true);
      if (await start.isVisible() && await start.isEnabled()) {
        await expect(host(page)).toContainText('チューナーを準備しています。もう一度押してください。');
        await start.click();
      }
      await expect(root).toHaveCount(1);
      await expect(root.locator('[data-tuner-tabbar]')).toHaveCount(1);
      await expect(root.locator('[data-tuner-chip-mic]')).toContainText('使用中');
      await checkStickyTuner(page, root, testInfo, `${width}-${opening}-normal`);
      await root.locator('[data-tuner-maximize]').click();
      await expect(root).toHaveClass(/tuner-maximized/);
      await checkStickyTuner(page, root, testInfo, `${width}-${opening}-maximized`);
      await root.locator('[data-tuner-maximize]').click();
      await expect(root).not.toHaveClass(/tuner-maximized/);
      await checkStickyTuner(page, root, testInfo, `${width}-${opening}-restored`);
      await host(page).getByRole('button', { name: 'チューナーを閉じる', exact: true }).click();
      await expect(root).toHaveCount(0);
      await expect.poll(async () => (await probe(page)).tracks.every((state) => state === 'ended')).toBe(true);
      await expect.poll(async () => (await probe(page)).contexts.every((state) => state === 'closed')).toBe(true);
    }
    expect(errors).toEqual([]);
  });
}

test('members without the system administrator permission do not get the metronome', async ({ page }) => {
  await installPortalApiMocks(page, { permission: '団員' });
  await login(page);
  await expect(page.locator('#memberPanel')).toBeVisible();
  expect(await page.evaluate(() => typeof window.PortalMetronomeLauncher)).toBe('undefined');
  await expect(page.locator('[data-tab="system-metronome"]')).toHaveCount(0);
});
