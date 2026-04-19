const CACHE = 'dilaeit-v1';
const VAPID_PUBLIC = 'BCxNLln4Ui7gwWRg2gFH958VTt8oHA3SnCxazwESjqPWXitqdWe4qo9n87IDqLGU2ZV2zFXqQ7tIx-8RUqxargc';

const PRECACHE = [
  '/',
  '/stats.html',
  '/trip-search.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png', 
];

// ─── Install: Precache Shell ──────────────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

// ─── Activate: Clean old caches ───────────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ─── Fetch: Network first, cache fallback ─────────────────────────────────────
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // API-Calls nie cachen
  if (url.pathname.startsWith('/api/') || url.hostname !== self.location.hostname) {
    return;
  }

  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});

// ─── Push Notification ────────────────────────────────────────────────────────
self.addEventListener('push', e => {
  let data = { title: 'dilaeit', body: '', tag: 'dilaeit' };
  try { data = { ...data, ...e.data.json() }; } catch {}

  e.waitUntil(
    self.registration.showNotification(data.title, {
      body:    data.body,
      tag:     data.tag,
      icon:    '/icons/icon-192.png',
      badge:   '/icons/icon-192.png',
      vibrate: [200, 100, 200],
      data:    data,
      actions: data.actions || [],
    })
  );
});

// ─── Notification Click ───────────────────────────────────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/stats.html';
  e.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(clients => {
      const existing = clients.find(c => c.url.includes(self.location.origin));
      if (existing) { existing.focus(); existing.navigate(url); }
      else self.clients.openWindow(url);
    })
  );
});
