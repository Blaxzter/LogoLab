// The desktop toolbar: view mode, tool, undo/redo, ghost opacity, zoom and the export buttons.

import type { ReactNode } from 'react'
import { Check, Copy, Download, Hand, MapPin, MousePointer2, Redo2, Undo2 } from 'lucide-react'
import type { PanZoom } from '../../../hooks/usePanZoom'
import type { VectorizeOptions } from '../../../types'
import { Button } from '../../ui/Button'
import { CheckerToggle } from '../../ui/CheckerToggle'
import { Segmented } from '../../ui/controls'
import { Tooltip } from '../../ui/Tooltip'
import { ZoomControls } from '../../ui/ZoomControls'
import type { Tool, ViewMode } from './types'

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
  onDownload: () => void
  copied: boolean
  onCopy: () => Promise<void>
  svgText: string | null
}) {
  return (
    <div className="hidden h-12 shrink-0 items-center gap-2 border-b border-line bg-surface px-3 md:flex">
      {leading}
      <Segmented<ViewMode>
        value={viewMode}
        onChange={setViewMode}
        options={[
          { value: 'split', label: 'Split' },
          { value: 'traced', label: 'Traced' },
          { value: 'original', label: 'Original' },
          { value: 'overlay', label: 'Overlay' },
          {
            value: 'difference',
            label: 'Difference',
            title: 'Where the trace disagrees with the original',
          },
        ]}
      />
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
                  <Hand size={13} /> Pan
                </>
              ),
            },
            {
              value: 'node',
              title: 'Edit nodes (A)',
              label: (
                <>
                  <MousePointer2 size={13} /> Edit
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
        <Undo2 size={15} />
      </ToolButton>
      <ToolButton title="Redo (Ctrl+Shift+Z)" onClick={redo} disabled={!canRedo}>
        <Redo2 size={15} />
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
      <div className="ml-auto flex items-center gap-2">
        <ZoomControls pz={pz} />
        <CheckerToggle />
        <span className="h-5 w-px bg-line" aria-hidden />
        <Button
          variant="primary"
          className="h-8 px-3 text-xs"
          icon={applied ? <Check size={14} /> : undefined}
          onClick={onApply}
          disabled={!svgText}
        >
          {applied ? (appliedLabel ?? 'Applied') + ' \u2713' : (applyLabel ?? 'Apply to logo')}
        </Button>
        <Button
          variant="secondary"
          className="h-8 px-3 text-xs"
          icon={<Download size={14} />}
          onClick={onDownload}
          disabled={!svgText}
        >
          Download SVG
        </Button>
        <Button
          variant="secondary"
          className="h-8 px-3 text-xs"
          icon={copied ? <Check size={14} /> : <Copy size={14} />}
          onClick={() => void onCopy()}
          disabled={!svgText}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
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
