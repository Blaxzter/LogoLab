// The app's transient notices, stacked in one container at the bottom centre,
// out of the layout, lifted clear of the studios' bottom action bar.

import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { AlertTriangle, History, RefreshCw, WifiOff, X } from 'lucide-react'
import { sessionWasRestored } from '../../lib/persist/session'
import { dismissFailure, getFailure, subscribeFailure } from '../../lib/report/failureNotice'
import { ReportIssueLink } from '../report/ReportIssue'
import { usePwa } from '../../pwa/register'

/** How long informational notices stay up. */
const RESTORE_MS = 9000

function Toast({ icon, children, onDismiss }: { icon: ReactNode; children: ReactNode; onDismiss: () => void }) {
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
  // Read once at mount: the flag describes this page load.
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
  const updating = usePwa((s) => s.updating)
  const update = usePwa((s) => s.update)
  const dismiss = usePwa((s) => s.dismiss)

  // "Installed" times out. The update notice must not: its button is the only way
  // the waiting build takes over.
  useEffect(() => {
    if (!offlineReady || needRefresh) return
    const id = setTimeout(dismiss, RESTORE_MS)
    return () => clearTimeout(id)
  }, [offlineReady, needRefresh, dismiss])

  if (!needRefresh && !offlineReady) return null

  return (
    <Toast icon={needRefresh ? <RefreshCw size={15} /> : <WifiOff size={15} />} onDismiss={dismiss}>
      {needRefresh ? (
        <span className="flex items-center gap-2">
          A new version is ready.
          {/* The reload waits for the new worker to take over (otherwise the page
              comes back on the old build), so the button shows progress meanwhile. */}
          <button
            type="button"
            onClick={update}
            disabled={updating}
            className="btn btn-primary h-7 shrink-0 px-2.5 text-xs"
          >
            {updating ? 'Reloading…' : 'Reload'}
          </button>
        </span>
      ) : (
        'Installed — LogoLab now works offline.'
      )}
    </Toast>
  )
}

/**
 * "Something failed — report it?" Doesn't time out, since it asks a question.
 * A dismissed failure stays dismissed for the session (see lib/report/failureNotice).
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
