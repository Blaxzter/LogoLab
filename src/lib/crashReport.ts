// A crash, turned into something a stranger can act on.
//
// The tracer is ~16k lines of numerical geometry running on whatever image a
// user happens to drop in, and its hard cases are exactly the ones nobody can
// reproduce from a prose bug report: "it broke on my logo" names neither the art
// nor the twenty options that were set when it broke. So the crash screen does
// not merely apologise — it offers a GitHub issue with the options JSON, the
// image's shape, the build and the stack already written into it.
//
// Everything here is PURE and free of React, of the DOM and of any global: the
// build stamp, the page URL, the browser string and the context all arrive as
// arguments. That is what lets the whole report be asserted in a node test
// (test/crash-report.test.ts) instead of only ever being seen on the day
// something breaks — which is the worst possible moment to discover that the
// link came out 20 kB long and GitHub answers it with a 414.

import { BUILD, buildTitle, type BuildInfo } from './buildInfo.ts'

/** Everything a report is made of. Only `repoUrl`, `what` and `error` are required. */
export interface CrashReportInput {
  /** Repository the issue is filed against, e.g. `https://github.com/org/repo`. */
  repoUrl: string
  /** What crashed, in the app's own words and lower case: `the vectorizer`. */
  what: string
  /** Whatever was thrown. Usually an Error; a stray `throw 'nope'` also lands here. */
  error: unknown
  /** React's `info.componentStack`, when the boundary got one. */
  componentStack?: string | null
  /** What the panels were working on — see ./crashContext. */
  context?: Record<string, unknown> | null
  /** Which build this is. Defaults to the one baked into the bundle. */
  build?: BuildInfo
  /** `location.href` at the time of the crash. */
  href?: string
  /** `navigator.userAgent`. */
  userAgent?: string
}

/** Issue titles are one line in a list — past this they are noise. */
const MAX_TITLE = 120
/** Stack depth worth carrying. The frames that matter are at the top. */
const STACK_LINES = 30
const COMPONENT_STACK_LINES = 20
/** A single bundled frame can be thousands of columns wide. */
const MAX_LINE = 200
/** The options JSON can carry a locked palette and a marker list. */
const MAX_CONTEXT_CHARS = 2400

/**
 * How long the whole `issues/new` URL may get.
 *
 * GitHub answers a request line past roughly 8 kB with a 414 and no explanation,
 * which would turn "Report an issue" into a dead button at exactly the moment it
 * is needed. 6.5 kB leaves room for whatever proxy sits in between, and the
 * crash screen's Copy button still carries the untruncated report.
 */
export const URL_BUDGET = 6500

const TRUNCATED =
  '\n\n_(cut to fit the link — use "Copy report" on the crash screen for the whole thing.)_'

/** `TypeError: x is not a function`, for anything at all that was thrown. */
export function errorLabel(error: unknown): string {
  if (error instanceof Error) {
    const name = error.name || 'Error'
    return error.message ? `${name}: ${error.message}` : name
  }
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error) ?? String(error)
  } catch {
    return String(error)
  }
}

/** The thrown value's own stack, or '' when what was thrown is not an Error. */
export function errorStack(error: unknown): string {
  return error instanceof Error && typeof error.stack === 'string' ? error.stack.trim() : ''
}

/**
 * A failed dynamic import, rather than a crash inside the code that was loaded.
 *
 * Worth telling apart because the remedy is the opposite one: the panel's code
 * never arrived (a deploy replaced the chunk under an open tab, or the network
 * dropped), so remounting the subtree cannot help — `React.lazy` caches the
 * rejection and re-throws it forever. Only a reload fetches new files. The
 * wording differs per browser, so this matches several.
 */
export function isChunkLoadError(error: unknown): boolean {
  return /dynamically imported module|importing a module script failed|chunkloaderror|loading chunk \S+ failed|failed to load module script/i.test(
    errorLabel(error),
  )
}

/** `the vectorizer` → `The vectorizer`, so it can start a sentence. */
function sentence(what: string): string {
  return what.charAt(0).toUpperCase() + what.slice(1)
}

/** Long lines shortened, deep stacks cut to the frames anyone reads. */
function clip(text: string, maxLines: number): string {
  const lines = text
    .split('\n')
    .map((line) => (line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line))
  if (lines.length <= maxLines) return lines.join('\n')
  return [...lines.slice(0, maxLines), `… ${lines.length - maxLines} more`].join('\n')
}

/**
 * JSON that cannot throw.
 *
 * The context is live studio state, so it can hold anything: a cycle, a typed
 * array, a BigInt. A report that dies while describing a crash leaves the user
 * with nothing, so the plain path is tried first — a sub-object referenced twice
 * is NOT a cycle and should print normally — and the ancestor-tracking replacer
 * is the fallback for when that throws.
 */
