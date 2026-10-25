// Koinos Security service worker.
// App files: network first (always fresh when online), cached copy when offline.
// Supabase data requests are never touched here; the app keeps its own offline copy.
//
// VERSION must change with every release (keep it equal to appVersion in
// config.js): a changed file is how phones notice there's a new version.
const VERSION = '2.0.0';
const CACHE = 'koinos-shell-' + VERSION;
const SHELL = [
  '/', '/index.html', '/styles.css', '/app.js', '/config.js',
  '/vendor/supabase.js', '/manifest.webmanifest',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png', '/icons/favicon-32.png'
];

self.addEventListener('install', (event) => {
  // cache: 'reload' = straight from the server, never the browser's own saved copy.
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

// Ask an open app which version it is running. Apps from before version
// 1.13.0 can't answer, which is how we spot them.
function askVersion(client, ms = 1500) {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    const t = setTimeout(() => resolve(null), ms);
    ch.port1.onmessage = (e) => { clearTimeout(t); resolve((e.data && e.data.version) || null); };
    try { client.postMessage({ type: 'version?' }, [ch.port2]); } catch { clearTimeout(t); resolve(null); }
  });
}

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    // Only old copies of the app are removed; photos and SOP pictures saved
    // for offline use live in their own caches and are kept.
    await Promise.all(keys.filter((k) => k !== CACHE && k.startsWith('koinos-shell-')).map((k) => caches.delete(k)));
    await self.clients.claim();
    // An old app that's open (often an installed app resumed from the
    // background, which never reloads by itself) is reloaded once onto this
    // version. Newer apps answer and show their own "update" banner instead.
    // (The reload is started, not waited for: a page can't load through this
    // helper until it has finished starting up, so waiting would deadlock.)
    const wins = await self.clients.matchAll({ type: 'window' });
    const answers = await Promise.all(wins.map((w) => askVersion(w)));
    wins.forEach((w, i) => { if (!answers[i]) w.navigate(w.url).catch(() => { /* the app's own check will catch it */ }); });
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === '/config.js' && url.searchParams.has('check')) return;   // the app's "is there a new version?" check

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      // cache: 'no-cache' = always ask the server whether the file changed
      // (cheap when it hasn't), so an old copy is never reused by mistake.
      const res = req.mode === 'navigate'
        ? await fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' })
        : await fetch(req, { cache: 'no-cache' });
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
    // Shift confirmations: Yes / No buttons (Android and desktop; iPhone shows
    // none, and tapping the notification opens the confirm screen instead).
    actions: Array.isArray(d.actions) ? d.actions.slice(0, 2) : undefined,
    requireInteraction: !!d.requireInteraction,
    vibrate: d.urgent ? [400, 150, 400, 150, 400] : undefined,
    data: { url: d.url || '#/alerts', kind: d.kind || '', token: d.token || '', shift: d.shift || '' }
  }));
});

async function openApp(hash) {
  const target = new URL('/' + (hash.startsWith('#') ? hash : ''), self.location.origin).href;
  const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const w of wins) {
    if (new URL(w.url).origin === self.location.origin) {
      await w.focus();
      w.postMessage({ type: 'open', hash });
      return;
    }
  }
  await self.clients.openWindow(target);
}

// "Yes, I'll be there": confirm straight from the notification.
async function confirmFromNotification(data) {
  try {
    const res = await fetch('/api/shift-reply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: data.token }) });
    const j = await res.json().catch(() => ({}));
    if (res.ok && j.state === 'confirmed') {
      await self.registration.showNotification('Thanks, you\'re confirmed', {
        body: 'It shows as Confirmed on the schedule.', tag: 'confirm-' + data.shift, icon: '/icons/icon-192.png', badge: '/icons/favicon-32.png', data: { url: '#/schedule' }
      });
      return;
    }
  } catch { /* offline: fall through and open the app */ }
  await openApp(data.url);
}

// Tapping a notification opens (or focuses) the app on the right screen.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const hash = data.url || '';
  if (data.kind === 'confirm' && event.action === 'yes' && data.token) event.waitUntil(confirmFromNotification(data));
  else if (data.kind === 'confirm' && event.action === 'no') event.waitUntil(openApp(hash + '/no'));
  else event.waitUntil(openApp(hash));
});
