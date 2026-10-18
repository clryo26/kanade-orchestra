const { test, expect } = require('@playwright/test');
const { installPortalApiMocks } = require('./fixtures/mockApi');

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

test('members without the system administrator permission do not get the metronome', async ({ page }) => {
  await installPortalApiMocks(page, { permission: '団員' });
  await login(page);
  await expect(page.locator('#memberPanel')).toBeVisible();
  expect(await page.evaluate(() => typeof window.PortalMetronomeLauncher)).toBe('undefined');
  await expect(page.locator('[data-tab="system-metronome"]')).toHaveCount(0);
});
