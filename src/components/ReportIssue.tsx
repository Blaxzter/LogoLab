// "Report an issue", everywhere a report is worth making.
//
// The crash screen was the first place this appeared, and for a while the only
// one — which put the button on the RAREST failure. A render that throws is
// unusual here precisely because the expensive work happens off the main thread:
// the tracer runs in a worker that catches its own errors, so a trace that goes
// wrong becomes a polite red line in the status bar, not a crash. That line was
// the end of the road for a bug report.
//
// So the same report hangs off three things now:
//
//   a crash        components/ErrorBoundary — it throws its own bigger screen
//   a failure      anywhere a catch turns an error into a message for the user
//   a problem      the header, any time: "it traced, and the result is wrong"
//
// That last one is the most valuable report this project can receive and it had
// no route at all. Nothing is sent by any of them: the link opens a prefilled
// GitHub issue the user reads, edits and posts themselves.

import { useState, type ReactNode } from 'react'
import { Bug, Check, Copy, ExternalLink } from 'lucide-react'
import { recentErrors } from '../lib/errorLog'
import { collectReportContext } from '../lib/reportContext'
import {
  issueReportText,
  issueReportUrl,
  type IssueReportInput,
  type ReportKind,
} from '../lib/issueReport'
import { REPO_URL } from './navItems'

export interface ReportSubject {
  /** What it is about, lower case: `the vectorizer`. */
  what: string
  kind?: ReportKind
  error?: unknown
  componentStack?: string | null
  /**
   * Context collected EARLIER, by a caller that had to. A crash boundary must
   * collect while the crashing subtree is still mounted (see lib/reportContext);
   * everyone else can let this default and be collected from live state.
   */
  context?: Record<string, unknown> | null
}

/**
 * Fill in everything the app knows and the user should not have to type.
 *
 * Collected at CALL time rather than render time so a link built while a studio
 * is still working describes the moment it is clicked, not the moment the button
 * appeared — except for the context a crash boundary already captured, which is
 * the one case where "now" is too late.
 */
export function buildReport(subject: ReportSubject): IssueReportInput {
  return {
    repoUrl: REPO_URL,
    what: subject.what,
    kind: subject.kind ?? 'crash',
    error: subject.error,
    componentStack: subject.componentStack,
    context: subject.context ?? collectReportContext(),
    log: recentErrors(),
    href: typeof location === 'undefined' ? undefined : location.href,
    userAgent: typeof navigator === 'undefined' ? undefined : navigator.userAgent,
  }
}

/**
 * Copy the whole report to the clipboard — the untruncated one.
 *
 * The link has a length budget (GitHub's request line); this does not. It is the
 * answer to "the report says it was cut", and the fallback for a browser that
 * blocks the clipboard is the text being on screen anyway.
 */
export function CopyReportButton({
  subject,
  className = 'btn btn-ghost h-9 gap-2 text-sm',
}: {
  subject: ReportSubject
  className?: string
}) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className={className}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(issueReportText(buildReport(subject)))
          setCopied(true)
          setTimeout(() => setCopied(false), 2000)
        } catch {
          /* clipboard blocked (permissions, insecure origin) — the details
             block beside this button holds the same text, selectable by hand. */
        }
      }}
    >
      {copied ? <Check size={15} className="text-accent" /> : <Copy size={15} />}
      {copied ? 'Copied' : 'Copy report'}
    </button>
  )
}

/**
 * Rebuild the href immediately before the browser follows it.
 *
 * A link's href is built during RENDER, and some of these links are mounted for
 * the whole session: the mobile menu lives in a drawer that is translated
 * off-screen rather than unmounted, so its "Report a problem" href was built on
 * the app's very first render — before any studio had published what it was
 * working on — and was never rebuilt. It filed reports with the settings
 * missing, which is the one thing a report like this exists to carry.
 *
 * `pointerdown` covers left, middle and right (the context menu opens after it,
 * so "copy link address" copies the fresh one); `focus` covers keyboard
 * activation, which fires no pointer event at all. Both run before navigation,
 * and the render-time href stays as the value either one improves on.
 */
function freshHrefProps(build: () => string) {
  const refresh = (event: { currentTarget: HTMLAnchorElement }) => {
    event.currentTarget.href = build()
  }
  return { onPointerDown: refresh, onFocus: refresh }
}

/**
 * The link itself. An `<a>` rather than a button so it can be opened in a new
 * tab, bookmarked or middle-clicked like any other link.
 */
export function ReportIssueLink({
  subject,
  className = 'btn btn-secondary h-9 gap-2 text-sm',
  children,
  icon,
  showExternal = true,
  onClick,
}: {
  subject: ReportSubject
  className?: string
  children?: ReactNode
  /** Replaces the default glyph — for hosts whose rows align icons themselves. */
  icon?: ReactNode
  showExternal?: boolean
  onClick?: () => void
}) {
  return (
    <a
      href={issueReportUrl(buildReport(subject))}
      {...freshHrefProps(() => issueReportUrl(buildReport(subject)))}
      target="_blank"
      rel="noreferrer"
      onClick={onClick}
      className={className}
    >
      {icon ?? <Bug size={15} className="shrink-0" />}
      {children ?? 'Report an issue'}
      {showExternal && <ExternalLink size={13} className="shrink-0 text-faint" />}
    </a>
  )
}

/**
 * The compact form, for sitting beside a red line in a status bar or under a
 * failed upload. Small, quiet, and the same report underneath.
 */
export function ReportFailureLink({
  what,
  error,
  className = '',
}: {
  what: string
  error: unknown
  className?: string
}) {
  const subject: ReportSubject = { what, kind: 'failure', error }
  return (
    <a
      href={issueReportUrl(buildReport(subject))}
      {...freshHrefProps(() => issueReportUrl(buildReport(subject)))}
      target="_blank"
      rel="noreferrer"
      title="Open a prefilled GitHub issue with the settings and the error attached"
      className={`inline-flex shrink-0 items-center gap-1 underline decoration-dotted underline-offset-2 transition-colors hover:text-ink ${className}`}
    >
      <Bug size={12} className="shrink-0" />
      Report
    </a>
  )
}
