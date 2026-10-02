// The desktop toolbar: view mode, tool, undo/redo, ghost opacity, zoom and the export buttons.
//
// Its width is whatever the rails leave the canvas column (≈700px at both lg and
// xl), so it collapses on its CONTAINER: below LABELS the tool and export buttons
// go icon-only, below SEGMENTS the view modes fold into a select.

import type { ReactNode } from 'react'
import {
  Check,
  CheckCheck,
  ChevronDown,
  Copy,
  Download,
  Hand,
  Layers,
  MapPin,
  MousePointer2,
  Redo,
  Undo,
} from '../../ui/icons'
import type { PanZoom } from '../../../hooks/usePanZoom'
import type { VectorizeOptions } from '../../../types'
import { Button } from '../../ui/Button'
import { FormatMenu } from '../../ui/FormatMenu'
import type { VectorFormat } from '../../../lib/export/vectorFormats'
import { CheckerToggle } from '../../ui/CheckerToggle'
import { Segmented } from '../../ui/controls'
import { Select } from '../../ui/Select'
import { Tooltip } from '../../ui/Tooltip'
import { ZoomControls } from '../../ui/ZoomControls'
import { StudioDesktopToolbar } from '../../studio/StudioBar'
import type { Tool, ViewMode } from './types'

const VIEW_MODES: { value: ViewMode; label: string; title?: string }[] = [
  { value: 'split', label: 'Split' },
  { value: 'traced', label: 'Traced' },
  { value: 'original', label: 'Original' },
  { value: 'overlay', label: 'Overlay' },
  { value: 'difference', label: 'Difference', title: 'Where the trace disagrees with the original' },
]

/** Written out in full so Tailwind's scanner sees each class. LABEL shows a
 *  button's text from the container width that fits them; SEGMENTS / PICKER
 *  swap the view-mode segmented control for a select below its width. */
const LABEL = 'hidden @min-[68rem]:inline'
const SEGMENTS = 'hidden @min-[59rem]:flex'
const PICKER = '@min-[59rem]:hidden'
/** Below this the fit button and the divider go; the zoom percentage still resets. */
const ROOMY = '@max-[48rem]:hidden'

