const { test, expect } = require('@playwright/test');
const { installPortalApiMocks } = require('./fixtures/mockApi');

// Real-browser two-tab checks in headless Chromium (MT-13 / MT-19, part of
// MD-17 / MD-19). Chromium only: Safari / iOS and audible double sound on
// devices are still open. Two pages of one browser context are two tabs of
// the same origin (shared Web Locks and IndexedDB).
test.use({ channel: 'chromium', launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] } });

async function login(page) {
  await page.goto('/');
  // The second tab shares the session of the first one (same origin storage).
  const form = page.locator('#portalNameInput');
  await page.waitForFunction(() => {
    const shown = (el) => el && el.offsetParent !== null;
    return shown(document.querySelector('#portalNameInput')) || shown(document.querySelector('#memberPanel'));
  });
  if (!(await form.isVisible())) return;
  await page.fill('#portalNameInput', '団員テスト');
  await page.selectOption('#portalPartInput', { label: 'Violin' });
  await page.fill('#portalPasswordInput', 'dummy-pass');
  await page.click('#portalLoginBtn');
  await expect(page.locator('#memberPanel')).toBeVisible();
}

async function openMetronome(page) {
  await page.click('#portalDrawerToggle');
  await page.locator('#portalDrawerMenu').getByRole('button', { name: 'システム管理', exact: true }).click();
  await page.locator('#systemPanel .toolbar').getByRole('button', { name: '実験室', exact: true }).click();
  await page.locator('#system-laboratoryTab').getByRole('button', { name: 'メトロノーム', exact: true }).click();
  await expect(page.locator('#systemMetronomeHost [data-metronome-root]')).toBeVisible();
}

const chip = (page) => page.locator('#systemMetronomeHost [data-metronome-chip-state]');
const playBtn = (page) => page.locator('#systemMetronomeHost [data-metronome-play]');

test('Web Locks: a second tab is told "busy" while the first plays; after the first leaves it can play', async ({ context }) => {
  const a = await context.newPage();
  const b = await context.newPage();
  for (const p of [a, b]) await installPortalApiMocks(p, { permission: 'システム管理者' });
  await login(a);
  await openMetronome(a);
  await playBtn(a).click();
  await expect(chip(a)).toHaveText(/再生中/);
  await login(b);
  await openMetronome(b);
  await playBtn(b).click();
  await expect(chip(b)).toHaveText('別のタブで使用中');
  await expect(b.locator('#systemMetronomeHost [data-metronome-message]')).toContainText('別のタブ');
  // Tab A stops and leaves the screen: the lock is given back.
  await playBtn(a).click();
  await a.locator('#systemPanel .toolbar').getByRole('button', { name: '実験室', exact: true }).click();
  await expect.poll(async () => b.evaluate(async () => (await navigator.locks.query()).held.length), { timeout: 5000 }).toBe(0);
  await playBtn(b).click();
  await expect(chip(b)).toHaveText(/再生中/);
});

async function idbTabs(context) {
  const a = await context.newPage();
  const b = await context.newPage();
  // Both tabs without Web Locks (the fallback path); tab B's clock runs 20 s
  // ahead so that a frozen tab A looks stale to B without waiting 15 s.
  for (const [p, offset] of [[a, 0], [b, 20000]]) {
    await p.addInitScript((off) => {
      Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true });
      const real = Date.now.bind(Date);
      Date.now = () => real() + off;
    }, offset);
    await installPortalApiMocks(p, { permission: 'システム管理者' });
  }
  return { a, b };
}

test('IndexedDB claim: a live old tab is never taken over (its heartbeat changes what was confirmed)', async ({ context }) => {
  test.setTimeout(60000);
  const { a, b } = await idbTabs(context);
  await login(a);
  await openMetronome(a);
  await playBtn(a).click();
  await expect(chip(a)).toHaveText(/再生中/);
  await login(b);
  await openMetronome(b);
  const takeover = b.locator('#systemMetronomeHost [data-metronome-takeover]');
  await expect(takeover).toBeVisible({ timeout: 10000 });
  // Tab A is alive: wait until it has beaten again, then confirm in B.
  await a.waitForTimeout(2600);
  b.on('dialog', (d) => d.accept());
  await takeover.click();
  await expect(b.locator('#systemMetronomeHost [data-metronome-message]')).toContainText('引き継ぎませんでした', { timeout: 15000 });
  await expect(chip(a)).toHaveText(/再生中/); // the old tab keeps its claim and sound
});

