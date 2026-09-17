// The crash screen's report has to survive the crash.
//
//   node --test test/crash-report.test.ts
//
// Two things are being pinned here, and neither is visible in a screenshot of the
// crash screen:
//
//   1. The LINK works. GitHub answers a request line past ~8 kB with a 414, and a
//      React stack on a deep canvas tree is easily that long on its own — so a
//      report that is merely "complete" turns "Report an issue" into a dead
//      button on exactly the crashes worth reporting. It must cut itself down,
//      and it must cut the STACK rather than the options, because the options are
//      the half nobody can reconstruct from a prose bug report.
//   2. Nothing here throws. It runs after something has already gone wrong, over
//      live studio state that is itself suspect — a cycle, a getter that throws, a
//      `throw 'nope'` that was never an Error. A second failure at this point puts
//      the user back in front of the blank page the boundary exists to prevent.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  URL_BUDGET,
  crashReportBody,
  crashReportTitle,
  crashReportUrl,
  errorLabel,
  isChunkLoadError,
  type CrashReportInput,
} from '../src/lib/crashReport.ts'
import {
  clearCrashContext,
  collectCrashContext,
  provideCrashContext,
} from '../src/lib/crashContext.ts'

const REPO = 'https://github.com/Blaxzter/LogoLab'

/** A crash in the vectorizer, with the kind of context the studio publishes. */
function crash(over: Partial<CrashReportInput> = {}): CrashReportInput {
  const error = new TypeError("Cannot read properties of undefined (reading 'x')")
  error.stack = `TypeError: Cannot read properties of undefined (reading 'x')\n    at planarBeautify (trace/planarBeautify.ts:412:18)\n    at traceImage (trace/index.ts:88:9)`
  return {
    repoUrl: REPO,
    what: 'the vectorizer',
    error,
    componentStack: '\n    in EditorCanvas\n    in VectorizeStudio\n    in ErrorBoundary',
    context: {
      image: { width: 512, height: 512, type: 'image/png', isSvg: false },
      vectorize: {
        options: { mode: 'color', engine: 'planar', smoothing: 50, despeckle: 25, fidelity: 1.5 },
      },
    },
    build: { version: '0.1.1', date: '2026-09-13T14:26:20+02:00', commit: '6a1dc5b' },
    href: 'https://logolab.pages.dev/vectorize',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    ...over,
  }
}

/* ------------------------------------------------------------------- report */

test('the report carries what a maintainer cannot guess: options, engine, image, build, stack', () => {
  const body = crashReportBody(crash())
  assert.match(body, /"engine": "planar"/, 'the engine is the first thing asked about')
  assert.match(body, /"smoothing": 50/)
  assert.match(body, /"width": 512/)
  assert.match(body, /planarBeautify/, 'the stack')
  assert.match(body, /in EditorCanvas/, 'the component stack')
  assert.match(body, /LogoLab v0\.1\.1/, 'which build it was')
  assert.match(body, /logolab\.pages\.dev\/vectorize/)
})

