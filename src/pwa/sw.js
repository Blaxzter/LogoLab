/* eslint-env serviceworker */
//
// LogoLab's service worker.
//
// Read verbatim at build time by the `serviceWorker()` plugin (scripts/swPlugin.ts),
// which fills in the build id and the precache list below and emits it as /sw.js.
// It is plain JS on purpose: it never goes through the bundler, so there is
// nothing to compile and nothing that can silently pull an app module into
// worker scope.
//
// Why hand-written rather than Workbox: the caching decision here is not generic.
// A LogoLab build is ~31 MB of assets, and 27 MB of that is a research harness
// and an optional AI upscaler that a user cropping a logo will never open —
// precaching by glob would make installing the app a 31 MB download. What the
// app actually needs offline is a few megabytes, and which few is a question
// about this codebase's structure (see the plugin: it reads the module graph),
// not about file extensions.
//
// The shape:
//   • PRECACHE — the app shell and every chunk the normal tabs reach, stored on
//     install, keyed by build. This is what "works offline" means here.
//   • RUNTIME  — everything else same-origin, cached the first time it is
//     actually fetched. A user who opens the labs or the AI upscaler once has
//     them offline too, without everyone paying for them up front.
//   • Cross-origin is never touched. The model weights come from a CDN and are
//     megabytes each; their own HTTP caching is better at this than we are.

const BUILD = '__BUILD_ID__'
const PRECACHE_URLS = __PRECACHE__

const PRECACHE = `logolab-precache-${BUILD}`
const RUNTIME = 'logolab-runtime'

/** The offline shell. Every in-app route is this one document (SPA). */
const SHELL = '/index.html'

/**
 * Runtime-cache ceiling. Above this a response is served but not stored: the
 * 23 MB onnxruntime binary would otherwise evict the entire rest of the cache
 * the first time someone tries the AI upscaler.
 */
const MAX_RUNTIME_BYTES = 12 * 1024 * 1024

/** Entries kept in the runtime cache; oldest evicted first (insertion order). */
const MAX_RUNTIME_ENTRIES = 80

/**
 * Match options used for EVERY lookup here. `ignoreVary` is not a nicety.
 *
 * A precache entry is stored against a Request this worker built from a URL
 * string, which carries no `Origin` header. A module script — every lazily
 * loaded tab, and the tracer's worker — is fetched in CORS mode and does carry
 * one. Servers that answer with `Vary: Origin` (Vite's preview does; a CDN may)
 * therefore make the two representations non-equivalent, and the lookup misses
 * something that is sitting right there: online it silently refetches, offline
 * the tab just fails to open.
 *
 * Ignoring Vary is correct for this cache because every URL in it has exactly
 * one representation — the build assets are content-hashed, so the URL already
 * is the version.
 */
const MATCH = { ignoreVary: true }

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(PRECACHE)
      // One request at a time rather than cache.addAll: addAll is all-or-nothing,
      // so a single 404 (a renamed example, a stale entry in the list) would fail
      // the whole install and leave the app with no offline support at all.
      // `cache: 'reload'` bypasses the HTTP cache so a precache can never store
      // the previous build's bytes under the new build's URL.
      await Promise.all(
        PRECACHE_URLS.map(async (url) => {
          try {
            await cache.add(new Request(url, { cache: 'reload' }))
          } catch {
            /* skip this one; the runtime cache picks it up on first use */
          }
        }),
      )
      // Deliberately no skipWaiting() here: the new worker waits until the page
      // asks for it (see the SKIP_WAITING message below). Swapping the build out
      // from under a running trace — or a half-finished node edit — to save one
      // click is the wrong trade.
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

// The page's "Reload" button on the update toast. Taking over is the page's
// call, not ours — see the install handler.
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') void self.skipWaiting()
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  // Cross-origin (the CDN model weights, fonts) is left to the browser. A
  // service worker that intercepts those inherits their opaque responses and
  // their multi-megabyte bodies, and gains nothing.
  if (url.origin !== self.location.origin) return

  // Every route is the same SPA document, so a navigation is answered from the
  // shell. Cache-first, because the shell and the hashed chunks it names are one
  // versioned set: revalidating the document alone could hand a returning user
  // an index.html pointing at chunks this cache no longer has.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const shell = await caches.match(SHELL, { ...MATCH, cacheName: PRECACHE })
        if (shell) return shell
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
 * Cache-first for same-origin assets.
 *
 * Safe as a blanket rule because every build asset carries a content hash in its
 * name: the URL *is* the version, so a cached hit can never be stale. The few
 * unhashed ones (icons, examples, mockups) are re-fetched on install, keyed by
 * the build.
 */
async function serveAsset(request) {
  const hit = await caches.match(request, MATCH)
  if (hit) return hit

  let response
  try {
    response = await fetch(request)
  } catch {
    // Offline and never seen: let the caller's own error path handle it. The
    // studios already degrade when an optional chunk won't load.
    return Response.error()
  }

  // Only full, successful, same-origin responses are worth keeping. `type` rules
  // out opaque redirects; 206 rules out range requests, which cache badly.
  //
  // The HTML check is the important one. This app is served with an SPA
  // fallback, so a request for an asset that ISN'T there comes back as 200
  // index.html rather than 404 — and caching that under a `.js` URL poisons the
  // cache with a document the browser will then try to execute, permanently and
  // offline. A navigation is the only request that should ever answer in HTML,
  // and navigations don't come through here.
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
          /* quota — serving the response still worked, which is the job */
        }
      })()
    }
  }
  return response
}

/** Keep the runtime cache bounded. `keys()` is insertion-ordered, so the front
 *  of the list is the oldest thing in there. */
async function trimRuntime(cache) {
  const keys = await cache.keys()
  if (keys.length <= MAX_RUNTIME_ENTRIES) return
  for (const key of keys.slice(0, keys.length - MAX_RUNTIME_ENTRIES)) {
    await cache.delete(key)
  }
}
