// Push-only worker: leave all navigation, API and asset caching to the browser.
self.addEventListener('push', (event) => {
    let payload;
    try { payload = event.data?.json(); } catch { payload = null; }
    if (!payload || typeof payload.title !== 'string') return;
    event.waitUntil(self.registration.showNotification(payload.title, {
        body: String(payload.body || ''), tag: String(payload.tag || ''),
        icon: '/static/icons/icon-192.png',
        data: { target: String(payload.target || '') }
    }));
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const target = String(event.notification.data?.target || '');
    // Targets are route names, never caller-supplied external URLs.
    const url = new URL('/', self.location.origin);
    url.searchParams.set('notification', target);
    event.waitUntil((async () => {
        const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const existing = windows.find((client) => new URL(client.url).origin === url.origin);
        if (existing) {
            await existing.navigate(url.href);
            await existing.focus();
        } else {
            await self.clients.openWindow(url.href);
        }
    })());
});
