// A failure, turned into something a stranger can act on.
//
// The tracer is ~16k lines of numerical geometry running on whatever image a
// user happens to drop in, and its hard cases are exactly the ones nobody can
// reproduce from a prose bug report: "it broke on my logo" names neither the
// art nor the twenty options that were set when it broke. So the app does not
// merely apologise — it fills in a GitHub issue FORM with the options, the
// image's shape, the build, the recent error log and the stack.
//
// A FORM, not a body. `.github/ISSUE_TEMPLATE/*.yml` defines the fields and
// GitHub prefills them from query parameters keyed by each field's `id`, so the
// machine-collected half lands in its own Diagnostics box and the human half
// stays an empty box with a prompt in it — rather than one wall of markdown
// where the user has to find the line that says "replace this". The ids are
// duplicated between the YAML and this file by necessity; `test/issue-template.
// test.ts` is what stops them drifting apart, because GitHub silently ignores a
// query parameter that matches no field and the box just arrives empty.
//
// FOUR KINDS. A `crash` is a render that threw (components/ErrorBoundary). A
// `failure` is one that was caught and handled — a trace that came back
// rejected, a file that would not decode — which is the far more common one,
// because the worker path catches its own errors rather than letting them reach
// a boundary. A `problem` has no error at all: the output is simply wrong,
// which for a tracer is the single most valuable report there is. An `idea` is
// a feature request and goes to a different form entirely.
//
// Everything here is PURE and free of React, of the DOM and of any global, so
// the whole report can be asserted in a node test (test/issue-report.test.ts)
// instead of only ever being seen on the day something breaks — which is the
// worst possible moment to discover that the link came out 20 kB long and
// GitHub answers it with a 414.

import { BUILD, buildTitle, type BuildInfo } from './buildInfo.ts'
import { redact, type LoggedError } from './errorLog.ts'

/** What is being reported. Picks the form, the prompts and the title. */
export type ReportKind = 'crash' | 'failure' | 'problem' | 'idea'

/** The issue form each kind is filed through (`.github/ISSUE_TEMPLATE/`). */
export const TEMPLATE: Record<ReportKind, string> = {
  crash: 'bug_report.yml',
  failure: 'bug_report.yml',
  problem: 'bug_report.yml',
  idea: 'feature_request.yml',
}

/**
 * The field `id`s this file prefills, per form.
 *
 * GitHub keys a prefill query parameter off the field's `id`, and ignores a
 * parameter that matches nothing — so a rename in the YAML does not break
 * anything loudly, it just delivers an empty Diagnostics box for the rest of
 * time. Hence the gate in test/issue-template.test.ts.
 */
export const FIELDS: Record<string, { summary: string; diagnostics: string }> = {
  'bug_report.yml': { summary: 'what-happened', diagnostics: 'diagnostics' },
  'feature_request.yml': { summary: 'problem', diagnostics: 'diagnostics' },
}

/** Everything a report is made of. Only `repoUrl` and `what` are required. */
export interface IssueReportInput {
  /** Repository the issue is filed against, e.g. `https://github.com/org/repo`. */
  repoUrl: string
  /** What it is about, lower case and in the app's own words: `the vectorizer`. */
  what: string
  /** Defaults to `crash`. */
  kind?: ReportKind
  /** Whatever was thrown or rejected. Absent for a `problem` or an `idea`. */
  error?: unknown
  /** React's `info.componentStack`, when a boundary got one. */
  componentStack?: string | null
  /** What the panels were working on — see ./reportContext. */
  context?: Record<string, unknown> | null
  /** What else went wrong this session — see ./errorLog. */
  log?: LoggedError[] | null
  /** Which build this is. Defaults to the one baked into the bundle. */
  build?: BuildInfo
  /** `location.href` at the time. */
  href?: string
  /** `navigator.userAgent`. */
  userAgent?: string
}

/** Issue titles are one line in a list — past this they are noise. */
const MAX_TITLE = 120
/**
 * How much of the error message goes in "What happened".
 *
 * It has to be capped, and not for tidiness: the title and this summary are the
 * FIXED half of the URL — only Diagnostics is fitted to the budget — so an
 * error whose message runs to kilobytes (a worker echoing a whole payload back)
 * would push the link past GitHub's request-line limit with nothing left to
 * cut. The full message is in the Stack section below it either way.
 */
const MAX_SUMMARY = 400
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
 * GitHub answers a request line past roughly 8 kB with a 414 and no explanation
 * (its own docs say so), which would turn "Report a problem" into a dead button
 * at exactly the moment it is needed. 6.5 kB leaves room for whatever proxy
 * sits in between, and the Copy button beside every report still carries the
 * untruncated thing.
 */
export const URL_BUDGET = 6500

const TRUNCATED = '\n… (cut to fit the link — use "Copy report" in the app for the whole thing.)'

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

