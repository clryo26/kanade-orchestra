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
});