test('IndexedDB claim: a hung old tab is taken over only after its verified permit expired; when it comes back it stops and cannot play', async ({ context }) => {
  test.setTimeout(60000);
  const { a, b } = await idbTabs(context);
  await login(a);
  await openMetronome(a);
  await playBtn(a).click();
  await expect(chip(a)).toHaveText(/再生中/);
  // Tab A hangs: its main thread is blocked for 6 s (no heartbeat, no permit
  // renewal), while its audio thread keeps running until the worklet's
  // wall-clock permit expires. (Chromium does not freeze a page that plays
  // audio, so a blocked main thread stands in for a frozen tab.)
  const hang = a.evaluate(() => { const end = Date.now() + 6000; while (Date.now() < end) { /* hung tab */ } });
  await b.waitForTimeout(300);
  await login(b);
  await openMetronome(b);
  const takeover = b.locator('#systemMetronomeHost [data-metronome-takeover]');
  await expect(takeover).toBeVisible({ timeout: 10000 });
  // Playing is refused until the takeover is confirmed.
  await playBtn(b).click();
  await expect(chip(b)).not.toHaveText(/再生中/);
  b.on('dialog', (d) => d.accept());
  await takeover.click();
  await expect(b.locator('#systemMetronomeHost [data-metronome-message]')).toContainText('もう一度「再生」', { timeout: 15000 });
  await playBtn(b).click();
  await expect(chip(b)).toHaveText(/再生中/);
  // Tab A comes back: its heartbeat finds the claim gone, it stops and acknowledges.
  await hang;
  await expect(chip(a)).toHaveText('中断しました', { timeout: 15000 });
  // It cannot start again by itself while B owns the output.
  await playBtn(a).click();
  await expect(chip(a)).not.toHaveText(/再生中/);
  await expect(chip(b)).toHaveText(/再生中/);
});

test('H-010: a full deletion in another tab wins over a delayed save of an older attempt (real IndexedDB)', async ({ context }) => {
  const a = await context.newPage();
  const b = await context.newPage();
  for (const p of [a, b]) {
    await p.goto('/');
    await p.addScriptTag({ url: '/static/js/modules/metronome/storage_local.js' });
  }
  const identity = { ownerId: 'owner-e2e', serverHistoryEpoch: 1, consentRevision: 1 };
  const session = (id) => ({ sessionId: id, attemptId: 'att-' + id, kind: 'practice', status: 'complete', startedAt: new Date().toISOString(), activeDurationMs: 1000, durationMs: 1000, counts: { target: 0, valid: 0, localDetail: 0, extraDetail: 0, extraTotal: 0, groups: 0 }, summary: {} });
  await a.evaluate(async ({ identity, s1 }) => {
    window.__h = window.PortalMetronomeLib.storageLocal.createLocalHistory({ indexedDB, IDBKeyRange, now: () => Date.now() });
    window.__token = await window.__h.beginAttempt(identity, await window.__h.ticket());
    await window.__h.saveSession(window.__token, s1);
  }, { identity, s1: session('before') });
  // Tab B deletes everything (its own connection).
  const del = await b.evaluate(async (ownerId) => {
    const h = window.PortalMetronomeLib.storageLocal.createLocalHistory({ indexedDB, IDBKeyRange, now: () => Date.now() });
    return h.deleteAll(ownerId);
  }, identity.ownerId);
  expect(del.ok).toBe(true);
  // Tab A's delayed save with the token fixed before the deletion is refused.
  const late = await a.evaluate(async (s2) => window.__h.saveSession(window.__token, s2), session('after'));
  expect(late).toEqual({ ok: false, code: 'STALE_LOCAL_GENERATION' });
  const left = await a.evaluate(async (ownerId) => (await window.__h.list(ownerId)).length, identity.ownerId);
  expect(left).toBe(0); // nothing deleted came back
  // A new attempt in tab A (after the deletion) is stored normally.
  const fresh = await a.evaluate(async ({ identity, s3 }) => {
    const t = await window.__h.beginAttempt(identity, await window.__h.ticket());
    return window.__h.saveSession(t, s3);
  }, { identity, s3: session('new') });
  expect(fresh.ok).toBe(true);
});

test('IC-14 rev.: an attempt started before another tab deleted is refused by the IndexedDB order, not by the clock (real IndexedDB)', async ({ context }) => {
  const a = await context.newPage();
  const b = await context.newPage();
  for (const p of [a, b]) {
    await p.goto('/');
    await p.addScriptTag({ url: '/static/js/modules/metronome/storage_local.js' });
  }
  const identity = { ownerId: 'owner-ticket', serverHistoryEpoch: 1, consentRevision: 1 };
  // Tab A has the database open and starts an attempt (ticket taken at once).
  await a.evaluate(async (identity) => {
    window.__h = window.PortalMetronomeLib.storageLocal.createLocalHistory({ indexedDB, IDBKeyRange, now: () => 0 });
    await window.__h.beginAttempt(identity);
    window.__ticket = window.__h.ticket();
  }, identity);
  // Tab B deletes everything; its clock is the same millisecond (now: 0).
  const del = await b.evaluate(async (ownerId) => {
    const h = window.PortalMetronomeLib.storageLocal.createLocalHistory({ indexedDB, IDBKeyRange, now: () => 0 });
    return h.deleteAll(ownerId);
  }, identity.ownerId);
  expect(del.ok).toBe(true);
  const late = await a.evaluate(async (identity) => {
    const t = await window.__ticket;
    try {
      await window.__h.beginAttempt(identity, t);
      return { accepted: true, ordered: t.ordered };
    } catch (e) {
      return { accepted: false, code: e.code, ordered: t.ordered };
    }
  }, identity);
  expect(late).toEqual({ accepted: false, code: 'STALE_LOCAL_GENERATION', ordered: true });
  // A new attempt after the deletion (clock unchanged, even set back) is accepted.
  const fresh = await a.evaluate(async (identity) => {
    const t = await window.__h.ticket();
    const token = await window.__h.beginAttempt(identity, t);
    return token.localDeleteGeneration;
  }, identity);
  expect(fresh).toBe(2);
});
