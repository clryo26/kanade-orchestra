const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

test('introductions use one batch request, isolated details and lazy portraits', async ({ page }) => {
    const requests = [];
    let fail = true;
    await page.route('https://intro.test/**', async (route) => {
        const url = new URL(route.request().url());
        requests.push(url.pathname);
        if (url.pathname === '/api/member-introductions') {
            if (fail) return route.fulfill({ status: 503, body: '{}' });
            return route.fulfill({ contentType: 'application/json', body: JSON.stringify(
                Array.from({ length: 59 }, (_, i) => ({ id: i + 1, name: `Member ${i + 1}`, part: 'Vn',
                    comment: `Profile ${i + 1}`, photo_url: i === 0 ? '/api/members/1/photo?asset=normalized' : '' }))
            ) });
        }
        if (url.pathname === '/api/members/1/photo') return route.fulfill({ contentType: 'image/png', body: Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1sAAAAASUVORK5CYII=', 'base64') });
        return route.fulfill({ contentType: 'text/html', body: '<div id="memberIntroInfo"></div>' });
    });
    await page.goto('https://intro.test/');
    await page.evaluate(() => {
        window.portalRuntimeContext = { getById: (id) => document.getElementById(id),
            appState: { members: [], currentUserMemberId: 1, memberDetailRecords: {}, memberDetailLoadStates: {} } };
        window.request = async (url) => {
            const response = await fetch(url);
            if (!response.ok) throw new Error('API unavailable');
            return response.json();
        };
        window.escapeHtml = (value) => String(value || '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
        window.cssSafeId = (value) => value;
        window.partSortIndex = () => 0;
        window.groupBy = (items, field) => Object.groupBy(items, (item) => item[field]);
    });
    for (const name of ['helpers', 'render']) await page.addScriptTag({ content: fs.readFileSync(
        path.resolve(__dirname, `../../src/static/js/modules/members/${name}.js`), 'utf8') });
    await page.evaluate(() => showMemberIntroView());
    await expect(page.getByRole('button', { name: '再試行' })).toBeVisible();
    fail = false;
    await page.getByRole('button', { name: '再試行' }).click();
    await expect(page.locator('.member-comment')).toHaveCount(59);
    await expect(page.locator('.member-comment').last()).toContainText('Profile');
    expect(requests.filter((url) => url === '/api/member-introductions')).toHaveLength(2);
    expect(requests.filter((url) => /^\/api\/members\/\d+$/.test(url))).toHaveLength(0);
    await expect(page.locator('.member-intro-photo')).toHaveAttribute('loading', 'lazy');
    expect(await page.evaluate(() => portalRuntimeContext.appState.memberDetailRecords)).toEqual({});
});
