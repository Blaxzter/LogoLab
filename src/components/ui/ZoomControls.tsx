import { Minus, Plus, Scan } from 'lucide-react'
import type { PanZoom } from '../../hooks/usePanZoom'
import { Tooltip } from './Tooltip'

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
      <IconBtn title="Zoom out" onClick={pz.zoomOut} disabled={!pz.canZoomOut}>
        <Minus size={15} />
      </IconBtn>
      <Tooltip label="Reset zoom (fit)">
        <button
          type="button"
          onClick={pz.reset}
          className="h-7 min-w-[3.1rem] rounded-md px-1.5 font-mono text-xs tabular-nums text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink"
        >
          {pz.scalePct}%
        </button>
      </Tooltip>
      <IconBtn title="Zoom in" onClick={pz.zoomIn} disabled={!pz.canZoomIn}>
        <Plus size={15} />
      </IconBtn>
      <IconBtn title="Fit to view" onClick={pz.reset} disabled={pz.atDefault}>
        <Scan size={15} />
      </IconBtn>
    </div>
  )
}

function IconBtn({
  title,
  onClick,
  disabled,
  children,
}: {
  title: string
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <Tooltip label={title}>
      <button
        type="button"
        aria-label={title}
        onClick={onClick}
        disabled={disabled}
        className="flex h-7 w-7 items-center justify-center rounded-md text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
      >
        {children}
      </button>
    </Tooltip>
  )
}
