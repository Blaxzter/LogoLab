// "Saved · just now" — the header's standing answer to "is my work safe?".
//
// The app's promise is that a reload costs nothing, and a promise like that
// wants a quiet, permanent indicator rather than a banner that appears once and
// is gone. So: a chip, in the title bar, saying when the session was last written
// down — and, when the browser won't let us write at all (private mode, a blocked
// origin, a full quota), saying THAT instead. A UI that keeps claiming "Saved"
// through a failed store is worse than one that says nothing.
//
// It is also where "Start fresh" lives now. The restore notice is a transient
// toast, so the one durable control over the stored session belongs next to the
// status it acts on.

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, Check, Loader2, Trash2 } from 'lucide-react'
import { getSaveStatus, startFreshSession, subscribeSaveStatus } from '../lib/persist/session'
import { Tooltip } from './ui/Tooltip'

const POPOVER_W = 268

/** How often the relative time re-renders. A minute's granularity needs no more. */
const TICK_MS = 30_000

function useSaveStatus() {
  return useSyncExternalStore(subscribeSaveStatus, getSaveStatus)
}

/** "just now" / "3 min ago" / "14:07" — the shape a person actually reads. */
function ago(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/**
 * The same status and the same action, as a row — for the mobile menu, since the
 * header's right-hand cluster (and with it the chip) is hidden below md.
 */
export function SavedStatusRow({
  className = '',
  onAct,
}: {
  className?: string
  onAct?: () => void
}) {
  const status = useSaveStatus()
  const [clearing, setClearing] = useState(false)
  const [now] = useState(() => Date.now())

  if (status.savedAt === null && !status.failed && !status.pending) return null

  return (
    <button
      type="button"
      disabled={clearing}
      onClick={() => {
        setClearing(true)
        onAct?.()
        void startFreshSession()
      }}
      className={className}
    >
      <span className="grid h-5 w-5 place-items-center">
        <Trash2 size={16} />
      </span>
      {clearing ? 'Clearing…' : 'Start fresh'}
      <span className={`ml-auto text-xs ${status.failed ? 'text-warn' : 'text-faint'}`}>
        {status.failed ? 'Not saved' : status.pending ? 'Saving…' : `Saved ${ago(status.savedAt!, now)}`}
      </span>
    </button>
  )
}

export function SavedChip({ className = '' }: { className?: string }) {
  const status = useSaveStatus()
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [clearing, setClearing] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)

  // Only while there is a timestamp on screen to age.
  useEffect(() => {
    if (status.savedAt === null) return
    const id = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(id)
  }, [status.savedAt])

  useLayoutEffect(() => {
    if (!open) return
    const b = btnRef.current?.getBoundingClientRect()
    if (!b) return
    const left = Math.max(8, Math.min(b.right - POPOVER_W, window.innerWidth - POPOVER_W - 8))
    setPos({ left, top: b.bottom + 8 })
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (popRef.current?.contains(t) || btnRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    const close = () => setOpen(false)
    document.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [open])

  // Nothing stored and nothing failing: there is no work yet, so an indicator
  // would be answering a question nobody has asked. It still HOLDS ITS SPACE,
  // though — dropping out of the layout would move the centred tab nav the
  // moment the first save landed, which is the same flinch this component's
  // width reservation exists to prevent, just once per session.
  const idle = status.savedAt === null && !status.failed && !status.pending

  // The header is tight — six icons, a six-tab nav and the brand all want room —
  // so the chip sheds its relative time before the wordmark is allowed to
  // truncate. The exact time is still one hover (or one click) away.
  const label = status.failed ? 'Not saved' : status.pending ? 'Saving…' : 'Saved'
  const when = status.failed || status.pending ? null : ago(status.savedAt!, now)

  const startFresh = () => {
    setClearing(true)
    void startFreshSession()
  }

  return (
    <>
      {/* The chip's exact time was a native `title`: a slow, unstyled bubble that
          the header's own tooltip convention had already replaced everywhere
          else. Empty while the popover is open (Tooltip then renders the child
          alone) and while idle, when the chip is invisible anyway. */}
      <Tooltip
        label={
          idle || open
            ? ''
            : status.failed
              ? "This browser isn't letting LogoLab store anything"
              : status.pending
                ? 'Writing your work to this browser…'
                : `Last saved at ${new Date(status.savedAt!).toLocaleTimeString()}`
        }
      >
        <button
          ref={btnRef}
          type="button"
          aria-expanded={open}
          aria-hidden={idle}
          tabIndex={idle ? -1 : undefined}
          onClick={() => setOpen((o) => !o)}
          className={`flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs transition-colors ${
            idle
              ? 'invisible pointer-events-none'
              : status.failed
                ? 'text-warn hover:bg-surface-3'
                : open
                  ? 'bg-surface-3 text-ink-2'
                  : 'text-muted hover:bg-surface-3 hover:text-ink-2'
          } ${className}`}
        >
          {status.failed ? (
            <AlertTriangle size={13} className="shrink-0" />
          ) : status.pending ? (
            <Loader2 size={13} className="shrink-0 animate-spin" />
          ) : (
            <Check size={13} className="shrink-0 text-accent" />
          )}
          {/*
            * A fixed box, sized by the browser to the longest thing that can go in
            * it, with every state stacked in the same grid cell.
            *
            * Without it the chip resizes as its own text changes — Saved → Saving…
            * → Saved 4 min ago — and since the header's tab nav is centred against
            * the width of this cluster, the tabs slid sideways every time a save
            * landed. A reservation rather than a hard px width so it survives a
            * font change and a translation.
            */}
          <span className="grid text-left">
            <span aria-hidden className="invisible col-start-1 row-start-1 whitespace-nowrap">
              Not saved
            </span>
            <span
              aria-hidden
              className="invisible col-start-1 row-start-1 hidden whitespace-nowrap 2xl:block"
            >
              Saved 00 min ago
            </span>
            <span className="col-start-1 row-start-1 whitespace-nowrap">
              {label}
              {when && <span className="hidden 2xl:inline"> {when}</span>}
            </span>
          </span>
        </button>
      </Tooltip>

      {open &&
        !idle &&
        pos &&
        createPortal(
          <div
            ref={popRef}
            role="dialog"
            aria-label="Saved session"
            className="fixed z-[55] rounded-xl border border-line bg-surface p-4 shadow-lg"
            style={{ left: pos.left, top: pos.top, width: POPOVER_W }}
          >
            {status.failed ? (
              <>
                <div className="flex items-center gap-2 text-sm font-semibold text-warn">
                  <AlertTriangle size={15} />
                  Not being saved
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-muted">
                  This browser isn't letting LogoLab store anything — usually a private window, or
                  storage that's full. Everything still works, but a reload will lose it. Download
                  what you want to keep.
                </p>
              </>
            ) : (
              <>
                <div className="flex items-center gap-2 text-sm font-semibold text-ink">
                  <Check size={15} className="text-accent" />
                  Your work is saved
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-muted">
                  Your logo, settings, traces and edits are stored in this browser and come back
                  when you reload.{' '}
                  {status.savedAt && (
                    <>Last saved at {new Date(status.savedAt).toLocaleTimeString()}.</>
                  )}{' '}
                  Nothing is uploaded.
                </p>
              </>
            )}
            <button
              type="button"
              onClick={startFresh}
              disabled={clearing}
              className="btn btn-secondary mt-3 h-9 w-full gap-2 text-sm disabled:opacity-60"
            >
              <Trash2 size={15} />
              {clearing ? 'Clearing…' : 'Start fresh'}
            </button>
            <p className="mt-2 text-[0.68rem] leading-snug text-faint">
              Start fresh discards everything stored here and reloads.
            </p>
          </div>,
          document.body,
        )}
    </>
  )
}
