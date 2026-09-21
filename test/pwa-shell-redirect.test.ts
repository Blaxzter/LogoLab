// The one service-worker bug that takes the whole site down.
//
//   node --test test/pwa-shell-redirect.test.ts
//
// A navigation may only be answered with a response that was not redirected.
// Hand `event.respondWith()` a redirected one and the browser does not fall back
// to the network — it fails the navigation, and the user gets Chrome's "This
// site can't be reached / ERR_FAILED" on every route, for as long as the worker
// is installed.
//
// Which is exactly what shipped. The shell is precached under `/index.html`, and
// the production host (Cloudflare Workers Assets) answers `/index.html` with a
// 307 to `/` to normalise the pretty URL. `cache.add` follows that redirect and
// stores a 200 with `redirected` set, and the navigate branch served it to every
// navigation from then on.
//
// Nothing about that is visible from outside the browser: the origin still
// answers 200 to every URL, the build is green, and the dev server and `vite
// preview` both serve `/index.html` directly, so it reproduces only against a
// host that redirects. Hence this test, which drives the REAL src/pwa/sw.js
// against a fetch that redirects the way production does.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** A response that reports itself as having followed a redirect. */
function redirectedTo(url: string, body: string, type = 'text/html'): Response {
  const response = new Response(body, { status: 200, headers: { 'Content-Type': type } })
  Object.defineProperty(response, 'redirected', { value: true })
  Object.defineProperty(response, 'url', { value: url })
  return response
}

/** Minimum viable CacheStorage: enough of the surface sw.js actually uses. */
class FakeCache {
  entries = new Map<string, Response>()

  fetchImpl: (request: Request) => Promise<Response>

  constructor(fetchImpl: (request: Request) => Promise<Response>) {
    this.fetchImpl = fetchImpl
  }

  /**
   * The real `Cache.add`: fetch, following redirects, and store the result under
   * the REQUEST's url. It does not reject a response that followed a redirect
   * and it does not strip the flag — which is the whole bug, so the fake has to
   * be faithful here or the test passes for the wrong reason.
   */
  async add(request: Request | string) {
    const req = typeof request === 'string' ? new Request(`https://logolab.test${request}`) : request
    const response = await this.fetchImpl(req)
    if (!response.ok) throw new TypeError('cache.add: not ok')
    await this.put(new URL(req.url).pathname, response)
  }

  async put(request: Request | string, response: Response) {
    this.entries.set(typeof request === 'string' ? request : new URL(request.url).pathname, response)
  }

  async match(request: Request | string) {
    const key = typeof request === 'string' ? request : new URL(request.url).pathname
    return this.entries.get(key)
  }

  async keys() {
    return [...this.entries.keys()].map((url) => new Request(`https://logolab.test${url}`))
  }

  async delete(request: Request | string) {
    return this.entries.delete(
      typeof request === 'string' ? request : new URL(request.url).pathname,
    )
  }
}

class FakeCaches {
  caches = new Map<string, FakeCache>()
  fetchImpl: (request: Request) => Promise<Response> = async () => new Response(null, { status: 504 })

  async open(name: string) {
    let cache = this.caches.get(name)
    if (!cache) this.caches.set(name, (cache = new FakeCache((r) => this.fetchImpl(r))))
    return cache
  }

  async keys() {
    return [...this.caches.keys()]
  }

  async delete(name: string) {
    return this.caches.delete(name)
  }

  async match(request: Request | string, options?: { cacheName?: string }) {
    const named = options?.cacheName ? [this.caches.get(options.cacheName)] : [...this.caches.values()]
    for (const cache of named) {
      const hit = await cache?.match(request)
      if (hit) return hit
    }
    return undefined
  }
}

interface Harness {
  install: () => Promise<void>
  navigate: (path: string) => Promise<Response | undefined>
  cachesApi: FakeCaches
  precacheName: string
  fetched: string[]
}

/**
 * Load the real worker source, fill in the two placeholders the build plugin
 * fills in, and run it against fakes.
 */
