// The report has to survive the thing it is reporting.
//
//   node --test test/issue-report.test.ts
//
// Three things are being pinned here, and none of them is visible in a
// screenshot of the crash screen:
//
//   1. The LINK works. GitHub answers a request line past ~8 kB with a 414, and
//      a React stack on a deep canvas tree is easily that long on its own — so a
//      report that is merely "complete" turns "Report an issue" into a dead
//      button on exactly the failures worth reporting. It must cut itself down,
//      and it must cut the STACK rather than the options, because the options
//      are the half nobody can reconstruct from a prose bug report.
//   2. Nothing here throws. It runs after something has already gone wrong, over
//      live studio state that is itself suspect — a cycle, a getter that throws,
//      a `throw 'nope'` that was never an Error. A second failure at this point
//      puts the user back in front of the blank page the boundary prevents.
//   3. The user's ART never leaves. The app's whole pitch is that the image
//      stays in the browser, and an error message that quotes a `data:` URL is
//      the one path by which a report could carry the pixels to a public issue
//      tracker without anyone intending it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  URL_BUDGET,
  diagnosticsText,
  errorLabel,
  isChunkLoadError,
  issueReportTitle,
  issueReportUrl,
  summaryText,
  type IssueReportInput,
} from '../src/lib/report/issueReport.ts'
import {
  clearReportContext,
  collectReportContext,
  provideReportContext,
} from '../src/lib/report/reportContext.ts'
import { clearErrorLog, logError, recentErrors } from '../src/lib/report/errorLog.ts'

const REPO = 'https://github.com/Blaxzter/LogoLab'

