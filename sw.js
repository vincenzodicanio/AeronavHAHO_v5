/* AeronavHAHO Service Worker - Supporto Offline, Tile Mappe Locali & NOAA GFS */
const CACHE_NAME = 'aeronavhaho-noaa-v3';
const TILE_CACHE_NAME = 'aeronavhaho-tiles-v1';
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
        keys
          .filter((key) => key !== CACHE_NAME && key !== TILE_CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);

  // Tile mappe (EOX Sentinel-2 Cloudless CC BY 4.0 & NASA GIBS Public Domain):
  // Cache-First con salvataggio automatico in locale per uso offline
  if (url.hostname === 'tiles.maps.eox.at' || url.hostname === 'gibs.earthdata.nasa.gov') {
    event.respondWith(
      caches.open(TILE_CACHE_NAME).then((cache) =>
        cache.match(event.request).then((cached) => {
          if (cached) return cached;
          return fetch(event.request).then((response) => {
            if (response && (response.status === 200 || response.type === 'opaque')) {
              cache.put(event.request, response.clone());
            }
            return response;
          });
        })
      )
    );
    return;
  }

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
