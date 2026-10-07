// The spike's service worker: records every push it receives and shows a notification, as
// Kept's sw.ts will (plan T24).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('push', (event) => {
  const text = event.data ? event.data.text() : null;
  event.waitUntil(
    (async () => {
      await self.registration.showNotification('Kept spike', { body: text ?? '(no data)', tag: 'spike', data: { url: '/things/abc' } });
      for (const c of await self.clients.matchAll({ includeUncontrolled: true })) c.postMessage({ push: text });
    })(),
  );
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow(event.notification.data.url));
});
