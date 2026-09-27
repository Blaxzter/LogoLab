// The studio's top bar: tools, undo/redo, snapping and grid, then view and export actions.

import { Copy, Download, Grid3x3, Layers, Magnet, Redo2, Undo2, X } from 'lucide-react'
import type { SnapConfig } from '../../../lib/editor/snapping'
import type { PanZoom } from '../../../hooks/usePanZoom'
import { ZoomControls } from '../../ui/ZoomControls'
import { CheckerToggle } from '../../ui/CheckerToggle'
import { ActionButton } from '../../ui/ActionButton'
import { ShapeFlyout } from '../ShapeFlyout'
import type { EditorTool } from '../tools'
import type { ActionReasons } from './actionReasons'
import { BarBtn, Divider, ToolBtn, ToolPill } from './EditorButtons'

export interface EditorToolbarProps {
  tool: EditorTool
  pickTool: (t: EditorTool) => void
  undo: () => void
  redo: () => void
  why: ActionReasons
  snap: SnapConfig
  setSnap: React.Dispatch<React.SetStateAction<SnapConfig>>
  showGrid: boolean
  setShowGrid: React.Dispatch<React.SetStateAction<boolean>>
  enteredGroupId: string | null
  setEnteredGroupId: (id: string | null) => void
  pz: PanZoom
  copy: () => void
  download: () => void
  onClose: () => void
}

export function EditorToolbar({
  tool,
  pickTool,
  undo,
  redo,
  why,
  snap,
  setSnap,
  showGrid,
  setShowGrid,
  enteredGroupId,
  setEnteredGroupId,
  pz,
  copy,
  download,
  onClose,
}: EditorToolbarProps) {
  return (
    <div className="flex h-12 shrink-0 items-center gap-1 border-b border-line bg-surface px-2">
      {/* Grouped by purpose: select/reshape, draw, view. */}
      <div className="flex items-center gap-1.5">
        <ToolPill>
          <ToolBtn id="select" tool={tool} onPick={pickTool} />
          <ToolBtn id="node" tool={tool} onPick={pickTool} />
        </ToolPill>
        <ToolPill>
          <ToolBtn id="pen" tool={tool} onPick={pickTool} />
          <ShapeFlyout tool={tool} onPick={pickTool} />
        </ToolPill>
        <ToolPill>
          <ToolBtn id="pan" tool={tool} onPick={pickTool} />
        </ToolPill>
      </div>

      <Divider />

      <BarBtn label="Undo (Ctrl+Z)" onClick={undo} reason={why.undo}>
        <Undo2 size={15} />
      </BarBtn>
      <BarBtn label="Redo (Ctrl+Shift+Z)" onClick={redo} reason={why.redo}>
        <Redo2 size={15} />
      </BarBtn>

      <Divider />

      <BarBtn
        label={snap.enabled ? 'Snapping on' : 'Snapping off'}
        note="Edges and centres pull towards each other as you drag. Hold Ctrl to bypass it for one drag."
        onClick={() => setSnap((s) => ({ ...s, enabled: !s.enabled }))}
        active={snap.enabled}
      >
        <Magnet size={15} />
      </BarBtn>
      <BarBtn
        label={showGrid ? 'Hide grid' : 'Show grid'}
        note="A reference grid over the artboard. It is never exported."
        onClick={() => setShowGrid((g) => !g)}
        active={showGrid}
      >
        <Grid3x3 size={15} />
      </BarBtn>

      <div className="ml-auto flex items-center gap-1.5">
        {enteredGroupId && (
          <ActionButton
            label="Leave group"
            note="Go back to selecting whole groups instead of the shapes inside this one. Escape does the same."
            onClick={() => setEnteredGroupId(null)}
            className="btn btn-secondary h-8 gap-1.5 px-2 text-xs"
          >
            <Layers size={13} />
            Leave group
          </ActionButton>
        )}
        <CheckerToggle />
        <ZoomControls pz={pz} />
        <ActionButton
          label="Copy SVG markup"
          note="Puts the whole drawing on the clipboard as <svg> text."
          onClick={copy}
          className="btn btn-ghost h-8 w-8 px-0"
        >
          <Copy size={15} />
        </ActionButton>
        <ActionButton
          label="Download SVG"
          note="Saves the drawing as a file. Hidden layers are left out."
          onClick={download}
          className="btn btn-primary h-8 gap-1.5 px-2.5 text-xs"
        >
          <Download size={14} />
          SVG
        </ActionButton>
        <ActionButton
          label="Close this drawing"
          note="Back to the start screen. Unsaved changes are lost."
          onClick={onClose}
          className="btn btn-ghost h-8 w-8 px-0"
        >
          <X size={15} />
        </ActionButton>
      </div>
    </div>
  )
}
