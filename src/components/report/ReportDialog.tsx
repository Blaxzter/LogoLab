// "Report a problem" dialog, opened by the header's bug button.
//
// Asks first whether this is a problem or an idea, explains what will be
// attached and what to add, then links to the matching GitHub issue form
// (`.github/ISSUE_TEMPLATE/`). Crash screens and failed traces skip this and
// link to the bug form directly, since they already know it's a bug.

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Bug, ChevronLeft, ExternalLink, Lightbulb, X } from 'lucide-react'
import { diagnosticsText, type ReportKind } from '../../lib/report/issueReport'
import { buildReport, CopyReportButton, ReportIssueLink, type ReportSubject } from './ReportIssue'

type Choice = Extract<ReportKind, 'problem' | 'idea'>

/** What each path says, so the two halves of the dialog stay in step. */
const PATHS: Record<
  Choice,
  {
    icon: typeof Bug
    title: string
    blurb: string
    /** What the user should write, in the order the form asks for it. */
    asks: string[]
    cta: string
  }
> = {
  problem: {
    icon: Bug,
    title: 'Something is broken',
    blurb: 'A crash, a control that does nothing — or a trace that came out wrong.',
    asks: [
      'What you did, and what LogoLab did instead.',
      'What you expected — for a wrong-looking trace this is the important half.',
      'A screenshot of the result, if you have one. Paste it straight into the form.',
    ],
    cta: 'Continue on GitHub',
  },
  idea: {
    icon: Lightbulb,
    title: 'Something is missing',
    blurb: 'A feature, a preset, an export format — anything LogoLab should do and does not.',
    asks: [
      'What you were trying to get done, not only the feature you pictured.',
      'How you imagine it working, if you have a picture of it.',
    ],
    cta: 'Open a feature request',
  },
}

export function ReportDialog({ onClose }: { onClose: () => void }) {
  const [choice, setChoice] = useState<Choice | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Report a problem"
    >
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-ink/40 backdrop-blur-sm dark:bg-black/55"
      />

      <div className="panel animate-in-fade relative z-10 flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden">
        <div className="flex items-start justify-between gap-3 border-b border-line p-5">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-base font-semibold text-ink">
              {choice ? 'Before you go' : 'What would you like to tell us?'}
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-muted">
              {choice
                ? 'The next step opens GitHub with a form. Nothing is sent until you post it there.'
                : 'Both end up as a GitHub issue — the form is just different.'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="btn btn-ghost -mr-1.5 -mt-1.5 h-8 w-8 shrink-0 px-0"
          >
            <X size={16} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {choice ? (
            <Guidance choice={choice} onBack={() => setChoice(null)} onClose={onClose} />
          ) : (
            <div className="flex flex-col gap-2.5">
              {(Object.keys(PATHS) as Choice[]).map((key) => {
                const path = PATHS[key]
                const Icon = path.icon
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setChoice(key)}
                    className="flex items-start gap-3 rounded-xl border border-line bg-surface-2 p-4 text-left transition-colors hover:border-accent hover:bg-accent-soft/40"
                  >
                    <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-surface-3 text-accent">
                      <Icon size={17} />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-ink">{path.title}</span>
                      <span className="mt-0.5 block text-xs leading-relaxed text-muted">{path.blurb}</span>
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

function Guidance({ choice, onBack, onClose }: { choice: Choice; onBack: () => void; onClose: () => void }) {
  const path = PATHS[choice]
  const subject: ReportSubject = { what: 'LogoLab', kind: choice }
  // Shown in the disclosure below so the user sees exactly what the link carries.
  const attached = diagnosticsText(buildReport(subject))

  return (
    <div className="flex flex-col gap-4">
      <button
        type="button"
        onClick={onBack}
        className="-ml-1 flex w-fit items-center gap-1 text-xs font-medium text-muted transition-colors hover:text-ink"
      >
        <ChevronLeft size={13} />
        {path.title}
      </button>

      <div>
        <h3 className="text-sm font-semibold text-ink">What to write</h3>
        <ul className="mt-2 flex flex-col gap-1.5">
          {path.asks.map((ask) => (
            <li key={ask} className="flex gap-2 text-xs leading-relaxed text-muted">
              <span aria-hidden className="text-accent">
                •
              </span>
              {ask}
            </li>
          ))}
        </ul>
      </div>

      <div>
        <h3 className="text-sm font-semibold text-ink">What LogoLab attaches</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted">
          Your settings, the image's size and format, this build, and anything that went wrong this session.{' '}
          <span className="text-ink-2">Your image itself is never included.</span>
        </p>
        <details className="mt-2">
          <summary className="cursor-pointer text-xs font-medium text-muted transition-colors hover:text-ink">
            Show me exactly what gets attached
          </summary>
          <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-surface-3 p-3 font-mono text-[0.68rem] leading-relaxed text-ink-2">
            {attached || 'Nothing to attach yet — no logo is loaded.'}
          </pre>
        </details>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
        <ReportIssueLink
          subject={subject}
          className="btn btn-primary h-9 gap-2 text-sm"
          onClick={onClose}
          showExternal={false}
        >
          {path.cta}
          <ExternalLink size={13} className="opacity-70" />
        </ReportIssueLink>
        <CopyReportButton subject={subject} />
      </div>
    </div>
  )
}
