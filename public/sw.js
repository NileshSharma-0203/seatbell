'use strict';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'A seat opened', body: 'Open your alerts for details.' };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'A seat opened', {
      body: data.body || '',
      tag: data.tag,
      renotify: Boolean(data.tag),
      requireInteraction: true,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: data.url || '/app' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow(event.notification.data.url));
});
