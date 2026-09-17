// The app's transient notices, in one bottom stack.
//
// They live at the bottom, out of the layout, because none of them is about the
// document on screen and the studios are full-height tools — a strip across the
// top pushes the canvas down for something the user did not ask about. One
// container rather than each notice positioning itself, so a session restore and
// a pending update stack instead of landing on top of each other.
//
// Bottom CENTRE at every width: the studios' bottom action bar and the Customize
// FAB own the corners, and a notice that is about the whole app reads better
// where the eye already returns to. The stack is lifted clear of that bar.

import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { AlertTriangle, History, RefreshCw, WifiOff, X } from 'lucide-react'
import { sessionWasRestored } from '../lib/persist/session'
import { dismissFailure, getFailure, subscribeFailure } from '../lib/failureNotice'
import { ReportIssueLink } from './ReportIssue'
import { usePwa } from '../pwa/register'

/** How long the restore notice stays up. It is pure information — the durable
 *  control over the stored session is the header's Saved chip. */
const RESTORE_MS = 9000

function Toast({
  icon,
  children,
  onDismiss,
}: {
  icon: ReactNode
  children: ReactNode
  onDismiss: () => void
}) {
  return (
    <div
      role="status"
      className="animate-in-fade pointer-events-auto flex max-w-full items-center gap-2.5 rounded-xl border border-line bg-surface px-3 py-2 text-sm shadow-lg"
    >
      <span className="shrink-0 text-accent">{icon}</span>
      <span className="min-w-0 flex-1 text-ink-2">{children}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="grid h-6 w-6 shrink-0 place-items-center rounded text-faint transition-colors hover:bg-surface-3 hover:text-ink"
      >
        <X size={13} />
      </button>
    </div>
  )
}

function RestoreToast() {
  // Read once, at mount: the flag is about this page load, and the toast should
  // leave on its own timer rather than blink out from under a later change.
  const [show, setShow] = useState(sessionWasRestored)

  useEffect(() => {
    if (!show) return
    const id = setTimeout(() => setShow(false), RESTORE_MS)
    return () => clearTimeout(id)
  }, [show])

  if (!show) return null
  return (
    <Toast icon={<History size={15} />} onDismiss={() => setShow(false)}>
      Picked up where you left off.
    </Toast>
  )
}

function PwaToast() {
  const needRefresh = usePwa((s) => s.needRefresh)
  const offlineReady = usePwa((s) => s.offlineReady)
  const update = usePwa((s) => s.update)
  const dismiss = usePwa((s) => s.dismiss)

  // "Installed" is news, not a task: it times out like the restore notice. The
  // update notice does NOT — it carries the only control that applies it, and
  // taking that away after nine seconds would strand the new build.
  useEffect(() => {
    if (!offlineReady || needRefresh) return
    const id = setTimeout(dismiss, RESTORE_MS)
    return () => clearTimeout(id)
  }, [offlineReady, needRefresh, dismiss])

  if (!needRefresh && !offlineReady) return null

  return (
    <Toast
      icon={needRefresh ? <RefreshCw size={15} /> : <WifiOff size={15} />}
      onDismiss={dismiss}
    >
      {needRefresh ? (
        <span className="flex items-center gap-2">
          A new version is ready.
          <button type="button" onClick={update} className="btn btn-primary h-7 shrink-0 px-2.5 text-xs">
            Reload
          </button>
        </span>
      ) : (
        'Installed — LogoLab now works offline.'
      )}
    </Toast>
  )
}

/**
 * Something failed — do you want to report it?
 *
 * The question, where a question belongs: in front of the user, with the button
 * that answers it. It does NOT time out. The other two notices are news, and
 * news can leave on its own; this one is asking something, and a question that
 * removes itself before you have answered was never really asking. Dismiss it
 * and that failure stays dismissed for the session (see lib/failureNotice).
 */
function FailureToast() {
  const failure = useSyncExternalStore(subscribeFailure, getFailure)
  if (!failure) return null
  return (
    <Toast icon={<AlertTriangle size={15} className="text-bad" />} onDismiss={dismissFailure}>
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0">{failure.message} Report it?</span>
        <ReportIssueLink
          subject={{ what: failure.what, kind: 'failure', error: failure.error }}
          className="btn btn-secondary h-7 shrink-0 gap-1.5 px-2.5 text-xs"
          showExternal={false}
          onClick={dismissFailure}
        >
          Report
        </ReportIssueLink>
      </span>
    </Toast>
  )
}

export function Toasts() {
  return (
    <div className="pointer-events-none fixed bottom-[calc(4.5rem+env(safe-area-inset-bottom))] left-1/2 z-50 flex w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 flex-col items-center gap-2">
      <FailureToast />
      <RestoreToast />
      <PwaToast />
    </div>
  )
}