test('the report asks for the one thing it cannot collect', () => {
  const body = crashReportBody(crash())
  assert.match(body, /### What I was doing/)
  // And says out loud that nothing has been sent — it is a draft in the user's
  // own browser until they press the button on GitHub.
  assert.match(body, /Nothing has been sent anywhere/i)
})

test('the title is one readable line, capped', () => {
  assert.equal(
    crashReportTitle(crash()),
    "Crash in the vectorizer: TypeError: Cannot read properties of undefined (reading 'x')",
  )
  const long = crashReportTitle(crash({ error: new Error('x'.repeat(400)) }))
  assert.ok(long.length <= 120, `title is ${long.length} chars`)
  assert.match(long, /…$/)
})

test('a report with no context or build still reads as a report', () => {
  const body = crashReportBody({ repoUrl: REPO, what: 'the editor', error: new Error('boom') })
  assert.match(body, /The editor crashed while rendering/)
  assert.doesNotMatch(body, /### Where/, 'an empty table is worse than no table')
  assert.doesNotMatch(body, /### What it was working on/)
})

/* ---------------------------------------------------------------------- URL */

test('the link stays inside the budget however deep the stack is', () => {
  const deep = new Error('render loop')
  deep.stack = `Error: render loop\n${Array.from({ length: 4000 }, (_, i) => `    at frame${i} (chunk-9c2f.js:${i}:${i})`).join('\n')}`
  const url = crashReportUrl(crash({ error: deep }))
  assert.ok(url.length <= URL_BUDGET, `URL is ${url.length} chars — GitHub answers that with a 414`)
  assert.ok(url.startsWith(`${REPO}/issues/new?labels=bug&title=`))
})

test('when it has to cut, it cuts the stack and keeps the options', () => {
  // WIDE frames, not deep ones. The per-section clip already handles depth, so
  // what is left to blow the budget is a bundle whose frames are hundreds of
  // columns of minified path each — which is what a production stack looks like.
  const wide = new Error('render loop')
  wide.stack = `Error: render loop\n${Array.from(
    { length: 40 },
    (_, i) => `    at ${'m'.repeat(300)}${i} (chunk-9c2f.js)`,
  ).join('\n')}`
  const url = crashReportUrl(crash({ error: wide }))
  assert.ok(url.length <= URL_BUDGET, `URL is ${url.length} chars`)
  const body = decodeURIComponent(url.slice(url.indexOf('&body=') + 6))
  assert.match(body, /"engine": "planar"/, 'the options are the part worth the budget')
  assert.match(body, /cut to fit the link/, 'and it says that it was cut')
  // A cut inside a fenced block would code-block everything after it on GitHub.
  assert.equal((body.match(/^```/gm) ?? []).length % 2, 0, 'left a code fence open')
})

test('a budget too small for anything degrades to a bare link, not a broken one', () => {
  const url = crashReportUrl(crash(), 200)
  assert.ok(url.length <= 200 + 40, 'the head alone is allowed to exceed a nonsense budget')
  assert.ok(url.includes('/issues/new?'), 'still a usable link')
})

test('a stack full of astral characters does not blow up the encoder', () => {
  const emoji = new Error('💥 boom')
  emoji.stack = `Error: 💥\n${'    at 🤖🤖🤖 (x.js)\n'.repeat(2000)}`
  const url = crashReportUrl(crash({ error: emoji }))
  assert.ok(url.length <= URL_BUDGET)
  assert.doesNotThrow(() => decodeURIComponent(url), 'a surrogate pair was cut in half')
})

/* ------------------------------------------------------ hostile input */

test('something that was never an Error still produces a report', () => {
  assert.equal(errorLabel('nope'), 'nope')
  assert.equal(errorLabel({ code: 7 }), '{"code":7}')
  assert.equal(errorLabel(undefined), 'undefined')
  const body = crashReportBody(crash({ error: 'nope', componentStack: null }))
  assert.match(body, /nope/)
  assert.doesNotMatch(body, /### Stack/, 'a string has no stack to print')
})

test('a cycle in the context is described, not thrown over', () => {
  const cyclic: Record<string, unknown> = { options: { engine: 'planar' } }
  cyclic.self = cyclic
  const body = crashReportBody(crash({ context: cyclic }))
  assert.match(body, /"engine": "planar"/)
  assert.match(body, /<circular>/)
})

test('a sub-object referenced twice is not a cycle and prints normally', () => {
  const shared = { engine: 'planar' }
  const body = crashReportBody(crash({ context: { a: shared, b: shared } }))
  assert.equal((body.match(/"engine": "planar"/g) ?? []).length, 2)
  assert.doesNotMatch(body, /<circular>/)
})

test('a chunk that never loaded is told apart from a crash in the code that did', () => {
  assert.ok(
    isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: /assets/x.js')),
  )
  assert.ok(isChunkLoadError(new Error('error loading dynamically imported module')))
  assert.ok(isChunkLoadError(new Error('Importing a module script failed.')))
  assert.equal(isChunkLoadError(new TypeError('x is not a function')), false)
})

/* ------------------------------------------------------------------ context */

test('providers are collected under their own key', () => {
  clearCrashContext()
  provideCrashContext('image', () => ({ width: 512 }))
  provideCrashContext('vectorize', () => ({ engine: 'planar' }))
  assert.deepEqual(collectCrashContext(), {
    image: { width: 512 },
    vectorize: { engine: 'planar' },
  })
  clearCrashContext()
})

test('a provider that throws costs its own entry, not the whole report', () => {
  clearCrashContext()
  provideCrashContext('bad', () => {
    throw new Error('state is gone')
  })
  provideCrashContext('good', () => ({ engine: 'planar' }))
  const collected = collectCrashContext()
  assert.deepEqual(collected.good, { engine: 'planar' })
  assert.match(String(collected.bad), /state is gone/)
  clearCrashContext()
})

test('unregistering removes it — which is why a boundary must collect before the unmount', () => {
  clearCrashContext()
  const off = provideCrashContext('vectorize', () => ({ engine: 'planar' }))
  off()
  assert.deepEqual(collectCrashContext(), {})
  clearCrashContext()
})

test('a remount does not delete the provider the newer instance just registered', () => {
  // React mounts the replacement before running the old instance's cleanup, so a
  // blind `delete` on unmount would leave the live studio unable to report.
  clearCrashContext()
  const off = provideCrashContext('vectorize', () => ({ instance: 'old' }))
  provideCrashContext('vectorize', () => ({ instance: 'new' }))
  off()
  assert.deepEqual(collectCrashContext(), { vectorize: { instance: 'new' } })
  clearCrashContext()
})