function safeJson(value: unknown, maxChars: number): string {
  let text: string | undefined
  try {
    text = JSON.stringify(value, null, 2)
  } catch {
    try {
      const ancestors: unknown[] = []
      text = JSON.stringify(
        value,
        function (this: unknown, _key: string, val: unknown) {
          // `this` is the object `val` was read from: unwind to it, and what is
          // left on the stack is exactly val's ancestor chain.
          while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) ancestors.pop()
          if (typeof val === 'bigint') return `${val}n`
          if (typeof val === 'function') return '<function>'
          if (typeof val === 'object' && val !== null) {
            if (ancestors.includes(val)) return '<circular>'
            ancestors.push(val)
          }
          return val
        },
        2,
      )
    } catch (err) {
      return `<not serialisable: ${err instanceof Error ? err.message : String(err)}>`
    }
  }
  if (text === undefined) return 'null'
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n… (truncated)` : text
}

/** The issue title: what broke, and the one line that says how. */
export function crashReportTitle(input: CrashReportInput): string {
  const head = `Crash in ${input.what}: ${errorLabel(input.error)}`.replace(/\s+/g, ' ').trim()
  return head.length > MAX_TITLE ? `${head.slice(0, MAX_TITLE - 1)}…` : head
}

/**
 * The issue body, as markdown.
 *
 * ORDER IS LOAD-BEARING. The link has a length budget and it is spent from the
 * END, so the sections are written most-useful-first: the prompt for the user's
 * own words, then what broke, then which build, then the options it broke on —
 * and the two stacks last, because they are the part that can run to thousands
 * of lines and the part a maintainer can most often do without.
 */
export function crashReportBody(input: CrashReportInput): string {
  const { what, error, componentStack, context, build = BUILD, href, userAgent } = input
  const out: string[] = [
    '<!-- Filled in by LogoLab. Nothing has been sent anywhere: this is a draft only you can see until you post it. -->',
    '',
    '### What I was doing',
    '',
    '_Replace this line. Even one sentence — what the image was, what you clicked — is usually the difference between a fixable report and a guess._',
    '',
    '### What happened',
    '',
    `${sentence(what)} crashed while rendering.`,
    '',
    '```',
    errorLabel(error),
    '```',
    '',
  ]

  const where: string[] = []
  const stamp = buildTitle(build)
  if (stamp) where.push(`| Build | ${stamp} |`)
  if (href) where.push(`| Page | ${href} |`)
  if (userAgent) where.push(`| Browser | ${userAgent} |`)
  if (where.length > 0) out.push('### Where', '', '| | |', '|---|---|', ...where, '')

  if (context && Object.keys(context).length > 0) {
    out.push(
      '### What it was working on',
      '',
      '```json',
      safeJson(context, MAX_CONTEXT_CHARS),
      '```',
      '',
    )
  }

  const stack = errorStack(error)
  if (stack) out.push('### Stack', '', '```', clip(stack, STACK_LINES), '```', '')

  const component = (componentStack ?? '').trim()
  if (component) {
    out.push('### Component stack', '', '```', clip(component, COMPONENT_STACK_LINES), '```', '')
  }

  return out.join('\n')
}

/** A cut mid-report can leave a fence open, which would code-block the rest. */
function closeFences(text: string): string {
  const fences = (text.match(/^```/gm) ?? []).length
  return fences % 2 === 1 ? `${text}\n${'```'}` : text
}

/**
 * Shrink `text` until its percent-encoding fits `room`, ending with a note that
 * says so. Cutting plain characters is safe arithmetic: an encoded character is
 * never shorter than the character it came from, so dropping N characters drops
 * at least N from the encoding and the loop converges.
 */
function fitEncoded(text: string, room: number): string {
  if (encodeURIComponent(text).length <= room) return text
  if (encodeURIComponent(TRUNCATED).length >= room) return ''
  let cut = text
  for (let guard = 0; guard < 64 && cut.length > 0; guard++) {
    const over = encodeURIComponent(closeFences(cut) + TRUNCATED).length - room
    if (over <= 0) break
    cut = cut.slice(0, Math.max(0, cut.length - Math.max(1, over)))
    // Never end on half a surrogate pair: encodeURIComponent throws on a lone one.
    if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1)
  }
  return closeFences(cut) + TRUNCATED
}

/**
 * The prefilled `issues/new` link. Always returns a URL GitHub will accept: the
 * body is cut to the budget rather than the link being dropped.
 */
export function crashReportUrl(input: CrashReportInput, budget = URL_BUDGET): string {
  const head = `${input.repoUrl.replace(/\/+$/, '')}/issues/new?labels=bug&title=${encodeURIComponent(
    crashReportTitle(input),
  )}&body=`
  const body = fitEncoded(crashReportBody(input), Math.max(0, budget - head.length))
  return head + encodeURIComponent(body)
}
