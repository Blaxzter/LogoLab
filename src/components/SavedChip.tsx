// Header chip showing when the session was last saved, with a popover holding
// "Start fresh". It must be able to say "Not saved": when the browser refuses
// storage (private mode, blocked origin, full quota), claiming "Saved" would be
// worse than showing nothing.

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

/** "just now" / "3 min ago" / "14:07". */
function ago(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/** The same status and action as a row, for the mobile menu (the chip is hidden below md). */
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

  // Tick only while there is a timestamp to age.
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

  // Nothing saved yet: hide the chip but keep its space, so the centred tab nav
  // doesn't shift when the first save lands.
  const idle = status.savedAt === null && !status.failed && !status.pending

  // The relative time is hidden below 2xl so the header wordmark doesn't
  // truncate; the exact time stays in the tooltip and popover.
  const label = status.failed ? 'Not saved' : status.pending ? 'Saving…' : 'Saved'
  const when = status.failed || status.pending ? null : ago(status.savedAt!, now)

  const startFresh = () => {
    setClearing(true)
    void startFreshSession()
  }

  return (
    <>
      {/* Empty label while the popover is open or the chip is idle, so no bubble shows. */}
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
        side="bottom"
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
          {/* All states stacked in one grid cell, sized to the longest, so the chip
              doesn't resize as its text changes and shift the centred tab nav. */}
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
