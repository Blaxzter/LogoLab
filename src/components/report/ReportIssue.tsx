// "Report an issue" links and buttons, shared by every entry point:
//
//   a crash        components/report/ErrorBoundary
//   a failure      anywhere a catch turns an error into a message for the user
//   a problem      the header: "it traced, and the result is wrong"
//
// Nothing is sent: the link opens a prefilled GitHub issue the user reviews and
// posts themselves.

import { useState, type ReactNode } from 'react'
import { Bug, Check, Copy, ExternalLink } from 'lucide-react'
import { recentErrors } from '../../lib/errorLog'
import { collectReportContext } from '../../lib/reportContext'
import {
  issueReportText,
  issueReportUrl,
  type IssueReportInput,
  type ReportKind,
} from '../../lib/issueReport'
import { REPO_URL } from '../shell/navItems'
import { TipLabel, Tooltip } from '../ui/Tooltip'

export interface ReportSubject {
  /** What it is about, lower case: `the vectorizer`. */
  what: string
  kind?: ReportKind
  error?: unknown
  componentStack?: string | null
  /**
   * Pre-collected context. Only a crash boundary needs this, because it must
   * collect while the crashing subtree is still mounted (see lib/reportContext);
   * otherwise it is collected from live state.
   */
  context?: Record<string, unknown> | null
}

/**
 * Everything the app knows about the current state, collected at call time so
 * the report describes the moment of the click.
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
 * Copies the full, untruncated report. The link is length-limited by GitHub's
 * request line; the clipboard is not.
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
          /* Clipboard blocked; the details block beside this button shows the same text. */
        }
      }}
    >
      {copied ? <Check size={15} className="text-accent" /> : <Copy size={15} />}
      {copied ? 'Copied' : 'Copy report'}
    </button>
  )
}

/**
 * Rebuilds the href just before the browser follows it.
 *
 * Don't rely on the render-time href alone: some of these links never
 * re-render (the mobile menu drawer is translated off-screen, not unmounted),
 * so their href would predate any studio publishing its settings. `pointerdown`
 * covers every mouse button and "copy link address"; `focus` covers keyboard
 * activation. Both fire before navigation.
 */
function freshHrefProps(build: () => string) {
  const refresh = (event: { currentTarget: HTMLAnchorElement }) => {
    event.currentTarget.href = build()
  }
  return { onPointerDown: refresh, onFocus: refresh }
}

/** An `<a>` rather than a button so it behaves like any other link. */
export function ReportIssueLink({
  subject,
  className = 'btn btn-secondary h-9 gap-2 text-sm',
  children,
  icon,
  tip,
  showExternal = true,
  onClick,
}: {
  subject: ReportSubject
  className?: string
  children?: ReactNode
  /** Replaces the default glyph — for hosts whose rows align icons themselves. */
  icon?: ReactNode
  /** Hover hint; needed for icon-only triggers. */
  tip?: ReactNode
  showExternal?: boolean
  onClick?: () => void
}) {
  // The Tooltip wraps the anchor here because it clones its child to attach
  // handlers; wrapping <ReportIssueLink> from outside would lose them.
  return (
    <Tooltip label={tip ?? ''}>
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
    </Tooltip>
  )
}

/** Compact inline link for a failure message (status bar, failed upload). */
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
    <Tooltip
      label={
        <TipLabel
          title="Report this"
          detail="Opens a prefilled GitHub issue with the settings and the error attached. Nothing is sent until you post it."
        />
      }
    >
      <a
        href={issueReportUrl(buildReport(subject))}
        {...freshHrefProps(() => issueReportUrl(buildReport(subject)))}
        target="_blank"
        rel="noreferrer"
        className={`inline-flex shrink-0 items-center gap-1 underline decoration-dotted underline-offset-2 transition-colors hover:text-ink ${className}`}
      >
        <Bug size={12} className="shrink-0" />
        Report
      </a>
    </Tooltip>
  )
}
