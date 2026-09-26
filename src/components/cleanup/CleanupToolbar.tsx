// The cleanup studio's top bars: the desktop toolbar and the mobile top strip (view mode, undo/redo, ghost, zoom).

import { Check, Download, Redo2, Undo2 } from 'lucide-react'
import type { PanZoom } from '../../hooks/usePanZoom'
import { ZoomControls } from '../ui/ZoomControls'
import { CheckerToggle } from '../ui/CheckerToggle'
import { Segmented } from '../ui/controls'
import { Button } from '../ui/Button'
import { PopoverSlider } from '../ui/PopoverSlider'
import { StudioTopBar, BarIconButton } from '../studio/StudioBar'
import { Tooltip } from '../ui/Tooltip'

export type ViewMode = 'split' | 'result' | 'original' | 'overlay'

/** Undo/redo state shared by both bars. */
interface HistoryProps {
  onUndo: () => void
  onRedo: () => void
  undoLen: number
  redoLen: number
  aiBusy: boolean
}

/** Desktop toolbar (md and up): view mode, undo/redo, ghost, zoom, Apply / Download. */
export function CleanupToolbar({
  viewMode,
  onViewMode,
  onUndo,
  onRedo,
  undoLen,
  redoLen,
  aiBusy,
  ghostOpacity,
  onGhostOpacity,
  pz,
  applied,
  modified,
  ready,
  onApply,
  onDownload,
}: HistoryProps & {
  viewMode: ViewMode
  onViewMode: (v: ViewMode) => void
  ghostOpacity: number
  onGhostOpacity: (v: number) => void
  pz: PanZoom
  applied: boolean
  modified: boolean
  ready: boolean
  onApply: () => void
  onDownload: () => void
}) {
  return (
    <div className="hidden h-12 shrink-0 items-center gap-2 border-b border-line bg-surface px-3 md:flex">
      <Segmented<ViewMode>
        value={viewMode}
        onChange={onViewMode}
        options={[
          { value: 'split', label: 'Split' },
          { value: 'result', label: 'Result' },
          { value: 'original', label: 'Original' },
          { value: 'overlay', label: 'Overlay' },
        ]}
      />
      <ToolButton title="Undo (Ctrl+Z)" onClick={onUndo} disabled={undoLen === 0 || aiBusy}>
        <Undo2 size={15} />
      </ToolButton>
      <ToolButton title="Redo (Ctrl+Shift+Z)" onClick={onRedo} disabled={redoLen === 0 || aiBusy}>
        <Redo2 size={15} />
      </ToolButton>
      {viewMode === 'overlay' && (
        <label className="flex items-center gap-2 text-xs text-muted">
          Ghost
          <input
            type="range"
            min={0}
            max={100}
            value={ghostOpacity}
            onChange={(e) => onGhostOpacity(Number(e.target.value))}
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
          disabled={(!modified && !applied) || aiBusy || !ready}
        >
          {applied ? 'Applied ✓' : 'Apply to logo'}
        </Button>
        <Button
          variant="secondary"
          className="h-8 px-3 text-xs"
          icon={<Download size={14} />}
          onClick={onDownload}
          disabled={aiBusy || !ready}
        >
          Download PNG
        </Button>
      </div>
    </div>
  )
}

/** Mobile top strip: the split-less view modes, undo/redo, ghost popover, zoom. */
export function CleanupTopStrip({
  view,
  onViewMode,
  onUndo,
  onRedo,
  undoLen,
  redoLen,
  aiBusy,
  ghostOpacity,
  onGhostOpacity,
  pz,
}: HistoryProps & {
  view: ViewMode
  onViewMode: (v: ViewMode) => void
  ghostOpacity: number
  onGhostOpacity: (v: number) => void
  pz: PanZoom
}) {
  return (
    <StudioTopBar>
      <Segmented<ViewMode>
        value={view}
        onChange={onViewMode}
        options={[
          { value: 'result', label: 'Result' },
          { value: 'original', label: 'Original' },
          { value: 'overlay', label: 'Overlay' },
        ]}
      />
      <BarIconButton title="Undo" onClick={onUndo} disabled={undoLen === 0 || aiBusy}>
        <Undo2 size={17} />
      </BarIconButton>
      <BarIconButton title="Redo" onClick={onRedo} disabled={redoLen === 0 || aiBusy}>
        <Redo2 size={17} />
      </BarIconButton>
      {view === 'overlay' && (
        <PopoverSlider
          title="Ghost opacity"
          value={ghostOpacity}
          min={0}
          max={100}
          onChange={onGhostOpacity}
          valueText={`${ghostOpacity}%`}
          placement="bottom"
          className="shrink-0"
        >
          Ghost
        </PopoverSlider>
      )}
      <div className="ml-auto shrink-0 pl-1">
        <ZoomControls pz={pz} />
      </div>
    </StudioTopBar>
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
