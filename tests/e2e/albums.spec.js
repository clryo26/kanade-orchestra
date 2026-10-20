const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

for (const source of ['ids', 'api-url', 'legacy-url']) {
test(`gallery fetches original only when selected (${source})`, async ({ page }) => {
    const imageRequests = [];
    await page.route('https://album.test/**', async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname.startsWith('/api/albums/') || url.pathname === '/original.jpg') {
            imageRequests.push(url.pathname);
            return route.fulfill({ contentType: 'image/png', body: Buffer.from(
                'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1sAAAAASUVORK5CYII=', 'base64') });
        }
        return route.fulfill({ contentType: 'text/html', body: '<div id="memberAlbumInfo"></div>' });
    });
    await page.goto('https://album.test/');
    await page.evaluate((source) => {
        const photo = { filename: 'camera.jpg' };
        if (source === 'ids') photo.id = 2;
        else photo.url = source === 'api-url' ? '/api/albums/1/photos/2' : '/original.jpg';
        window.portalRuntimeContext = {
            getById: (id) => document.getElementById(id),
            appState: { albums: [{ id: 1, photos: [photo] }] }
        };
        window.isAdmin_Portal = () => false;
        window.currentUserMemberName = () => 'member';
        window.comparePortalInstantDesc = () => 0;
        window.formatDateTimeLabel = () => '';
        window.escapeHtml = (s) => String(s).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
        window.withButtonStatus = () => {};
    }, source);
    await page.addScriptTag({ content: fs.readFileSync(path.resolve(__dirname, '../../src/static/js/modules/albums.js'), 'utf8') });
    await page.evaluate(() => renderAlbumView());
    if (source === 'legacy-url') {
        await expect(page.locator('.album-photo-open-btn img')).toHaveCount(0);
        await expect(page.locator('.album-photo-open-btn')).toContainText('選択して写真を表示');
        expect(imageRequests).toEqual([]);
    } else {
        await expect.poll(() => imageRequests.length).toBe(1);
        expect(imageRequests).toEqual(['/api/albums/1/photos/2/thumbnail']);
    }
    await page.locator('.album-photo-open-btn').click();
    await expect.poll(() => imageRequests.length).toBe(source === 'legacy-url' ? 1 : 2);
    expect(imageRequests.at(-1)).toBe(source === 'legacy-url' ? '/original.jpg' : '/api/albums/1/photos/2');
    await page.locator('#albumPhotoViewerCloseBtn').click();
    await expect(page.locator('#albumPhotoViewer')).toBeHidden();
    await expect(page.locator('#albumPhotoViewerImage')).not.toHaveAttribute('src');
});
}
