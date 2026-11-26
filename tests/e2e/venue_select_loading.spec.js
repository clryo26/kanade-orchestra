const { test, expect } = require('@playwright/test');
const { installPortalApiMocks } = require('./fixtures/mockApi');
const { BOOTSTRAP_DATA } = require('./fixtures/mockData');

// Registered venues are returned only by the venue API, never by bootstrap,
// so these tests exercise the registration tabs' own venue load path.
const VENUES = [
  { id: 11, name: '市民ホール', for_performance: true, for_practice: false },
  { id: 12, name: '市民センター', for_performance: false, for_practice: true },
  { id: 13, name: '公民館' }, // legacy row without usage flags: both forms
];

const PERFORMANCE = {
  id: 1,
  title: '第1回定期演奏会',
  date: '2099-08-20',
  open_time: '17:30',
  start_time: '18:00',
  venue: '市民ホール',
  conductor: '山田',
  pieces: [{ title: '交響曲第5番', composer: 'ベートーヴェン', alias: 'ベト5', duration: '35' }],
};

// A future date keeps the row in the default "future" schedule list.
const SCHEDULE = {
  id: 1,
  date: '2099-07-15',
  time: '13:00-16:30',
  start_time: '13:00',
  end_time: '16:30',
  venue: '市民センター',
  performance_id: 1,
  performance_title: '第1回定期演奏会',
  pieces: 'ベト5',
  notes: '合奏',
};

const BOOTSTRAP_PATHS = new Set(['/api/bootstrap', '/api/bootstrap-lite', '/api/bootstrap-core']);

async function installVenueScenario(page, { schedules = [SCHEDULE], holdVenue = false } = {}) {
  await installPortalApiMocks(page, { permission: '管理者' });

  const bootstrap = JSON.parse(JSON.stringify(BOOTSTRAP_DATA));
  delete bootstrap.extras.venue_settings;
  bootstrap.performances = [PERFORMANCE];
  bootstrap.schedules = schedules;
  // Registered after the shared mock, so these handlers take precedence.
  await page.route((url) => BOOTSTRAP_PATHS.has(url.pathname), (route) => route.fulfill({ json: bootstrap }));
  await page.route((url) => url.pathname === '/api/schedules', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({ json: schedules });
  });

  const venueApi = { requests: 0 };
  let releaseVenue;
  const venueReleased = new Promise((resolve) => { releaseVenue = resolve; });
  let markRequested;
  venueApi.requested = new Promise((resolve) => { markRequested = resolve; });
  venueApi.release = () => releaseVenue();
  await page.route((url) => url.pathname === '/api/extra/venue_settings', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    venueApi.requests += 1;
    markRequested();
    if (holdVenue) await venueReleased;
    return route.fulfill({ json: VENUES });
  });
  return venueApi;
}

async function openAdminPanel(page) {
  await page.goto('/');
  await page.fill('#portalNameInput', 'administrator');
  await page.fill('#portalPasswordInput', 'dummy-pass');
  await page.click('#portalLoginBtn');
  await expect(page.locator('#memberPanel')).toBeVisible();
  await page.click('#portalDrawerToggle');
  await page.locator('#portalDrawerMenu').getByRole('button', { name: '管理者メニュー' }).click();
  await expect(page.locator('#adminPanel')).toBeVisible();
}

const optionValues = (page, selector) => page.locator(`${selector} option`).evaluateAll(
  (options) => options.map((option) => option.value)
);

