const { test, expect } = require('@playwright/test');
const { installPortalApiMocks } = require('./fixtures/mockApi');
const { attachErrorMonitor } = require('./fixtures/errorMonitor');

async function loginAsMember(page) {
  await page.fill('#portalNameInput', '団員テスト');
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
      permission: '荳闊ｬ',
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
      return {
        filter: rect(filter),
        continuous: rect(continuous),
        firstGroup: rect(firstGroup),
        viewportWidth,
      };
    });

    expect(recordingLayout.continuous.top).toBeGreaterThanOrEqual(recordingLayout.filter.bottom - 1);
    expect(recordingLayout.continuous.bottom).toBeLessThanOrEqual(recordingLayout.firstGroup.top + 1);
    expect(recordingLayout.continuous.left).toBeGreaterThanOrEqual(0);
    expect(recordingLayout.continuous.right).toBeLessThanOrEqual(recordingLayout.viewportWidth);

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

  test('mobile album photo viewer can return to portal album screen', async ({ page }) => {
    const monitor = attachErrorMonitor(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await installPortalApiMocks(page, {
      permission: '荳闊ｬ',
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
