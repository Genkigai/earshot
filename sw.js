// sw.js — caches the app shell so Earshot opens instantly and works offline
// (record in a tunnel; memos save locally to IndexedDB and are there when you reconnect).
const CACHE = 'earshot-v10';
const ASSETS = [
  './', './index.html', './styles.css', './app.js',
  './db.js', './recorder.js', './player.js', './analysis.js', './studio.js', './push.js',
  './config.js', './supabase-client.js', './auth.js', './sync.js', './store.js', './audio-context.js',
  './manifest.webmanifest', './icon.svg', './mic.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  // Never cache Supabase API/storage/realtime traffic — always go to network.
  if (url.hostname.endsWith('.supabase.co')) return;
  // Stale-while-revalidate: serve cache instantly (offline-friendly) but always refresh in the
  // background, so a deployed fix lands on the next launch without bumping CACHE by hand.
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const network = fetch(e.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});

// ---- Push notifications (Phase 2: an Edge Function will send these on new memos) ----
self.addEventListener('push', (e) => {
  let data = { title: 'New memo', body: 'You have a new memo' };
  try { if (e.data) data = { ...data, ...e.data.json() }; } catch (_) {}
  e.waitUntil(self.registration.showNotification(data.title, { body: data.body, icon: 'icon.svg', badge: 'icon.svg', tag: 'earshot-memo' }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) { if ('focus' in c) return c.focus(); }
      return self.clients.openWindow('./');
    })
  );
});