test.describe('Venue dropdowns on the registration forms', () => {
  test('registered venues appear without opening venue management and are loaded once', async ({ page }) => {
    const venueApi = await installVenueScenario(page);
    await openAdminPanel(page);

    // The admin panel opens on the performance form.
    await expect(page.locator('#performanceTab')).toBeVisible();
    await expect.poll(() => optionValues(page, '#perfVenue')).toEqual(expect.arrayContaining(['', '市民ホール', '公民館']));
    expect(await optionValues(page, '#perfVenue')).not.toContain('市民センター');
    await expect(page.locator('#perfVenue option').first()).toHaveText('選択してください');
    await page.selectOption('#perfVenue', '市民ホール');
    await expect(page.locator('#perfVenue')).toHaveValue('市民ホール');

    await page.locator('#adminPanel [data-tab="schedule"]').click();
    await expect(page.locator('#scheduleTab')).toBeVisible();
    await expect.poll(() => optionValues(page, '#schedVenue')).toEqual(expect.arrayContaining(['', '市民センター', '公民館']));
    expect(await optionValues(page, '#schedVenue')).not.toContain('市民ホール');
    await page.selectOption('#schedVenue', '市民センター');
    await expect(page.locator('#schedVenue')).toHaveValue('市民センター');

    // Revisiting and moving between the two forms does not refetch.
    for (const tabName of ['performance', 'schedule', 'performance']) {
      await page.locator(`#adminPanel [data-tab="${tabName}"]`).click();
      await expect(page.locator(`#${tabName}Tab`)).toBeVisible();
    }
    await expect(page.locator('#perfVenue option[value="公民館"]')).toHaveCount(1);
    expect(venueApi.requests).toBe(1);
  });

  test('performance edit opened before the venue load keeps the selection and inputs', async ({ page }) => {
    const venueApi = await installVenueScenario(page, { holdVenue: true });
    try {
      await openAdminPanel(page);
      await venueApi.requested;

      await page.locator('#perfListItems button', { hasText: PERFORMANCE.title }).click();
      await expect(page.locator('#perfVenue')).toHaveValue('市民ホール');
      await expect(page.locator('#perfVenue option:checked')).toHaveText('市民ホール（未登録会場）');

      await page.fill('#perfTitle', '第1回定期演奏会（改）');
      await page.fill('#perfDate', '2099-09-01');
      await page.fill('#perfOpenTime', '17:00');
      await page.fill('#perfStartTime', '17:45');
      await page.fill('#perfConductor', '佐藤');
    } finally {
      venueApi.release();
    }

    await expect(page.locator('#perfVenue option:checked')).toHaveText('市民ホール');
    await expect(page.locator('#perfVenue')).toHaveValue('市民ホール');
    await expect(page.locator('#perfVenue option', { hasText: '（未登録会場）' })).toHaveCount(0);
    await expect(page.locator('#perfVenue option[value="公民館"]')).toHaveCount(1);
    await expect(page.locator('#perfTitle')).toHaveValue('第1回定期演奏会（改）');
    await expect(page.locator('#perfDate')).toHaveValue('2099-09-01');
    await expect(page.locator('#perfOpenTime')).toHaveValue('17:00');
    await expect(page.locator('#perfStartTime')).toHaveValue('17:45');
    await expect(page.locator('#perfConductor')).toHaveValue('佐藤');
    expect(venueApi.requests).toBe(1);
  });

  test('schedule edit opened before the venue load keeps the selection and inputs', async ({ page }) => {
    const venueApi = await installVenueScenario(page, { holdVenue: true });
    try {
      await openAdminPanel(page);
      await venueApi.requested;

      await page.locator('#adminPanel [data-tab="schedule"]').click();
      await expect(page.locator('#scheduleTab')).toBeVisible();
      await page.locator('#schedListItems tr.clickable-row', { hasText: SCHEDULE.notes }).click();
      await expect(page.locator('#schedVenue')).toHaveValue('市民センター');
      await expect(page.locator('#schedVenue option:checked')).toHaveText('市民センター（未登録会場）');

      await page.fill('#schedDate', '2099-07-22');
      await page.fill('#schedStartTime', '09:30');
      await page.fill('#schedEndTime', '12:00');
      await page.fill('#schedNotes', '分奏あり');
    } finally {
      venueApi.release();
    }

    await expect(page.locator('#schedVenue option:checked')).toHaveText('市民センター');
    await expect(page.locator('#schedVenue')).toHaveValue('市民センター');
    await expect(page.locator('#schedVenue option', { hasText: '（未登録会場）' })).toHaveCount(0);
    await expect(page.locator('#schedVenue option[value="公民館"]')).toHaveCount(1);
    await expect(page.locator('#schedDate')).toHaveValue('2099-07-22');
    await expect(page.locator('#schedStartTime')).toHaveValue('09:30');
    await expect(page.locator('#schedEndTime')).toHaveValue('12:00');
    await expect(page.locator('#schedNotes')).toHaveValue('分奏あり');
    expect(venueApi.requests).toBe(1);
  });

  test('a saved venue without a matching venue for its usage stays an unregistered option', async ({ page }) => {
    // 市民ホール is registered for performances only, so the practice form keeps the supplement.
    const venueApi = await installVenueScenario(page, {
      holdVenue: true,
      schedules: [{ ...SCHEDULE, venue: '市民ホール', notes: '用途違い' }],
    });
    try {
      await openAdminPanel(page);
      await venueApi.requested;
      await page.locator('#adminPanel [data-tab="schedule"]').click();
      await page.locator('#schedListItems tr.clickable-row', { hasText: '用途違い' }).click();
      await expect(page.locator('#schedVenue option:checked')).toHaveText('市民ホール（未登録会場）');
    } finally {
      venueApi.release();
    }

    await expect(page.locator('#schedVenue option[value="市民センター"]')).toHaveCount(1);
    await expect(page.locator('#schedVenue')).toHaveValue('市民ホール');
    await expect(page.locator('#schedVenue option:checked')).toHaveText('市民ホール（未登録会場）');
    await expect(page.locator('#schedNotes')).toHaveValue('用途違い');
  });
});
