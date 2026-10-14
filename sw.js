/**
 * ============================================================================
 * PEMS PWA — SERVICE WORKER (Offline-First App Shell Caching)
 * File: sw.js
 * ============================================================================
 * Caches core application shell, styles, scripts, fonts, and assets for
 * instant offline loading, including when reopened while disconnected.
 *
 * Strategies:
 * 1. App Shell & Static Assets: Stale-While-Revalidate / Cache-First
 * 2. Google Apps Script API: Network-Only (IndexedDB handles offline persistence)
 * 3. Offline Navigation Fallback: Serves cached index.html
 */

const CACHE_NAME = 'pems-pwa-v1.0.0';

const PRECACHE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './pwa-config.js',
  './js/db.js',
  './js/sync.js',
  './js/pwa-install.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable.png',
  'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
  'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap'
];

// 1. Service Worker Installation
self.addEventListener('install', (event) => {
  console.log('[PEMS SW] Installing service worker & caching app shell...');
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Use cache.addAll with fault-tolerance so one missing remote resource doesn't abort install
      return Promise.allSettled(
        PRECACHE_ASSETS.map((url) => {
          return cache.add(url).catch((err) => {
            console.warn('[PEMS SW] Precache warning for', url, err);
          });
        })
      );
    }).then(() => {
      console.log('[PEMS SW] App shell precached successfully.');
      return self.skipWaiting();
    })
  );
});

// 2. Service Worker Activation & Cache Cleanup
self.addEventListener('activate', (event) => {
  console.log('[PEMS SW] Activating service worker...');
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((name) => {
          if (name !== CACHE_NAME) {
            console.log('[PEMS SW] Removing obsolete cache:', name);
            return caches.delete(name);
          }
        })
      );
    }).then(() => {
      console.log('[PEMS SW] Claiming clients for instant offline control.');
      return self.clients.claim();
    })
  );
});

// 3. Network Request Interception & Caching Strategies
self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // A. Never cache POST requests or Google Apps Script API calls in SW
  // (IndexedDB handles offline API queueing and mutation persistence)
  if (
    request.method !== 'GET' ||
    url.hostname.includes('script.google.com') ||
    url.hostname.includes('script.googleusercontent.com')
  ) {
    return; // Pass through to network
  }

  // B. Navigation requests (HTML pages) -> Stale-While-Revalidate with offline fallback
  if (request.mode === 'navigate') {
    event.respondWith(
      caches.match('./index.html').then((cachedResponse) => {
        const fetchPromise = fetch(request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put('./index.html', responseClone);
            });
          }
          return networkResponse;
        }).catch(() => {
          // Network failed, return cached response
          return cachedResponse;
        });

        // Return cached page immediately if available, else wait for network
        return cachedResponse || fetchPromise;
      })
    );
    return;
  }

  // C. Static Assets & Fonts -> Stale-While-Revalidate
  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      if (cachedResponse) {
        // Fetch background update to keep cache fresh
        fetch(request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(request, networkResponse);
            });
          }
        }).catch(() => {});
        return cachedResponse;
      }

      // Not in cache: fetch from network and cache
      return fetch(request).then((networkResponse) => {
        if (!networkResponse || networkResponse.status !== 200 || networkResponse.type === 'opaque') {
          return networkResponse;
        }

        const responseClone = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(request, responseClone);
        });
        return networkResponse;
      }).catch((err) => {
        // Fallback for image requests when offline
        if (request.destination === 'image') {
          return caches.match('./icons/icon-192.png');
        }
        throw err;
      });
    })
  );
});

// 4. Background Sync & Message Handling
self.addEventListener('message', (event) => {
  if (event.data && event.data.action === 'skipWaiting') {
    self.skipWaiting();
  }
});