/** A crash in the vectorizer, with the kind of context the studio publishes. */
function crash(over: Partial<IssueReportInput> = {}): IssueReportInput {
  const error = new TypeError("Cannot read properties of undefined (reading 'x')")
  error.stack = `TypeError: Cannot read properties of undefined (reading 'x')\n    at planarBeautify (trace/planarBeautify.ts:412:18)\n    at traceImage (trace/index.ts:88:9)`
  return {
    repoUrl: REPO,
    what: 'the vectorizer',
    kind: 'crash',
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

test('the diagnostics carry what a maintainer cannot guess: options, engine, image, build, stack', () => {
  const text = diagnosticsText(crash())
  assert.match(text, /"engine": "planar"/, 'the engine is the first thing asked about')
  assert.match(text, /"smoothing": 50/)
  assert.match(text, /"width": 512/)
  assert.match(text, /planarBeautify/, 'the stack')
  assert.match(text, /in EditorCanvas/, 'the component stack')
  assert.match(text, /LogoLab v0\.1\.1/, 'which build it was')
  assert.match(text, /logolab\.pages\.dev\/vectorize/)
})

test('the diagnostics are PLAIN text — the field renders them in a code block', () => {
  const text = diagnosticsText(crash())
  assert.doesNotMatch(text, /```/, 'a fence inside a render:text field is literal backticks')
  assert.doesNotMatch(text, /^### /m, 'markdown headings would print as hashes')
  assert.doesNotMatch(text, /^\|/m, 'a markdown table would print as pipes')
})

test('the human half is left to the human, and the form asks for it', () => {
  // The app writes what it knows; the "what did you expect" box stays empty,
  // because a prefilled box is one the user has to clear before they can type.
  assert.match(summaryText(crash()), /The vectorizer crashed while rendering/)
  assert.equal(summaryText(crash({ kind: 'problem' })), '')
  assert.equal(summaryText(crash({ kind: 'idea' })), '')
})

test('the right form for the right kind', () => {
  const template = (k: IssueReportInput['kind']) =>
    new URL(issueReportUrl(crash({ kind: k }))).searchParams.get('template')
  assert.equal(template('crash'), 'bug_report.yml')
  assert.equal(template('failure'), 'bug_report.yml')
  assert.equal(template('problem'), 'bug_report.yml')
  assert.equal(template('idea'), 'feature_request.yml', 'an idea is not a bug')
})

test('the title is one readable line, capped', () => {
  assert.equal(
    issueReportTitle(crash()),
    "[bug] Crash in the vectorizer: TypeError: Cannot read properties of undefined (reading 'x')",
  )
  const long = issueReportTitle(crash({ error: new Error('x'.repeat(400)) }))
  assert.ok(long.length <= 120, `title is ${long.length} chars`)
  assert.match(long, /…$/)
})

test('a report with no context or build still reads as a report', () => {
  const input = { repoUrl: REPO, what: 'the editor', error: new Error('boom') }
  assert.match(summaryText(input), /The editor crashed while rendering/)
  assert.doesNotMatch(diagnosticsText(input), /Working on/, 'no empty sections')
})

test('the user titles their own problem or idea — the form prefix stands', () => {
  assert.equal(issueReportTitle(crash({ kind: 'problem' })), '')
  assert.equal(issueReportTitle(crash({ kind: 'idea' })), '')
  assert.equal(
    new URL(issueReportUrl(crash({ kind: 'idea' }))).searchParams.has('title'),
    false,
    'an empty title would wipe the prefix the form declares',
  )
})

/* ------------------------------------------------------------------- kinds */

test('a handled failure says so, and does not claim the app crashed', () => {
  const input = crash({ kind: 'failure', componentStack: null })
  assert.match(issueReportTitle(input), /^\[bug\] The vectorizer failed: TypeError/)
  assert.match(summaryText(input), /The vectorizer reported a failure/)
  assert.doesNotMatch(summaryText(input), /crashed while rendering/)
  assert.match(
    diagnosticsText(input),
    /"engine": "planar"/,
    'a failure carries the same options a crash does',
  )
})

test('a problem carries the settings but invents no words of its own', () => {
  const problem: IssueReportInput = {
    repoUrl: REPO,
    what: 'LogoLab',
    kind: 'problem',
    context: { vectorize: { options: { engine: 'planar' } } },
    build: { version: '0.1.1', date: '', commit: '' },
  }
  assert.equal(summaryText(problem), '', 'nothing threw — there is nothing to quote')
  assert.match(diagnosticsText(problem), /"engine": "planar"/, 'the settings still come along')
  assert.doesNotMatch(diagnosticsText(problem), /Stack/)
})

/* --------------------------------------------------------------------- log */

test('the session log rides along, oldest first, with repeats collapsed', () => {
  clearErrorLog()
  logError('trace', new Error('worker died'))
  logError('trace', new Error('worker died'))
  logError('upload', new Error('decode failed'))
  const text = diagnosticsText(crash({ log: recentErrors() }))
  assert.match(text, /Other errors this session/)
  assert.match(text, /trace {2}Error: worker died {2}\(×2/, 'collapsed, with a count')
  assert.match(text, /upload {2}Error: decode failed/)
  clearErrorLog()
})

test('an empty log is left out rather than printed as an empty block', () => {
  clearErrorLog()
  assert.doesNotMatch(diagnosticsText(crash({ log: recentErrors() })), /Other errors this session/)
})

/* ---------------------------------------------------------------------- URL */

test('the link stays inside the budget however deep the stack is', () => {
  const deep = new Error('render loop')
  deep.stack = `Error: render loop\n${Array.from({ length: 4000 }, (_, i) => `    at frame${i} (chunk-9c2f.js:${i}:${i})`).join('\n')}`
  const url = issueReportUrl(crash({ error: deep }))
  assert.ok(url.length <= URL_BUDGET, `URL is ${url.length} chars — GitHub answers that with a 414`)
  assert.ok(url.startsWith(`${REPO}/issues/new?template=bug_report.yml`))
})

test('a kilobyte-long error message cannot blow the link up on its own', () => {
  // The title and the summary are the FIXED half of the URL — only Diagnostics
  // is fitted — so an unbounded message here would be unbudgetable.
  const shouty = new Error('x'.repeat(20_000))
  const url = issueReportUrl(crash({ error: shouty }))
  assert.ok(url.length <= URL_BUDGET, `URL is ${url.length} chars`)
  assert.ok(decodeURIComponent(url).includes('…'), 'cut, and says so')
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
  const url = issueReportUrl(crash({ error: wide }))
  assert.ok(url.length <= URL_BUDGET, `URL is ${url.length} chars`)
  const body = decodeURIComponent(url.slice(url.indexOf('&body=') + 6))
  assert.match(body, /"engine": "planar"/, 'the options are the part worth the budget')
  assert.match(body, /cut to fit the link/, 'and it says that it was cut')
  // A cut inside a fenced block would code-block everything after it on GitHub.
  assert.equal((body.match(/^```/gm) ?? []).length % 2, 0, 'left a code fence open')
})