function loadWorker(options: {
  precache: string[]
  fetch: (request: Request) => Promise<Response>
}): Harness {
  const source = readFileSync(fileURLToPath(new URL('../src/pwa/sw.js', import.meta.url)), 'utf8')
    .replace(/^const BUILD = '__BUILD_ID__'$/m, `const BUILD = ${JSON.stringify('testbuild')}`)
    .replace(
      /^const PRECACHE_URLS = __PRECACHE__$/m,
      `const PRECACHE_URLS = ${JSON.stringify(options.precache)}`,
    )
  assert.ok(!source.includes('__BUILD_ID__'), 'BUILD placeholder moved; update this test')
  assert.ok(!source.includes('__PRECACHE__'), 'PRECACHE placeholder moved; update this test')

  const listeners = new Map<string, (event: unknown) => void>()
  const fetched: string[] = []
  const cachesApi = new FakeCaches()

  const self = {
    addEventListener: (type: string, handler: (event: unknown) => void) => {
      listeners.set(type, handler)
    },
    location: { origin: 'https://logolab.test' },
    clients: { claim: async () => {} },
    skipWaiting: async () => {},
  }

  const fetchImpl = async (request: Request | string) => {
    const req = typeof request === 'string' ? new Request(`https://logolab.test${request}`) : request
    fetched.push(new URL(req.url).pathname)
    return options.fetch(req)
  }
  cachesApi.fetchImpl = fetchImpl

  // A worker resolves a relative URL against its scope; node's Request wants an
  // absolute one, so give the worker source a constructor that does the same.
  const ScopedRequest = new Proxy(Request, {
    construct: (target, [input, init]: [RequestInfo, RequestInit?]) =>
      new target(
        typeof input === 'string' ? new URL(input, 'https://logolab.test').href : input,
        init,
      ),
  })

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('self', 'caches', 'fetch', 'Request', source)(self, cachesApi, fetchImpl, ScopedRequest)

  return {
    cachesApi,
    fetched,
    precacheName: 'logolab-precache-testbuild',
    install: async () => {
      let waited: Promise<unknown> = Promise.resolve()
      listeners.get('install')?.({ waitUntil: (p: Promise<unknown>) => (waited = p) })
      await waited
    },
    navigate: async (path: string) => {
      const request = new Request(`https://logolab.test${path}`)
      Object.defineProperty(request, 'mode', { value: 'navigate' })
      let answer: Promise<Response> | undefined
      listeners.get('fetch')?.({ request, respondWith: (p: Promise<Response>) => (answer = p) })
      return answer ? await answer : undefined
    },
  }
}

/** Production's behaviour: `/index.html` is normalised to `/` with a 307. */
const cloudflareLike = async (request: Request) => {
  const path = new URL(request.url).pathname
  if (path === '/index.html') return redirectedTo('https://logolab.test/', '<!doctype html>shell')
  return new Response('<!doctype html>shell', {
    status: 200,
    headers: { 'Content-Type': 'text/html' },
  })
}

test('the precached shell is stored without the redirect it followed', async () => {
  const worker = loadWorker({ precache: ['/index.html'], fetch: cloudflareLike })
  await worker.install()

  const shell = await worker.cachesApi.match('/index.html', { cacheName: worker.precacheName })
  assert.ok(shell, 'the shell was not precached at all')
  assert.equal(shell.status, 200)
  assert.equal(
    shell.redirected,
    false,
    'the shell was cached as a redirected response — every navigation will fail with ERR_FAILED',
  )
})

test('a navigation is answered with a response it is legal to answer with', async () => {
  const worker = loadWorker({ precache: ['/index.html'], fetch: cloudflareLike })
  await worker.install()

  for (const route of ['/', '/vectorize', '/sheet']) {
    const response = await worker.navigate(route)
    assert.ok(response, `no response for ${route}`)
    assert.equal(response.status, 200)
    assert.equal(response.redirected, false, `${route} was answered with a redirected response`)
  }
})

test('a redirected shell cached by an older worker is not served, it is bypassed', async () => {
  // Recovery, not prevention: this entry is already on disk in the wild. The
  // worker must not hand it to a navigation even though it is a valid 200.
  const worker = loadWorker({ precache: [], fetch: cloudflareLike })
  await worker.install()
  const precache = await worker.cachesApi.open(worker.precacheName)
  await precache.put('/index.html', redirectedTo('https://logolab.test/', '<!doctype html>stale'))

  const response = await worker.navigate('/vectorize')
  assert.ok(response)
  assert.equal(
    response.redirected,
    false,
    'the stale redirected shell was served — the site stays unreachable after the fix ships',
  )
  assert.ok(
    worker.fetched.includes('/vectorize'),
    'the worker should fall through to the network rather than serve a shell it cannot serve',
  )
})

test('an offline navigation with nothing cached still answers, rather than hanging', async () => {
  const worker = loadWorker({
    precache: [],
    fetch: async () => {
      throw new TypeError('offline')
    },
  })
  await worker.install()

  const response = await worker.navigate('/')
  assert.ok(response)
  assert.equal(response.status, 503)
})
