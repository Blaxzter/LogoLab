// The thing that stands between one bad render and a blank page.
//
// React's answer to an uncaught error in render is to unmount the WHOLE tree —
// so before this existed, a gradient with no stops reaching the renderer, a
// degenerate document reaching the canvas or a malformed SVG reaching parseSvg
// left the user looking at white, with a reload as the only way out. The tracer
// is numerical geometry running on arbitrary uploads; that is not a theoretical
// failure mode.
//
// One boundary per ROUTE (see App.tsx), not one per app: a crash in /vectorize
// must not take out /preview, and the header stays alive so the user can simply
// walk to another tab. A last-resort boundary sits at the root in main.tsx for
// the chrome that is outside every route.
//
// Three ways out, in increasing order of how much they cost you:
//
//   Reset this panel — remount the subtree with fresh state. The logo, the other
//     tabs and the stored session all stay. Enough whenever the crash came from
//     state this panel built rather than from state it was handed.
//   Start over — clear the stored session and reload. The escape hatch for a
//     crash that comes BACK on remount, which is what a poisoned restored
//     document looks like; promoted to the primary action once that happens.
//   Report an issue — a prefilled GitHub issue carrying the options, the image
//     shape, the build and the stack (see lib/issueReport). The tracer's hard
//     cases are the ones nobody can reproduce from prose, so the one click that
//     attaches the options is worth more here than anywhere else in the app.

import { Component, Fragment, useState, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle, RefreshCw, RotateCcw, Trash2 } from 'lucide-react'
import { logError } from '../lib/errorLog'
import { collectReportContext } from '../lib/reportContext'
import { errorLabel, errorStack, isChunkLoadError } from '../lib/issueReport'
import { startFreshSession } from '../lib/persist/session'
import { CopyReportButton, ReportIssueLink, type ReportSubject } from './ReportIssue'

interface Props {
  /** What is behind this boundary, lower case and in the app's own words:
   *  `the vectorizer`. Used in the headline and in the issue title. */
  what: string
  /** `app` is the root boundary, where "this panel" would be a lie. */
  kind?: 'panel' | 'app'
  /**
   * Change it and the boundary forgets the crash. Every routed boundary passes
   * the pathname, and it is load-bearing rather than defensive: the router
   * renders whichever route matched into the SAME position, so React reuses one
   * boundary instance across all of them and only updates its props. Without
   * this, crashing on Preview and then clicking Cleanup showed Cleanup the
   * preview's crash screen — a working panel, hidden behind a stale apology.
   */
  resetKey?: string
  children: ReactNode
}

interface State {
  crashed: boolean
  error: unknown
  /** Collected while the crashing subtree is still mounted — see lib/reportContext. */
  context: Record<string, unknown> | null
  componentStack: string | null
  /** Doubles as the children's key: bumping it is what remounts them. */
  resets: number
  /** When the last reset happened, so a LATER crash isn't blamed on it. */
  resetAt: number
  /** This crash came straight back on the remount the user just asked for. */
  again: boolean
  resetKey: string | undefined
}

/**
 * How soon after a reset a crash still counts as "the same one coming back".
 *
 * A re-crash on remount is synchronous — it happens in the render the reset
 * triggered — so this window only has to survive one commit. It must not be
 * generous: "resetting didn't help, start over" tells the user to wipe their
 * session, and saying that about an unrelated crash ten minutes later would be
 * destructive advice dressed up as a diagnosis.
 */
const REPEAT_WINDOW_MS = 4000

export class ErrorBoundary extends Component<Props, State> {
  state: State = {
    crashed: false,
    error: null,
    context: null,
    componentStack: null,
    resets: 0,
    resetAt: 0,
    again: false,
    resetKey: this.props.resetKey,
  }

  static getDerivedStateFromError(error: unknown): Partial<State> {
    // Collected HERE, in the render phase, and not in the fallback's own render:
    // by the time the fallback is committed the crashing children have been
    // unmounted and every context provider they registered is gone.
    return { crashed: true, error, context: collectReportContext() }
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (props.resetKey === state.resetKey) return null
    return {
      resetKey: props.resetKey,
      crashed: false,
      error: null,
      context: null,
      componentStack: null,
      again: false,
      resets: 0,
      resetAt: 0,
    }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    // React only logs caught errors to the console in development, and a crash
    // report is a lot easier to write with the real thing in front of you.
    console.error(`[LogoLab] crash in ${this.props.what}`, error, info.componentStack)
    // Into the session log too, so a LATER report still knows this happened.
    logError(`crash:${this.props.what}`, error)
    this.setState((s) => ({
      componentStack: info.componentStack ?? null,
      again: s.resets > 0 && Date.now() - s.resetAt < REPEAT_WINDOW_MS,
    }))
  }