test('a budget too small for anything still yields a usable link', () => {
  // Below the fixed head there is nothing left to give: the answer is a link to
  // the right form with an empty Diagnostics box, never a broken URL.
  const url = issueReportUrl(crash(), 200)
  assert.ok(url.startsWith(`${REPO}/issues/new?template=bug_report.yml`))
  assert.equal(new URL(url).searchParams.get('diagnostics'), null)
  assert.doesNotThrow(() => new URL(url))
})

test('a stack full of astral characters does not blow up the encoder', () => {
  const emoji = new Error('💥 boom')
  emoji.stack = `Error: 💥\n${'    at 🤖🤖🤖 (x.js)\n'.repeat(2000)}`
  const url = issueReportUrl(crash({ error: emoji }))
  assert.ok(url.length <= URL_BUDGET)
  assert.doesNotThrow(() => decodeURIComponent(url), 'a surrogate pair was cut in half')
})

/* ----------------------------------------------------------------- privacy */

test("the user's image never reaches the report, however it got into the error", () => {
  const pixels = `data:image/png;base64,${'iVBORw0KGgoAAAANS'.repeat(40)}`
  const leaky = new Error(`Failed to decode ${pixels}`)
  leaky.stack = `Error: Failed to decode ${pixels}\n    at loadLogoFile (lib/image.ts:12:3)`
  const input = crash({
    kind: 'failure',
    error: leaky,
    href: `https://logolab.pages.dev/vectorize#${pixels}`,
    context: { image: { src: pixels, width: 512 } },
  })
  const text = `${summaryText(input)}
${diagnosticsText(input)}`
  assert.doesNotMatch(text, /iVBORw0KGgo/, 'base64 image bytes in a public issue')
  assert.match(text, /data:…/, 'redacted, not silently dropped')
  assert.match(text, /"width": 512/, 'the SHAPE of the art still goes')
  assert.doesNotMatch(issueReportTitle(crash({ error: leaky })), /iVBORw0KGgo/)
})

/* ------------------------------------------------------ hostile input */

test('something that was never an Error still produces a report', () => {
  assert.equal(errorLabel('nope'), 'nope')
  assert.equal(errorLabel({ code: 7 }), '{"code":7}')
  assert.equal(errorLabel(undefined), 'undefined')
  const input = crash({ error: 'nope', componentStack: null })
  assert.match(summaryText(input), /nope/)
  assert.doesNotMatch(diagnosticsText(input), /^Stack$/m, 'a string has no stack to print')
})

test('a cycle in the context is described, not thrown over', () => {
  const cyclic: Record<string, unknown> = { options: { engine: 'planar' } }
  cyclic.self = cyclic
  const text = diagnosticsText(crash({ context: cyclic }))
  assert.match(text, /"engine": "planar"/)
  assert.match(text, /<circular>/)
})

test('a sub-object referenced twice is not a cycle and prints normally', () => {
  const shared = { engine: 'planar' }
  const text = diagnosticsText(crash({ context: { a: shared, b: shared } }))
  assert.equal((text.match(/"engine": "planar"/g) ?? []).length, 2)
  assert.doesNotMatch(text, /<circular>/)
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
  clearReportContext()
  provideReportContext('image', () => ({ width: 512 }))
  provideReportContext('vectorize', () => ({ engine: 'planar' }))
  assert.deepEqual(collectReportContext(), {
    image: { width: 512 },
    vectorize: { engine: 'planar' },
  })
  clearReportContext()
})

test('a provider that throws costs its own entry, not the whole report', () => {
  clearReportContext()
  provideReportContext('bad', () => {
    throw new Error('state is gone')
  })
  provideReportContext('good', () => ({ engine: 'planar' }))
  const collected = collectReportContext()
  assert.deepEqual(collected.good, { engine: 'planar' })
  assert.match(String(collected.bad), /state is gone/)
  clearReportContext()
})

test('unregistering removes it — which is why a boundary must collect before the unmount', () => {
  clearReportContext()
  const off = provideReportContext('vectorize', () => ({ engine: 'planar' }))
  off()
  assert.deepEqual(collectReportContext(), {})
  clearReportContext()
})

test('a remount does not delete the provider the newer instance just registered', () => {
  // React mounts the replacement before running the old instance's cleanup, so a
  // blind `delete` on unmount would leave the live studio unable to report.
  clearReportContext()
  const off = provideReportContext('vectorize', () => ({ instance: 'old' }))
  provideReportContext('vectorize', () => ({ instance: 'new' }))
  off()
  assert.deepEqual(collectReportContext(), { vectorize: { instance: 'new' } })
  clearReportContext()
})
