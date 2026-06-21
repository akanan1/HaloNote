// HaloNote PWA service worker — shell cache ONLY.
//
// HIPAA POSTURE: this service worker MUST NEVER cache any /api/* response.
// Provider phones can be lost, stolen, or briefly handed to a patient;
// a cached PHI payload sitting on disk is an audit-trail problem. The
// fetch handler hard-bails on any URL whose pathname starts with
// "/api/" or the WebSocket upgrade path "/api/recordings/stream", so
// every PHI request goes straight to the network with no local copy.
//
// What we DO cache: hashed static assets (Vite emits /assets/*.{js,css}
// with content-hashed filenames), the manifest, and the icons. The
// install prompt becomes available as soon as the SW + manifest are in
// place; offline support is intentionally NOT a goal — if the network
// is down, we'd rather show a clear error than serve a stale chart view.

const CACHE_VERSION = "halonote-shell-v1";
const SHELL_ASSETS = [
  "/manifest.webmanifest",
  "/halonote-icon.svg",
  "/favicon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(SHELL_ASSETS)),
  );
  // Take over from any older SW immediately. Avoids the "reload twice
  // after deploy" gotcha that bites every shipping PWA on day one.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== CACHE_VERSION)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Same-origin only. Cross-origin (fonts, analytics) goes straight to
  // the network — no caching responsibility here.
  if (url.origin !== self.location.origin) return;

  // HARD BLOCK: never touch /api/* with the cache. PHI must not land on
  // the device's disk. Includes the WebSocket upgrade path used by the
  // streaming-transcript bridge (the SW won't intercept WS handshakes,
  // but this guard makes the intent explicit + future-proofs against
  // proxy routes added under /api).
  if (url.pathname.startsWith("/api/")) return;

  // Non-GET requests bypass the cache. Auth, recordings finalize, etc.
  // — all state-changing requests should hit the server.
  if (event.request.method !== "GET") return;

  // Hashed static assets: cache-first. Vite content-hashes the
  // filenames so a cache hit is always the version it claims to be.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.match(event.request).then(
        (cached) =>
          cached ??
          fetch(event.request).then((res) => {
            // Only cache successful responses; never partial / errors.
            if (res.ok) {
              const clone = res.clone();
              caches.open(CACHE_VERSION).then((c) => c.put(event.request, clone));
            }
            return res;
          }),
      ),
    );
    return;
  }

  // Manifest + icons (shell-cached at install): same cache-first pattern.
  if (SHELL_ASSETS.includes(url.pathname)) {
    event.respondWith(
      caches.match(event.request).then((cached) => cached ?? fetch(event.request)),
    );
    return;
  }

  // Everything else (HTML routes, hot-reload requests in dev) → network.
});
