// Koinos Security service worker.
// App files: network first (always fresh when online), cached copy when offline.
// Supabase data requests are never touched here; the app keeps its own offline copy.
const CACHE = 'koinos-shell-v2';
const SHELL = [
  '/', '/index.html', '/styles.css', '/app.js', '/config.js',
  '/vendor/supabase.js', '/manifest.webmanifest',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png', '/icons/favicon-32.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(req);
      if (res.ok) cache.put(req.mode === 'navigate' ? '/index.html' : req, res.clone());
      return res;
    } catch (err) {
      const cached = await cache.match(req.mode === 'navigate' ? '/index.html' : req);
      if (cached) return cached;
      throw err;
    }
  })());
});

// Push notifications (sent by netlify/functions/push.mjs).
self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = { body: event.data && event.data.text() }; }
  event.waitUntil(self.registration.showNotification(d.title || 'Koinos Security', {
    body: d.body || '',
    tag: d.tag || undefined,
    renotify: !!d.tag,
    icon: '/icons/icon-192.png',
    badge: '/icons/favicon-32.png',
    data: { url: d.url || '#/alerts' }
  }));
});

// Tapping a notification opens (or focuses) the app on the right screen.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const hash = (event.notification.data && event.notification.data.url) || '';
  const target = new URL('/' + (hash.startsWith('#') ? hash : ''), self.location.origin).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (new URL(w.url).origin === self.location.origin) {
        await w.focus();
        w.postMessage({ type: 'open', hash });
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
