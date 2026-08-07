const { test, expect } = require('@playwright/test');
const { installPortalApiMocks } = require('./fixtures/mockApi');
const { attachErrorMonitor } = require('./fixtures/errorMonitor');

async function loginAsMember(page) {
  await page.fill('#portalNameInput', '団員テスト');
  await page.selectOption('#portalPartInput', { label: 'Violin' });
  await page.fill('#portalPasswordInput', 'dummy-pass');
  await page.click('#portalLoginBtn');
}

async function loginAsAdmin(page) {
  await page.fill('#portalNameInput', '管理者テスト');
  await page.selectOption('#portalPartInput', { label: 'Violin' });
  await page.fill('#portalPasswordInput', 'dummy-pass');
  await page.click('#portalLoginBtn');
}

test.describe('UI CSS reliability smoke', () => {
  test('bootstrap and local css are loaded and core layout styles are applied', async ({ page }) => {
    const monitor = attachErrorMonitor(page);
    await installPortalApiMocks(page, { permission: '一般' });
    await page.goto('/');

    const cssState = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('link[rel="stylesheet"]'));
      const hrefs = links.map((link) => String(link.getAttribute('href') || ''));

      const hasBootstrap = hrefs.some((href) => href.includes('bootstrap@5.3.0'));
      const hasAppCss = hrefs.some((href) => href.includes('/css/style.css'));

      const probe = document.createElement('button');
      probe.className = 'btn btn-primary';
      probe.textContent = 'probe';
      document.body.appendChild(probe);
      const btnStyle = getComputedStyle(probe);
      const btnBackgroundColor = btnStyle.backgroundColor;
      const btnBorderRadius = btnStyle.borderRadius;
      probe.remove();

      const bodyStyle = getComputedStyle(document.body);
      const bodyOverflowX = bodyStyle.overflowX;

      return {
        hasBootstrap,
        hasAppCss,
        btnBackgroundColor,
        btnBorderRadius,
        bodyOverflowX,
      };
    });

    expect(cssState.hasBootstrap).toBeTruthy();
    expect(cssState.hasAppCss).toBeTruthy();
    expect(cssState.btnBackgroundColor).not.toBe('rgba(0, 0, 0, 0)');
    expect(cssState.btnBorderRadius).not.toBe('0px');
    expect(['hidden', 'clip', 'visible', 'auto']).toContain(cssState.bodyOverflowX);

    await loginAsMember(page);
    await expect(page.locator('#memberPanel')).toBeVisible();
    await expect(page.locator('#portalDrawerToggle')).toBeVisible();

    monitor.assertNoClientErrors();
  });

  test('mobile recording controls and member intro photos keep stable layout', async ({ page }) => {
    const monitor = attachErrorMonitor(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await installPortalApiMocks(page, {
      permission: '一般',
      bootstrapOverrides: {
        members: [{
          id: 1,
          name: 'Test Member',
          last_name: 'Test',
          first_name: 'Member',
          part: 'Violin',
          permission: 'member',
          password_set: true,
          photo_url: '/static/icons/icon-192.png',
        }],
      },
    });
    await page.goto('/');
    await loginAsMember(page);

    await page.click('#portalDrawerToggle');
    await page.locator('#portalDrawerMenu [data-home-tab="member-recording"]').click();
    await expect(page.locator('#memberRecordingTab')).toBeVisible();
    await expect(page.locator('.recording-continuous-check')).toBeVisible();

    const recordingLayout = await page.evaluate(() => {
      const filter = document.querySelector('.recording-filter-row');
      const continuous = document.querySelector('.recording-continuous-check');
      const checkbox = continuous?.querySelector('.form-check-input');
      const firstGroup = document.querySelector('#songTreeMember .recording-date-group');
      const viewportWidth = document.documentElement.clientWidth;

      const rect = (element) => {
        const box = element.getBoundingClientRect();
        return {
          top: box.top,
          right: box.right,
          bottom: box.bottom,
          left: box.left,
          width: box.width,
          height: box.height,
        };
      };

      const style = (element) => {
        const computed = getComputedStyle(element);
        return {
          paddingLeft: computed.paddingLeft,
          marginLeft: computed.marginLeft,
          float: computed.float,
        };
      };

      return {
        filter: rect(filter),
        continuous: rect(continuous),
        checkbox: rect(checkbox),
        continuousStyle: style(continuous),
        checkboxStyle: style(checkbox),
        firstGroup: rect(firstGroup),
        viewportWidth,
      };
    });

    expect(recordingLayout.continuous.top).toBeGreaterThanOrEqual(recordingLayout.filter.bottom - 1);
    expect(recordingLayout.continuous.bottom).toBeLessThanOrEqual(recordingLayout.firstGroup.top + 1);
    expect(recordingLayout.continuous.left).toBeGreaterThanOrEqual(0);
    expect(recordingLayout.continuous.right).toBeLessThanOrEqual(recordingLayout.viewportWidth);
    expect(recordingLayout.checkbox.left - recordingLayout.continuous.left).toBeGreaterThanOrEqual(10);
    expect(recordingLayout.continuousStyle.paddingLeft).not.toBe('0px');
    expect(recordingLayout.checkboxStyle.marginLeft).toBe('0px');
    expect(recordingLayout.checkboxStyle.float).toBe('none');

    await page.click('#portalDrawerToggle');
    await page.locator('#portalDrawerMenu [data-home-tab="member-intro"]').click();
    await expect(page.locator('#memberIntroTab')).toBeVisible();
    await expect(page.locator('.member-photo')).toBeVisible();

    const photoLayout = await page.locator('.member-photo').first().evaluate((element) => {
      const box = element.getBoundingClientRect();
      return { width: box.width, height: box.height };
    });

    expect(photoLayout.width).toBeGreaterThanOrEqual(220);
    expect(photoLayout.height).toBeGreaterThan(photoLayout.width);
    expect(photoLayout.height / photoLayout.width).toBeLessThanOrEqual(1.3);

    monitor.assertNoClientErrors();
  });

  test('mobile home layout keeps scrollWidth within viewport even with long announcements', async ({ page }) => {
    const monitor = attachErrorMonitor(page);
    await page.setViewportSize({ width: 277, height: 844 });
    await installPortalApiMocks(page, {
      permission: '\u4e00\u822c',
      bootstrapOverrides: {
        announcements: [{
          id: 1,
          date: '2026-08-07',
          title: 'This is a very long announcement title that should stay inside the mobile home card without pushing the page sideways',
          content: 'Short body',
        }],
      },
    });
    await page.goto('/');
    await loginAsMember(page);

    await expect(page.locator('#memberHomeTab')).toBeVisible();
    await expect(page.locator('#memberHomeTab .portal-home')).toBeVisible();

    const homeLayout = await page.evaluate(() => {
      const viewportWidth = document.documentElement.clientWidth;
      const scrollWidth = document.documentElement.scrollWidth;
      const home = document.querySelector('#memberHomeTab .portal-home');
      const section = document.querySelector('#memberHomeTab .portal-home-section');
      const menuGrid = document.querySelector('#memberHomeTab .portal-menu-grid');
      const announcementLine = document.querySelector('#portalHomeAnnouncementList .portal-home-announcement-mobile-line');
      const announcementTitle = document.querySelector('#portalHomeAnnouncementList .portal-announcement-title');

      const rect = (element) => {
        const box = element.getBoundingClientRect();
        return {
          left: box.left,
          right: box.right,
          width: box.width,
        };
      };

      return {
        viewportWidth,
        scrollWidth,
        home: rect(home),
        section: rect(section),
        menuGrid: rect(menuGrid),
        announcementLine: rect(announcementLine),
        announcementTitle: rect(announcementTitle),
      };
    });

    expect(homeLayout.scrollWidth).toBeLessThanOrEqual(homeLayout.viewportWidth);
    expect(homeLayout.home.right).toBeLessThanOrEqual(homeLayout.viewportWidth + 1);
    expect(homeLayout.section.right).toBeLessThanOrEqual(homeLayout.viewportWidth + 1);
    expect(homeLayout.menuGrid.right).toBeLessThanOrEqual(homeLayout.viewportWidth + 1);
    expect(homeLayout.announcementLine.right).toBeLessThanOrEqual(homeLayout.viewportWidth + 1);
    expect(homeLayout.announcementTitle.right).toBeLessThanOrEqual(homeLayout.viewportWidth + 1);

    monitor.assertNoClientErrors();
  });

  test('mobile absence controls keep readable size and viewport width after selecting and editing', async ({ page }) => {
    const monitor = attachErrorMonitor(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await installPortalApiMocks(page, {
      permission: '一般',
      bootstrapOverrides: {
        members: [{
          id: 1,
          name: 'Test Member',
          last_name: 'Test',
          first_name: 'Member',
          part: 'Violin',
          permission: 'member',
          password_set: true,
        }],
        schedules: [{
          id: 101,
          date: '2026-09-01',
          time: '18:30-20:30',
          start_time: '18:30',
          end_time: '20:30',
          venue: 'Very long rehearsal venue name for mobile regression testing',
        }],
        extras: {
          absences: [{
            id: 201,
            name: 'Test Member',
            member_id: 1,
            schedule_id: 101,
            status: 'late',
            planned_time: '19:00',
          }],
        },
      },
    });
    await page.goto('/');
    await loginAsMember(page);

    await page.click('#portalDrawerToggle');
    await page.locator('#portalDrawerMenu [data-home-tab="member-absence"]').click();
    await expect(page.locator('#memberAbsenceTab')).toBeVisible();
    await expect(page.locator('.absence-edit-btn')).toBeVisible();

    const beforeEdit = await page.evaluate(() => {
      const schedule = document.querySelector('#absenceScheduleId');
      const status = document.querySelector('#absenceStatus');
      const time = document.querySelector('#absenceTime');
      const viewportWidth = document.documentElement.clientWidth;
      const scrollWidth = document.documentElement.scrollWidth;
      const scale = window.visualViewport?.scale ?? 1;
      const fontSize = (element) => getComputedStyle(element).fontSize;
      return {
        viewportWidth,
        scrollWidth,
        scale,
        scheduleFontSize: fontSize(schedule),
        statusFontSize: fontSize(status),
        timeFontSize: fontSize(time),
        timeDisabled: time.disabled,
      };
    });

    expect(parseFloat(beforeEdit.scheduleFontSize)).toBeGreaterThanOrEqual(16);
    expect(parseFloat(beforeEdit.statusFontSize)).toBeGreaterThanOrEqual(16);
    expect(parseFloat(beforeEdit.timeFontSize)).toBeGreaterThanOrEqual(16);
    expect(beforeEdit.timeDisabled).toBeTruthy();
    expect(beforeEdit.scrollWidth).toBeLessThanOrEqual(beforeEdit.viewportWidth);
    expect(beforeEdit.scale).toBeCloseTo(1, 2);

    await page.selectOption('#absenceScheduleId', '101');
    await page.locator('.absence-edit-btn').click();

    const afterEdit = await page.evaluate(() => {
      const schedule = document.querySelector('#absenceScheduleId');
      const status = document.querySelector('#absenceStatus');
      const time = document.querySelector('#absenceTime');
      const viewportWidth = document.documentElement.clientWidth;
      const scrollWidth = document.documentElement.scrollWidth;
      const scale = window.visualViewport?.scale ?? 1;
      const row = document.querySelector('.absence-row');
      const rowBox = row.getBoundingClientRect();
      const labelBox = row.querySelector('.absence-row-label').getBoundingClientRect();
      const actionsBox = row.querySelector('.absence-row-actions').getBoundingClientRect();
      const fontSize = (element) => getComputedStyle(element).fontSize;
      return {
        viewportWidth,
        scrollWidth,
        scale,
        scheduleFontSize: fontSize(schedule),
        statusFontSize: fontSize(status),
        timeFontSize: fontSize(time),
        timeDisabled: time.disabled,
        row: {
          left: rowBox.left,
          right: rowBox.right,
          width: rowBox.width,
        },
        label: {
          left: labelBox.left,
          right: labelBox.right,
          width: labelBox.width,
        },
        actions: {
          left: actionsBox.left,
          right: actionsBox.right,
          width: actionsBox.width,
        },
      };
    });

    expect(parseFloat(afterEdit.scheduleFontSize)).toBeGreaterThanOrEqual(16);
    expect(parseFloat(afterEdit.statusFontSize)).toBeGreaterThanOrEqual(16);
    expect(parseFloat(afterEdit.timeFontSize)).toBeGreaterThanOrEqual(16);
    expect(afterEdit.timeDisabled).toBeFalsy();
    expect(afterEdit.scrollWidth).toBeLessThanOrEqual(afterEdit.viewportWidth);
    expect(afterEdit.scale).toBeCloseTo(1, 2);
    expect(afterEdit.label.left).toBeGreaterThanOrEqual(afterEdit.row.left);
    expect(afterEdit.actions.right).toBeLessThanOrEqual(afterEdit.row.right + 1);

    monitor.assertNoClientErrors();
  });

  test('mobile sheet admin small selects keep readable font size after selection', async ({ page }) => {
    const monitor = attachErrorMonitor(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await installPortalApiMocks(page, { permission: '管理者' });
    await page.goto('/');
    await loginAsAdmin(page);

    await page.click('#portalDrawerToggle');
    await page.locator('#portalDrawerMenu [data-home-tab="sheet-admin"]').click();
    await expect(page.locator('#sheetAdminTab')).toBeVisible();
    await expect(page.locator('.sheet-select-checkbox')).toBeVisible();

    await page.locator('.sheet-select-checkbox').first().check();
    await expect(page.locator('#bulkPartSelect')).toBeVisible();

    const sheetAdminLayout = await page.evaluate(() => {
      const select = document.querySelector('#bulkPartSelect');
      const viewportWidth = document.documentElement.clientWidth;
      const scrollWidth = document.documentElement.scrollWidth;
      const scale = window.visualViewport?.scale ?? 1;
      const box = select.getBoundingClientRect();
      return {
        viewportWidth,
        scrollWidth,
        scale,
        fontSize: getComputedStyle(select).fontSize,
        left: box.left,
        right: box.right,
        width: box.width,
      };
    });

    expect(parseFloat(sheetAdminLayout.fontSize)).toBeGreaterThanOrEqual(16);
    expect(sheetAdminLayout.scrollWidth).toBeLessThanOrEqual(sheetAdminLayout.viewportWidth);
    expect(sheetAdminLayout.scale).toBeCloseTo(1, 2);
    expect(sheetAdminLayout.left).toBeGreaterThanOrEqual(0);
    expect(sheetAdminLayout.right).toBeLessThanOrEqual(sheetAdminLayout.viewportWidth);

    monitor.assertNoClientErrors();
  });

  test('mobile performance day assignment inputs keep readable font size after selecting an item', async ({ page }) => {
    const monitor = attachErrorMonitor(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await installPortalApiMocks(page, {
      permission: '管理者',
      bootstrapOverrides: {
        performances: [{
          id: 1,
          title: 'Mobile Performance Day',
          date: '2026-08-20',
        }],
        extras: {
          performance_day_infos: [{
            id: 301,
            performance_id: 1,
            assignments_rows: [
              { role: '受付', members: 'Test Member' },
            ],
          }],
        },
      },
    });
    await page.goto('/');
    await loginAsAdmin(page);

    await page.click('#portalDrawerToggle');
    await page.locator('#portalDrawerMenu [data-home-admin]').click();
    await page.locator('#adminPanel [data-tab="performance-day-admin"]').click();
    await expect(page.locator('#performanceDayAdminTab')).toBeVisible();
    await expect(page.locator('.performance-day-info-select-btn')).toBeVisible();

    await page.locator('.performance-day-info-select-btn').first().click();
    await expect(page.locator('#performanceDayAssignmentRows .performance-day-assignment-role')).toBeVisible();
    await expect(page.locator('#performanceDayAssignmentRows .performance-day-assignment-members')).toBeVisible();

    const performanceDayLayout = await page.evaluate(() => {
      const role = document.querySelector('#performanceDayAssignmentRows .performance-day-assignment-role');
      const members = document.querySelector('#performanceDayAssignmentRows .performance-day-assignment-members');
      const row = document.querySelector('#performanceDayAssignmentRows tr');
      const viewportWidth = document.documentElement.clientWidth;
      const scrollWidth = document.documentElement.scrollWidth;
      const scale = window.visualViewport?.scale ?? 1;
      const roleBox = role.getBoundingClientRect();
      const membersBox = members.getBoundingClientRect();
      const rowBox = row.getBoundingClientRect();
      return {
        viewportWidth,
        scrollWidth,
        scale,
        roleFontSize: getComputedStyle(role).fontSize,
        membersFontSize: getComputedStyle(members).fontSize,
        roleLeft: roleBox.left,
        membersLeft: membersBox.left,
        rowLeft: rowBox.left,
        rowRight: rowBox.right,
      };
    });

    expect(parseFloat(performanceDayLayout.roleFontSize)).toBeGreaterThanOrEqual(16);
    expect(parseFloat(performanceDayLayout.membersFontSize)).toBeGreaterThanOrEqual(16);
    expect(performanceDayLayout.scrollWidth).toBeLessThanOrEqual(performanceDayLayout.viewportWidth);
    expect(performanceDayLayout.scale).toBeCloseTo(1, 2);
    expect(performanceDayLayout.roleLeft).toBeGreaterThanOrEqual(performanceDayLayout.rowLeft);
    expect(performanceDayLayout.membersLeft).toBeGreaterThanOrEqual(performanceDayLayout.rowLeft);
    expect(performanceDayLayout.rowRight).toBeLessThanOrEqual(performanceDayLayout.viewportWidth + 1);

    monitor.assertNoClientErrors();
  });

  test('mobile practice casting extra inputs keep readable font size after adding an extra row', async ({ page }) => {
    const monitor = attachErrorMonitor(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await installPortalApiMocks(page, {
      permission: '管理者',
      bootstrapOverrides: {
        performances: [{
          id: 1,
          title: 'Mobile Casting',
          date: '2026-08-20',
        }],
        extras: {
          castings: [{
            id: 401,
            performance_id: 1,
            piece: 'Test Piece',
            members: [],
            extras: [],
          }],
        },
      },
    });
    await page.goto('/');
    await loginAsAdmin(page);

    await page.click('#portalDrawerToggle');
    await page.locator('#portalDrawerMenu [data-home-admin]').click();
    await page.locator('#adminPanel [data-tab="casting-admin"]').click();
    await expect(page.locator('#castingAdminTab')).toBeVisible();
    await expect(page.locator('.casting-edit-btn')).toBeVisible();

    await page.locator('.casting-edit-btn').first().click();
    await expect(page.locator('#castingPieceInput')).toHaveValue('Test Piece');

    await page.click('#castingAddExtraBtn');
    const extraNameInput = page.locator('#castingExtrasList [data-name-index="0"]');
    const extraPartSelect = page.locator('#castingExtrasList [data-extra-part-select-index="0"]');
    await expect(extraNameInput).toBeVisible();
    await expect(extraPartSelect).toBeVisible();

    const practiceCastingLayout = await page.evaluate(() => {
      const input = document.querySelector('#castingExtrasList [data-name-index="0"]');
      const select = document.querySelector('#castingExtrasList [data-extra-part-select-index="0"]');
      const container = document.querySelector('#castingExtrasList');
      const viewportWidth = document.documentElement.clientWidth;
      const scrollWidth = document.documentElement.scrollWidth;
      const scale = window.visualViewport?.scale ?? 1;
      const containerBox = container.getBoundingClientRect();
      const inputBox = input.getBoundingClientRect();
      const selectBox = select.getBoundingClientRect();
      return {
        viewportWidth,
        scrollWidth,
        scale,
        inputFontSize: getComputedStyle(input).fontSize,
        selectFontSize: getComputedStyle(select).fontSize,
        containerLeft: containerBox.left,
        containerRight: containerBox.right,
        inputLeft: inputBox.left,
        inputRight: inputBox.right,
        selectLeft: selectBox.left,
        selectRight: selectBox.right,
      };
    });

    expect(parseFloat(practiceCastingLayout.inputFontSize)).toBeGreaterThanOrEqual(16);
    expect(parseFloat(practiceCastingLayout.selectFontSize)).toBeGreaterThanOrEqual(16);
    expect(practiceCastingLayout.scrollWidth).toBeLessThanOrEqual(practiceCastingLayout.viewportWidth);
    expect(practiceCastingLayout.scale).toBeCloseTo(1, 2);
    expect(practiceCastingLayout.inputLeft).toBeGreaterThanOrEqual(practiceCastingLayout.containerLeft);
    expect(practiceCastingLayout.selectLeft).toBeGreaterThanOrEqual(practiceCastingLayout.containerLeft);
    expect(practiceCastingLayout.selectRight).toBeLessThanOrEqual(practiceCastingLayout.containerRight + 1);

    monitor.assertNoClientErrors();
  });

  test('mobile album photo viewer can return to portal album screen', async ({ page }) => {
    const monitor = attachErrorMonitor(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await installPortalApiMocks(page, {
      permission: '一般',
      bootstrapOverrides: {
        extras: {
          albums: [{
            id: 1,
            event_name: 'Mobile Album',
            created_by_member_id: 1,
            created_by_member_name: 'Test Member',
            created_at: '2026-07-02T10:00:00Z',
            photos: [{
              filename: 'sample.png',
              url: '/static/icons/icon-192.png',
              uploaded_by_member_name: 'Test Member',
              uploaded_at: '2026-07-02T10:01:00Z',
            }],
          }],
        },
      },
    });
    await page.goto('/');
    await loginAsMember(page);

    await page.click('#portalDrawerToggle');
    await page.locator('#portalDrawerMenu [data-home-tab="member-album"]').click();
    await expect(page.locator('#memberAlbumTab')).toBeVisible();
    await expect(page.locator('.album-photo-open-btn')).toBeVisible();

    await page.locator('.album-photo-open-btn').first().click();
    await expect(page.locator('#albumPhotoViewer')).toBeVisible();
    await expect(page.locator('#albumPhotoViewerCloseBtn')).toBeVisible();

    await page.locator('#albumPhotoViewerCloseBtn').click();
    await expect(page.locator('#albumPhotoViewer')).toBeHidden();
    await expect(page.locator('#memberAlbumTab')).toBeVisible();
    await expect(page.locator('#memberPanel')).toBeVisible();

    monitor.assertNoClientErrors();
  });
});