export function StudioToolbar({
  leading,
  viewMode,
  setViewMode,
  tool,
  setTool,
  opts,
  isVectorSource,
  retraceVector,
  markers,
  undo,
  redo,
  canUndo,
  canRedo,
  overlayOpacity,
  setOverlayOpacity,
  pz,
  applied,
  applyLabel,
  appliedLabel,
  onApply,
  onDownload,
  copied,
  onCopy,
  svgText,
  pathCount,
  onOpenPaths,
}: {
  leading?: ReactNode
  viewMode: ViewMode
  setViewMode: (v: ViewMode) => void
  tool: Tool
  setTool: (t: Tool) => void
  opts: VectorizeOptions
  isVectorSource: boolean
  retraceVector: 'clean' | 'retrace'
  markers: readonly unknown[]
  undo: () => void
  redo: () => void
  canUndo: boolean
  canRedo: boolean
  overlayOpacity: number
  setOverlayOpacity: (v: number) => void
  pz: PanZoom
  applied: boolean
  applyLabel?: string
  appliedLabel?: string
  onApply: () => void
  onDownload: (format?: VectorFormat) => void
  copied: boolean
  onCopy: () => Promise<void>
  svgText: string | null
  /** Paths in the trace, or null with no trace; drives the lg–xl Paths button. */
  pathCount: number | null
  onOpenPaths: () => void
}) {
  return (
    <StudioDesktopToolbar>
      {leading}
      <div className={SEGMENTS}>
        <Segmented<ViewMode> value={viewMode} onChange={setViewMode} options={VIEW_MODES} />
      </div>
      <div className={PICKER}>
        <Select<ViewMode>
          value={viewMode}
          onChange={setViewMode}
          options={VIEW_MODES.map(({ value, label }) => ({ value, label }))}
          className="h-8"
        />
      </div>
      <div className={viewMode === 'original' || viewMode === 'difference' ? 'pointer-events-none opacity-50' : ''}>
        <Segmented<Tool>
          value={tool}
          onChange={setTool}
          options={[
            {
              value: 'pan',
              title: 'Pan & zoom (V)',
              label: (
                <>
                  <Hand size={13} />
                  <span className={LABEL}>Pan</span>
                </>
              ),
            },
            {
              value: 'node',
              title: 'Edit nodes (A)',
              label: (
                <>
                  <MousePointer2 size={13} />
                  <span className={LABEL}>Edit</span>
                </>
              ),
            },
          ]}
        />
      </div>
      {opts.mode === 'color' && (!isVectorSource || retraceVector === 'retrace') && markers.length > 0 && (
        <span className="flex items-center gap-1.5 text-xs text-muted tabular-nums">
          <MapPin size={12} className="text-emerald-500" />
          {markers.length} marker
          {markers.length === 1 ? '' : 's'}
        </span>
      )}
      <ToolButton title="Undo (Ctrl+Z)" onClick={undo} disabled={!canUndo}>
        <Undo size={15} />
      </ToolButton>
      <ToolButton title="Redo (Ctrl+Shift+Z)" onClick={redo} disabled={!canRedo}>
        <Redo size={15} />
      </ToolButton>
      {viewMode === 'overlay' && (
        <label className="flex items-center gap-2 text-xs text-muted">
          Ghost
          <input
            type="range"
            min={0}
            max={100}
            value={overlayOpacity}
            onChange={(e) => setOverlayOpacity(Number(e.target.value))}
            className="h-1.5 w-28 cursor-pointer appearance-none rounded-full bg-line-strong"
          />
        </label>
      )}
      <div className="ml-auto flex items-center gap-1.5 @min-[48rem]:gap-2">
        <ZoomControls pz={pz} fitClassName={ROOMY} />
        <CheckerToggle />
        <span className={`h-5 w-px bg-line ${ROOMY}`} aria-hidden />
        <Button
          variant="primary"
          className="h-8 px-3 text-xs"
          icon={applied ? <CheckCheck size={14} /> : <Check size={14} />}
          onClick={onApply}
          disabled={!svgText}
        >
          {applied ? (appliedLabel ?? 'Applied') : (applyLabel ?? 'Apply to logo')}
        </Button>
        <div className="flex items-center">
          <Tooltip label="Download SVG" side="bottom">
            <Button
              variant="secondary"
              className="h-8 rounded-r-none px-2 text-xs @min-[68rem]:px-3"
              icon={<Download size={14} />}
              onClick={() => onDownload()}
              disabled={!svgText}
              aria-label="Download SVG"
            >
              <span className={LABEL}>Download SVG</span>
            </Button>
          </Tooltip>
          <FormatMenu
            label="Other formats: Illustrator, PDF, DXF"
            onPick={onDownload}
            disabled={!svgText}
            className="btn btn-secondary -ml-px h-8 rounded-l-none px-1"
          >
            <ChevronDown size={13} />
          </FormatMenu>
        </div>
        <Tooltip label={copied ? 'Copied' : 'Copy SVG'} side="bottom">
          <Button
            variant="secondary"
            className="h-8 px-2 text-xs @min-[68rem]:px-3"
            icon={copied ? <Check size={14} /> : <Copy size={14} />}
            onClick={() => void onCopy()}
            disabled={!svgText}
            aria-label="Copy SVG"
          >
            <span className={LABEL}>{copied ? 'Copied' : 'Copy'}</span>
          </Button>
        </Tooltip>
        {pathCount != null && (
          <Tooltip label="Paths & palette" side="bottom">
            <Button
              variant="secondary"
              className="h-8 gap-1.5 px-2.5 text-xs tabular-nums xl:hidden"
              icon={<Layers size={14} />}
              onClick={onOpenPaths}
              aria-label={`Paths (${pathCount})`}
            >
              {pathCount}
            </Button>
          </Tooltip>
        )}
      </div>
    </StudioDesktopToolbar>
  )
}

function ToolButton({
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
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
      >
        {children}
      </button>
    </Tooltip>
  )
}
