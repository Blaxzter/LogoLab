import { Minus, Plus, Scan } from 'lucide-react'
import type { PanZoom } from '../../hooks/usePanZoom'
import { ActionButton, isOff } from './ActionButton'

/**
 * Compact zoom pill: − / percentage / +, plus a fit-to-view reset. Click the
 * percentage (or the Scan button) to snap back to 100% and re-centre. Wired to a
 * {@link PanZoom} controller, so it stays in sync with wheel + drag gestures.
 */
export function ZoomControls({ pz, className = '' }: { pz: PanZoom; className?: string }) {
  return (
    <div
      className={`flex items-center gap-0.5 rounded-lg border border-line-strong bg-surface/90 p-0.5 shadow-xs backdrop-blur ${className}`}
    >
      <IconBtn
        title="Zoom out"
        onClick={pz.zoomOut}
        reason={pz.canZoomOut ? null : 'Already at the smallest zoom this view allows.'}
      >
        <Minus size={15} />
      </IconBtn>
      <ActionButton
        label="Reset zoom"
        note="Back to 100% and re-centred."
        onClick={pz.reset}
        className="h-7 min-w-[3.1rem] rounded-md px-1.5 font-mono text-xs tabular-nums text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink"
        ariaLabel="Reset zoom"
      >
        {pz.scalePct}%
      </ActionButton>
      <IconBtn
        title="Zoom in"
        onClick={pz.zoomIn}
        reason={pz.canZoomIn ? null : 'Already at the largest zoom this view allows.'}
      >
        <Plus size={15} />
      </IconBtn>
      <IconBtn
        title="Fit to view"
        onClick={pz.reset}
        reason={pz.atDefault ? 'The view is already fitted and centred.' : null}
      >
        <Scan size={15} />
      </IconBtn>
    </div>
  )
}

function IconBtn({
  title,
  onClick,
  reason,
  children,
}: {
  title: string
  onClick: () => void
  reason?: string | null
  children: React.ReactNode
}) {
  // Hover styling is dropped rather than overridden when the button is off: a
  // greyed control that lights up under the pointer reads as pressable.
  const off = isOff(reason)
  return (
    <ActionButton
      label={title}
      reason={reason}
      onClick={onClick}
      className={`flex h-7 w-7 items-center justify-center rounded-md text-ink-2 transition-colors ${
        off ? 'cursor-not-allowed opacity-40' : 'hover:bg-surface-3 hover:text-ink'
      }`}
    >
      {children}
    </ActionButton>
  )
}
