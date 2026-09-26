/* eslint-env serviceworker */
//
// LogoLab's service worker.
//
// Plain JS, read verbatim by the build plugin (scripts/swPlugin.ts), which fills
// in the build id and precache list and emits /sw.js. It never goes through the
// bundler, so no app module can leak into worker scope.
//
// The precache list is computed from the module graph, not globbed: most of the
// build is the research labs and the optional AI runtime, which a normal user
// never opens.
//
// Caches:
//  - precache: the shell and every chunk the normal tabs reach, per build.
//  - runtime: other same-origin assets, cached on first fetch.
//  - Cross-origin requests (CDN model weights, fonts) are not intercepted.

const BUILD = '__BUILD_ID__'
const PRECACHE_URLS = __PRECACHE__

const PRECACHE = `logolab-precache-${BUILD}`
const RUNTIME = 'logolab-runtime'

/** The offline shell. Every in-app route is this one document (SPA). */
const SHELL = '/index.html'

/**
 * Runtime-cache ceiling. Larger responses are served but not stored, so one huge
 * binary (e.g. the ONNX runtime) cannot evict the rest of the cache.
 */
const MAX_RUNTIME_BYTES = 12 * 1024 * 1024

/** Entries kept in the runtime cache; oldest evicted first (insertion order). */
const MAX_RUNTIME_ENTRIES = 80

/**
 * Match options for every lookup. Don't drop `ignoreVary`: precache entries are
 * stored without an `Origin` header, but module scripts are fetched in CORS mode
 * with one, so a `Vary: Origin` response would never match and lazy tabs would
 * fail offline. Safe because every cached URL has exactly one representation.
 */
const MATCH = { ignoreVary: true }

/**
 * Clear a response's `redirected` flag by rebuilding it (same body, status and
 * headers).
 *
 * Never answer a navigation with a redirected response: the browser fails the
 * navigation ("This site can't be reached / ERR_FAILED") on every route while
 * the worker is installed. The production host (Cloudflare Workers Assets)
 * redirects `/index.html` to `/`, so the fetched shell is always redirected.
 * Local dev and preview servers do not redirect, so this only shows up on the
 * deployed host.
 */
async function unredirected(response) {
  if (!response.redirected) return response
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(PRECACHE)
      // Per-URL fetch + put instead of cache.addAll/add: addAll fails the whole
      // install on one 404, and add would store a redirected shell (see
      // `unredirected`). `cache: 'reload'` bypasses the HTTP cache so a stale
      // copy is never stored under this build.
      await Promise.all(
        PRECACHE_URLS.map(async (url) => {
          try {
            const response = await fetch(new Request(url, { cache: 'reload' }))
            if (!response.ok) throw new Error(`precache ${url}: ${response.status}`)
            await cache.put(url, await unredirected(response))
          } catch {
            /* skip this one; the runtime cache picks it up on first use */
          }
        }),
      )
      // No skipWaiting() here: the new worker waits until the page asks (the
      // SKIP_WAITING message), so a running trace or edit is never swapped out.
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(
        keys
          .filter((key) => key.startsWith('logolab-precache-') && key !== PRECACHE)
          .map((key) => caches.delete(key)),
      )
      await self.clients.claim()
    })(),
  )
})

// Sent by the update toast's "Reload" button.
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') void self.skipWaiting()
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  // Cross-origin requests are left to the browser's own HTTP cache.
  if (url.origin !== self.location.origin) return

  // Every route is the SPA shell. Cache-first, because the shell and the hashed
  // chunks it references are one versioned set; a fresher index.html could point
  // at chunks this cache lacks.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const shell = await caches.match(SHELL, { ...MATCH, cacheName: PRECACHE })
        // Also refuse a redirected hit: shells cached by older workers may still
        // be redirected, and serving one takes the whole site down (see
        // `unredirected`). The network fallback keeps the app reachable.
        if (shell && !shell.redirected) return shell
        try {
          return await fetch(request)
        } catch {
          return new Response('Offline, and this build was never cached.', {
            status: 503,
            headers: { 'Content-Type': 'text/plain' },
          })
        }
      })(),
    )
    return
  }

  event.respondWith(serveAsset(request))
})

/**
 * Cache-first for same-origin assets. Safe because build assets are
 * content-hashed; the few unhashed ones are re-fetched into each build's
 * precache.
 */
async function serveAsset(request) {
  const hit = await caches.match(request, MATCH)
  if (hit) return hit

  let response
  try {
    response = await fetch(request)
  } catch {
    // Offline and uncached: let the caller's error path handle it.
    return Response.error()
  }

  // Only cache full, successful, same-origin, non-HTML responses. Don't drop
  // the HTML check: the SPA fallback answers a missing asset with 200
  // index.html, and caching that under a `.js` URL poisons the cache.
  const contentType = response.headers.get('content-type') ?? ''
  if (
    response.ok &&
    response.type === 'basic' &&
    response.status === 200 &&
    !contentType.startsWith('text/html')
  ) {
    const length = Number(response.headers.get('content-length') ?? 0)
    if (length <= MAX_RUNTIME_BYTES) {
      const copy = response.clone()
      void (async () => {
        try {
          const cache = await caches.open(RUNTIME)
          await cache.put(request, copy)
          await trimRuntime(cache)
        } catch {
          /* quota exceeded; the response was still served */
        }
      })()
    }
  }
  return response
}

/** Keep the runtime cache bounded; `keys()` is insertion-ordered, oldest first. */
async function trimRuntime(cache) {
  const keys = await cache.keys()
  if (keys.length <= MAX_RUNTIME_ENTRIES) return
  for (const key of keys.slice(0, keys.length - MAX_RUNTIME_ENTRIES)) {
    await cache.delete(key)
  }
}
