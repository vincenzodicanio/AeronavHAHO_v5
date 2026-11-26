/* AeronavHAHO Service Worker - Supporto Offline & NOAA GFS Network-First */
const CACHE_NAME = 'aeronavhaho-noaa-v2';
const STATIC_ASSETS = [
  './',
  './index.html',
  './nav.html',
  './mgrs-core.js',
  './manifest.json',
  './icon-192.svg'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS).catch(() => {}))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);

  // Strategia Network-First per i bollettini NOAA GFS:
  // Scarica sempre i dati aggiornati se c'e' rete, altrimenti usa l'ultimo bollettino in cache
  if (url.hostname === 'api.open-meteo.com' && url.pathname.includes('/gfs')) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Strategia Network-First anche per i file della PWA per aggiornamenti automatici
  event.respondWith(
    // no-cache: salta la cache HTTP di GitHub Pages (~10 min) e controlla sempre il server, cosi' gli aggiornamenti arrivano subito
    fetch(event.request, { cache: 'no-cache' })
      .then((response) => {
        if (response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
