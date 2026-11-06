// Network first, cache as fallback: always the newest version when online, still opens offline.
const CACHE = 'esp28-w0.4.0';
const FILES = ['./', 'index.html', 'app.js', 'core.js', 'manifest.webmanifest', 'icon.svg', 'leaflet/leaflet.js', 'leaflet/leaflet.css', 'leaflet/images/marker-icon.png', 'leaflet/images/marker-icon-2x.png', 'leaflet/images/marker-shadow.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then((ks) =>
  Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin || e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request).then((r) => { const c = r.clone(); caches.open(CACHE).then((x) => x.put(e.request, c)); return r; })
    .catch(() => caches.match(e.request)));
});
