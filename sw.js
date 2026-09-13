// Offline support. Network first, so a deployed update is picked up straight
// away; the cached copy is used only when there's no connection.
const CACHE = 'lumber-cut-planner-v1';
const SHELL = [
  './',
  'index.html',
  'css/app.css',
  'src/app.js',
  'src/planner.js',
  'src/units.js',
  'src/store.js',
  'src/sheet-view.js',
  'fonts/archivo-wdth.woff2',
  'icons/icon.svg',
  'manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return res;
      })
      .catch(async () => (await caches.match(request, { ignoreSearch: true }))
        || (request.mode === 'navigate' ? caches.match('index.html') : Response.error())),
  );
});