  reset = (): void => {
    this.setState((s) => ({
      crashed: false,
      error: null,
      context: null,
      componentStack: null,
      resets: s.resets + 1,
      resetAt: Date.now(),
    }))
  }

  render(): ReactNode {
    if (this.state.crashed) {
      return (
        <CrashScreen
          what={this.props.what}
          kind={this.props.kind ?? 'panel'}
          error={this.state.error}
          context={this.state.context}
          componentStack={this.state.componentStack}
          again={this.state.again}
          onReset={this.reset}
        />
      )
    }
    // The key is the remount: same children, brand new instances and state.
    return <Fragment key={this.state.resets}>{this.props.children}</Fragment>
  }
}

function CrashScreen({
  what,
  kind,
  error,
  context,
  componentStack,
  again,
  onReset,
}: {
  what: string
  kind: 'panel' | 'app'
  error: unknown
  context: Record<string, unknown> | null
  componentStack: string | null
  again: boolean
  onReset: () => void
}) {
  const [clearing, setClearing] = useState(false)

  // A chunk that never arrived is a different failure with a different remedy:
  // the code isn't there, so remounting re-throws the cached rejection forever.
  const chunk = isChunkLoadError(error)

  // The context is the one thing NOT collected on demand: this boundary already
  // captured it in the render phase, while the crashing subtree was still up.
  const subject: ReportSubject = { what, kind: 'crash', error, componentStack, context }

  const startOver = () => {
    setClearing(true)
    void startFreshSession()
  }

  const details = [
    errorLabel(error),
    errorStack(error),
    componentStack ? `\nComponent stack:${componentStack}` : '',
  ]
    .filter(Boolean)
    .join('\n')

  return (
    <div role="alert" className="flex w-full flex-1 items-start justify-center p-4 sm:p-6">
      <div className="animate-in-fade w-full max-w-xl rounded-xl border border-line bg-surface p-5 shadow-sm sm:p-6">
        <div className="flex items-start gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-surface-3 text-bad">
            <AlertTriangle size={18} />
          </span>
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-ink">
              {chunk ? "This tab didn't load" : `Something went wrong in ${what}`}
            </h2>
            <p className="mt-1.5 text-sm leading-relaxed text-muted">
              {chunk ? (
                <>
                  The code for this tab couldn't be downloaded — usually a new version was deployed
                  while this page was open, or the connection dropped. Reloading fetches it again.
                </>
              ) : again ? (
                <>
                  It crashed again as soon as it came back, so whatever is wrong is in the state
                  being restored, not in the panel. Starting over clears the saved session — logo,
                  traces and edits — and reloads onto a clean app.
                </>
              ) : kind === 'app' ? (
                <>
                  Your saved session is untouched: the logo, the traces and the edits are still
                  stored in this browser and come back on their own.
                </>
              ) : (
                <>
                  The rest of LogoLab is still running — your logo and the other tabs are untouched.
                  Resetting gives this panel a clean start and keeps everything else.
                </>
              )}
            </p>
          </div>
        </div>

        <p className="mt-4 overflow-x-auto rounded-lg bg-surface-3 px-3 py-2 font-mono text-xs text-ink-2">
          {errorLabel(error)}
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          {chunk ? (
            <button type="button" onClick={() => location.reload()} className="btn btn-primary h-9 gap-2 text-sm">
              <RefreshCw size={15} />
              Reload the app
            </button>
          ) : (
            <button
              type="button"
              onClick={onReset}
              className={`btn h-9 gap-2 text-sm ${again ? 'btn-secondary' : 'btn-primary'}`}
            >
              <RotateCcw size={15} />
              {kind === 'app' ? 'Try again' : 'Reset this panel'}
            </button>
          )}

          <button
            type="button"
            onClick={startOver}
            disabled={clearing}
            className={`btn h-9 gap-2 text-sm disabled:opacity-60 ${
              again ? 'btn-primary' : 'btn-secondary'
            }`}
          >
            <Trash2 size={15} />
            {clearing ? 'Clearing…' : 'Start over'}
          </button>

          <ReportIssueLink subject={subject} />

          <CopyReportButton subject={subject} />
        </div>

        <p className="mt-3 text-[0.68rem] leading-snug text-faint">
          The report opens a prefilled GitHub issue — the options, the image size, the build, this
          session's errors and the stack, nothing else, and nothing is sent until you post it. Start
          over discards everything stored in this browser.
        </p>

        <details className="mt-4 border-t border-line pt-3">
          <summary className="cursor-pointer text-xs font-medium text-muted transition-colors hover:text-ink">
            Technical details
          </summary>
          <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-surface-3 p-3 font-mono text-[0.68rem] leading-relaxed text-ink-2">
            {details}
          </pre>
        </details>
      </div>
    </div>
  )
}
