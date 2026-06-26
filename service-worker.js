// ── Seamly Service Worker — v8 ────────────────────────────────────────────────
//
// Strategy: Approach A — App shell caching only.
//
// What this does:
//   • Caches the HTML/JS app shell and the Supabase CDN script on first visit.
//   • Serves the cached shell when the user is offline, so the app loads.
//   • Does NOT cache any Supabase data — all family data still requires internet.
//   • When offline, the app detects the lack of connection and shows a banner
//     ("You're offline") — all data operations are visually disabled.
//
// What this does NOT do (Approach B — planned for a future version):
//   • Cache family data locally for offline reading.
//   • Allow offline writes with sync-on-reconnect.
//   See project summary roadmap for Approach B details.
//
// ── UPDATING BETWEEN VERSIONS ────────────────────────────────────────────────
// Increment CACHE_VERSION on every new Seamly release (v9, v10, …).
// The activate handler automatically deletes the old cache on next load.
// ─────────────────────────────────────────────────────────────────────────────

const CACHE_VERSION = 'seamly-v8';

// Resources to pre-cache on install (app shell only)
const APP_SHELL = [
  '/',
  '/index.html',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.39.3/dist/umd/supabase.min.js',
];

// ── INSTALL ───────────────────────────────────────────────────────────────────
// Cache the app shell the first time the service worker is installed.
// Uses individual adds with catch so one failed resource doesn't break the rest.
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(cache =>
      Promise.allSettled(
        APP_SHELL.map(url =>
          cache.add(url).catch(err =>
            console.warn(`[Seamly SW] Could not cache ${url}:`, err)
          )
        )
      )
    )
  );
  // Take control immediately — don't wait for the old SW to expire
  self.skipWaiting();
});

// ── ACTIVATE ──────────────────────────────────────────────────────────────────
// Delete any caches from previous Seamly versions on activation.
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_VERSION)
          .map(key => {
            console.log('[Seamly SW] Removing old cache:', key);
            return caches.delete(key);
          })
      )
    )
  );
  // Immediately control all open tabs without requiring a reload
  self.clients.claim();
});

// ── FETCH ─────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // 1. Skip all non-GET requests (Supabase writes: POST, PATCH, DELETE).
  //    These must always go to the network — never intercept or queue them.
  if (event.request.method !== 'GET') return;

  // 2. Supabase API calls — network only, no caching of family data.
  //    If offline, return a structured error so the app can handle it gracefully.
  if (url.hostname.includes('supabase.co')) {
    event.respondWith(
      fetch(event.request).catch(() =>
        new Response(
          JSON.stringify({ error: 'offline', message: 'No internet connection' }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        )
      )
    );
    return;
  }

  // 3. Google Fonts — network only (cross-origin caching is unreliable).
  //    If offline, fonts fall back to system sans-serif — app still functions.
  if (url.hostname.includes('fonts.googleapis.com') ||
      url.hostname.includes('fonts.gstatic.com')) {
    return; // let the browser handle it natively
  }

  // 4. App shell and CDN scripts — cache-first with background update.
  //    Serve cached version instantly, then update cache from network silently.
  event.respondWith(
    caches.match(event.request).then(cached => {
      // Kick off a background network fetch to keep the cache fresh
      const networkFetch = fetch(event.request)
        .then(response => {
          if (response && response.status === 200 && response.type !== 'opaque') {
            caches.open(CACHE_VERSION).then(cache =>
              cache.put(event.request, response.clone())
            );
          }
          return response;
        })
        .catch(() => null); // silent — we may already have a cached version

      // Return cached version immediately if available, otherwise wait for network
      if (cached) return cached;

      return networkFetch.then(response => {
        if (response) return response;
        // Both cache and network failed (offline, first visit) — return fallback
        if (event.request.mode === 'navigate') {
          return caches.match('/');
        }
        return new Response('', { status: 503 });
      });
    })
  );
});
