// ── Seamly Service Worker — v23 ───────────────────────────────────────────────
//
// Strategy: Approach A — App shell caching only.
//
// What this does:
//   • Caches the HTML/JS app shell and the Supabase CDN script on first visit.
//   • Serves the cached shell when the user is offline, so the app loads.
//   • Does NOT cache any Supabase data itself — that's handled entirely at
//     the app level now (see below), not by this service worker.
//   • When offline, the app shows a banner with how old its data is, still
//     lets you create new notes/events (saved on-device, synced automatically
//     once you're back online), and blocks edits to anything already saved
//     to the database until the connection returns.
//
// v23 Pass D update: "Approach B" (offline reading of family data, plus
// offline creation of new items) is now implemented — but entirely at the
// APP level (see index.html's saveSnapshotToLocalStorage() /
// loadSnapshotFromLocalStorage() / the pending-sync helpers near sbWrite()),
// not here in the service worker. This file's job stays exactly what it was
// in v22: cache the app shell itself (the HTML/JS/CSS that makes up Seamly)
// so the app can even LOAD while offline. What loads once it's open — your
// family's actual data — is a separate localStorage snapshot the app
// manages on its own, refreshed every time a full load succeeds online.
//
// ── UPDATING BETWEEN VERSIONS ────────────────────────────────────────────────
// Increment CACHE_VERSION on every new Seamly release (v9, v10, …).
// The activate handler automatically deletes the old cache on next load.
// This was left un-bumped since v8 through V21 and most of V22 — flagged
// during a V22 connection-flakiness investigation and corrected here. Bump
// it on every future release, per this file's own original instruction.
// ─────────────────────────────────────────────────────────────────────────────

const CACHE_VERSION = 'seamly-v23';

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

  // 0. v22.2 fix: ignore anything that isn't a normal http(s) request —
  //    browser extensions (chrome-extension://, moz-extension://), and
  //    other non-network schemes (data:, blob:) can trigger fetch events
  //    in this same page context. The Cache API only supports http(s), so
  //    letting one of these reach branch 4's cache.put() below throws
  //    "Failed to execute 'put' on 'Cache': Request scheme '...' is
  //    unsupported" — seen in a real production console capture during
  //    testing. Letting the browser handle these natively (by simply not
  //    calling respondWith()) removes the gap entirely; this service
  //    worker has no business intercepting non-http(s) requests anyway.
  if (!url.protocol.startsWith('http')) return;

  // 1. Skip all non-GET requests (Supabase writes: POST, PATCH, DELETE).
  //    These must always go to the network — never intercept or queue them.
  if (event.request.method !== 'GET') return;

  // 2. Supabase API calls — network only, no caching of family data.
  //    If offline, return a structured error so the app can handle it gracefully.
  //    (v23: the app itself now checks navigator.onLine before ever attempting
  //    one of these calls — see sbWrite()'s offline guard — so this fallback
  //    mainly covers a request already in flight when the connection drops.)
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
            // v22 fix: clone the response IMMEDIATELY, synchronously, the
            // moment it's available — NOT deferred behind the async
            // caches.open() call below. The previous version called
            // response.clone() only after caches.open() resolved; by then,
            // this same `response` object may already have been handed to
            // the browser (via the return value flowing to
            // event.respondWith()) and had its body read/consumed — making
            // the delayed .clone() throw "Failed to execute 'clone' on
            // 'Response': Response body is already used", exactly as seen
            // in a real staging console capture during testing. Cloning
            // right here, before `response` can be consumed by anything
            // else, removes the race entirely.
            const responseToCache = response.clone();
            caches.open(CACHE_VERSION).then(cache =>
              cache.put(event.request, responseToCache)
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
