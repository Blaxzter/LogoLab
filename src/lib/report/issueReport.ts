// Builds a prefilled GitHub issue link (and a clipboard copy) from a failure:
// the options in use, the image's shape, the build, the recent error log and
// the stack.
//
// It fills an issue form (`.github/ISSUE_TEMPLATE/*.yml`) rather than a body:
// GitHub prefills each field from a query parameter named after the field's
// `id`, so diagnostics land in their own box and the human boxes keep their
// placeholders. The ids in `FIELDS` must match the YAML; GitHub silently
// ignores an unknown parameter, so a rename just delivers an empty box
// (test/issue-template.test.ts guards this).
//
// Kinds: `crash` (a render threw, caught by the error boundary), `failure` (an
// error caught and shown to the user, e.g. a rejected trace), `problem` (no
// error, the output is wrong) and `idea` (a feature request, different form).
//
// Pure (no React, DOM or globals) so the whole report is testable in node.

import { BUILD, buildTitle, type BuildInfo } from '../buildInfo.ts'
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
 * The field `id`s prefilled per form. Must match the YAML: GitHub ignores a
 * parameter that names no field, so a mismatch fails silently.
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

const MAX_TITLE = 120
/**
 * Cap on the error message in "What happened". The title and summary are the
 * fixed part of the URL (only Diagnostics is fitted to the budget), so an
 * uncapped kilobyte-long message could push the link past the limit with
 * nothing left to cut. The full message is still in the Stack section.
 */
const MAX_SUMMARY = 400
const STACK_LINES = 30
const COMPONENT_STACK_LINES = 20
/** A single bundled frame can be thousands of columns wide. */
const MAX_LINE = 200
const MAX_CONTEXT_CHARS = 2400

/**
 * Maximum length of the `issues/new` URL. GitHub answers a request line past
 * ~8 kB with a 414; this leaves headroom. "Copy report" carries the full text.
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
 * A failed dynamic import rather than a crash in loaded code. Remounting cannot
 * fix it (`React.lazy` caches the rejection); only a reload can. Matches the
 * wording of several browsers.
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
  const lines = text.split('\n').map((line) => (line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line))
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
 * JSON that cannot throw, for live studio state that may hold cycles or
 * BigInts. Tries plain stringify first (a shared sub-object is not a cycle),
 * then falls back to an ancestor-tracking replacer.
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
 * The machine-collected diagnostics as plain text (the form field is
 * `render: text`, so markdown would show literally).
 *
 * Order matters: the URL budget truncates from the end, so sections go
 * most-useful-first (build, options, other errors) and the stacks last. The
 * stack gets cut, never the options.
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
    // One line each, oldest first, without stacks to save budget.
    out.push(
      '',
      'Other errors this session',
      ...log.map(
        (e) =>
          `${clock(e.at)}  ${e.source}  ${e.message}` + (e.count > 1 ? `  (×${e.count}, last ${clock(e.lastAt)})` : ''),
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
 * The "What happened" text for a crash or failure. Empty for a `problem` or an
 * `idea`, so the form's own placeholder prompts the user.
 */
export function summaryText(input: IssueReportInput): string {
  const { what, kind = 'crash', error } = input
  if (kind === 'problem' || kind === 'idea') return ''
  const opener =
    kind === 'failure' ? `${sentence(what)} reported a failure:` : `${sentence(what)} crashed while rendering:`
  const label = errorLabel(error)
  const said = label.length > MAX_SUMMARY ? `${label.slice(0, MAX_SUMMARY)}…` : label
  return redact(`${opener}\n\n${said}\n\n`)
}

/**
 * The issue title, or '' (for a `problem` or an `idea`) to keep the form's own
 * `title:` prefix.
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
 * says so. Converges because an encoded character is never shorter than the
 * character itself.
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
  return [title, summaryText(input).trim(), diagnosticsText(input)].filter(Boolean).join('\n\n')
}
