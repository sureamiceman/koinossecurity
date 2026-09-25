// Koinos Security service worker.
// App files: network first (always fresh when online), cached copy when offline.
// Supabase data requests are never touched here; the app keeps its own offline copy.
const CACHE = 'koinos-shell-v1';
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