/** `20:35:44`, in whatever the reader's browser calls that. */
function clock(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

/**
 * JSON that cannot throw.
 *
 * The context is live studio state, so it can hold anything: a cycle, a typed
 * array, a BigInt. A report that dies while describing a failure leaves the user
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

/**
 * The machine-collected half, as PLAIN TEXT.
 *
 * Plain, not markdown, because the Diagnostics field is `render: text` — GitHub
 * puts the whole value in a code block, where a markdown table renders as the
 * pipes you typed. It also removes a whole class of bug: there are no fences in
 * here, so truncating the tail can never leave one open.
 *
 * ORDER IS LOAD-BEARING. The link has a length budget and it is spent from the
 * END, so this is written most-useful-first: which build, then the options it
 * happened on, then the session's other errors, and the two stacks last —
 * because they are the part that can run to thousands of lines and the part a
 * maintainer can most often do without.
 */
export function diagnosticsText(input: IssueReportInput): string {
  const { error, componentStack, context, log, build = BUILD, href, userAgent } = input
  const out: string[] = []

  const stamp = buildTitle(build)
  if (stamp) out.push(`Build     ${stamp}`)
  if (href) out.push(`Page      ${redact(href)}`)
  if (userAgent) out.push(`Browser   ${userAgent}`)

  if (context && Object.keys(context).length > 0) {
    out.push('', 'Working on', redact(safeJson(context, MAX_CONTEXT_CHARS)))
  }

  if (log && log.length > 0) {
    // One line each, oldest first. No stacks: twenty-five stacks would eat the
    // whole budget to say what the section already says — WHEN things started
    // going wrong, and whether this failure had company.
    out.push(
      '',
      'Other errors this session',
      ...log.map(
        (e) =>
          `${clock(e.at)}  ${e.source}  ${e.message}` +
          (e.count > 1 ? `  (×${e.count}, last ${clock(e.lastAt)})` : ''),
      ),
    )
  }

  const stack = errorStack(error)
  if (stack) out.push('', 'Stack', redact(clip(stack, STACK_LINES)))

  const component = (componentStack ?? '').trim()
  if (component) out.push('', 'Component stack', clip(component, COMPONENT_STACK_LINES))

  return out.join('\n')
}

/**
 * The line that goes in "What happened" — for a crash or a failure, where the
 * app knows more than the user does. A `problem` or an `idea` leaves it EMPTY
 * on purpose: the form's own placeholder is a better prompt than anything this
 * file could guess, and a prefilled box is one the user has to clear first.
 */
export function summaryText(input: IssueReportInput): string {
  const { what, kind = 'crash', error } = input
  if (kind === 'problem' || kind === 'idea') return ''
  const opener =
    kind === 'failure'
      ? `${sentence(what)} reported a failure:`
      : `${sentence(what)} crashed while rendering:`
  const label = errorLabel(error)
  const said = label.length > MAX_SUMMARY ? `${label.slice(0, MAX_SUMMARY)}…` : label
  return redact(`${opener}\n\n${said}\n\n`)
}

/**
 * The issue title, or '' to let the form's own `title:` prefix stand — which is
 * what a `problem` and an `idea` do, because only the user can title those.
 */
export function issueReportTitle(input: IssueReportInput): string {
  const kind = input.kind ?? 'crash'
  if (kind === 'problem' || kind === 'idea') return ''
  const head =
    kind === 'failure'
      ? `[bug] ${sentence(input.what)} failed: ${errorLabel(input.error)}`
      : `[bug] Crash in ${input.what}: ${errorLabel(input.error)}`
  const line = redact(head).replace(/\s+/g, ' ').trim()
  return line.length > MAX_TITLE ? `${line.slice(0, MAX_TITLE - 1)}…` : line
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
    const over = encodeURIComponent(cut + TRUNCATED).length - room
    if (over <= 0) break
    cut = cut.slice(0, Math.max(0, cut.length - Math.max(1, over)))
    // Never end on half a surrogate pair: encodeURIComponent throws on a lone one.
    if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1)
  }
  return cut + TRUNCATED
}

/**
 * The prefilled `issues/new` link. Always returns a URL GitHub will accept: the
 * Diagnostics field is cut to the budget rather than the link being dropped.
 */
export function issueReportUrl(input: IssueReportInput, budget = URL_BUDGET): string {
  const template = TEMPLATE[input.kind ?? 'crash']
  const fields = FIELDS[template]
  const base = `${input.repoUrl.replace(/\/+$/, '')}/issues/new`

  const fixed = new URLSearchParams({ template })
  const title = issueReportTitle(input)
  if (title) fixed.set('title', title)
  const summary = summaryText(input)
  if (summary) fixed.set(fields.summary, summary)

  const head = `${base}?${fixed.toString()}&${fields.diagnostics}=`
  const diagnostics = fitEncoded(diagnosticsText(input), Math.max(0, budget - head.length))
  return diagnostics ? head + encodeURIComponent(diagnostics) : `${base}?${fixed.toString()}`
}

/** The whole report as text, for the clipboard — no budget, nothing cut. */
export function issueReportText(input: IssueReportInput): string {
  const title = issueReportTitle(input)
  return [title, summaryText(input).trim(), diagnosticsText(input)]
    .filter(Boolean)
    .join('\n\n')
}
