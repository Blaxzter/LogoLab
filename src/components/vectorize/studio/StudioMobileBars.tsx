// The mobile chrome: the top strip (view, tool, undo, export) and the bottom action bar.

import type { ReactNode } from 'react'
import { Check, Copy, Download, Hand, Layers, MousePointer2, Redo2, SlidersHorizontal, Undo2 } from 'lucide-react'
import type { PanZoom } from '../../../hooks/usePanZoom'
import type { EditableDoc } from '../../../lib/path/types'
import { Button } from '../../ui/Button'
import { Segmented } from '../../ui/controls'
import { PopoverSlider } from '../../ui/PopoverSlider'
import { ZoomControls } from '../../ui/ZoomControls'
import { BarIconButton, StudioActionBar, StudioTopBar } from '../../studio/StudioBar'
import type { Tool, ViewMode } from './types'

export function StudioMobileTopBar({
  leading,
  view,
  setViewMode,
  tool,
  setTool,
  undo,
  redo,
  canUndo,
  canRedo,
  overlayOpacity,
  setOverlayOpacity,
  pz,
  copied,
  onCopy,
  onDownload,
  svgText,
}: {
  leading?: ReactNode
  view: ViewMode
  setViewMode: (v: ViewMode) => void
  tool: Tool
  setTool: (t: Tool) => void
  undo: () => void
  redo: () => void
  canUndo: boolean
  canRedo: boolean
  overlayOpacity: number
  setOverlayOpacity: (v: number) => void
  pz: PanZoom
  copied: boolean
  onCopy: () => Promise<void>
  onDownload: () => void
  svgText: string | null
}) {
  return (
    <StudioTopBar>
      {leading}
      <Segmented<ViewMode>
        value={view}
        onChange={setViewMode}
        options={[
          { value: 'traced', label: 'Traced' },
          { value: 'original', label: 'Original' },
          { value: 'overlay', label: 'Overlay' },
          { value: 'difference', label: 'Difference' },
        ]}
      />
      <div className={view === 'original' || view === 'difference' ? 'pointer-events-none opacity-50' : ''}>
        <Segmented<Tool>
          value={tool === 'mark' ? 'pan' : tool}
          onChange={setTool}
          options={[
            {
              value: 'pan',
              title: 'Pan & zoom',
              label: (
                <>
                  <Hand size={13} /> Pan
                </>
              ),
            },
            {
              value: 'node',
              title: 'Edit nodes',
              label: (
                <>
                  <MousePointer2 size={13} /> Edit
                </>
              ),
            },
          ]}
        />
      </div>
      <BarIconButton title="Undo" onClick={undo} disabled={!canUndo}>
        <Undo2 size={17} />
      </BarIconButton>
      <BarIconButton title="Redo" onClick={redo} disabled={!canRedo}>
        <Redo2 size={17} />
      </BarIconButton>
      {view === 'overlay' && (
        <PopoverSlider
          title="Ghost opacity"
          value={overlayOpacity}
          min={0}
          max={100}
          onChange={setOverlayOpacity}
          valueText={`${overlayOpacity}%`}
          placement="bottom"
          className="shrink-0"
        >
          Ghost
        </PopoverSlider>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-1.5 pl-1">
        <ZoomControls pz={pz} />
        <BarIconButton title="Copy SVG" onClick={() => void onCopy()} disabled={!svgText}>
          {copied ? <Check size={17} /> : <Copy size={17} />}
        </BarIconButton>
        <BarIconButton title="Download SVG" onClick={onDownload} disabled={!svgText}>
          <Download size={17} />
        </BarIconButton>
      </div>
    </StudioTopBar>
  )
}

export function StudioMobileActionBar({
  setTraceSheetOpen,
  setPathsSheetOpen,
  derivedDoc,
  stats,
  applied,
  applyLabel,
  appliedLabel,
  onApply,
  svgText,
}: {
  setTraceSheetOpen: (open: boolean) => void
  setPathsSheetOpen: (open: boolean) => void
  derivedDoc: EditableDoc | null
  stats: { paths: number } | null
  applied: boolean
  applyLabel?: string
  appliedLabel?: string
  onApply: () => void
  svgText: string | null
}) {
  return (
    <StudioActionBar>
      <Button
        variant="secondary"
        className="h-10"
        icon={<SlidersHorizontal size={16} />}
        onClick={() => setTraceSheetOpen(true)}
      >
        Trace
      </Button>
      {derivedDoc && (
        <Button
          variant="secondary"
          className="h-10"
          icon={<Layers size={16} />}
          onClick={() => setPathsSheetOpen(true)}
        >
          {`Paths${stats ? ` (${stats.paths})` : ''}`}
        </Button>
      )}
      <div className="flex-1" />
      <Button
        variant="primary"
        className="h-10"
        icon={applied ? <Check size={16} /> : undefined}
        onClick={onApply}
        disabled={!svgText}
      >
        {applied ? (appliedLabel ?? 'Applied') : (applyLabel ?? 'Apply')}
      </Button>
    </StudioActionBar>
  )
}
