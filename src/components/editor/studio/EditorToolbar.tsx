// The studio's top bar: tools, undo/redo, snapping and grid, then view and export actions.

import { ChevronDown, Copy, Download, Grid3x3, Layers, Magnet, Redo, Type, Undo, X } from '../../ui/icons'
import type { SnapConfig } from '../../../lib/editor/snapping'
import type { PanZoom } from '../../../hooks/usePanZoom'
import { ZoomControls } from '../../ui/ZoomControls'
import { CheckerToggle } from '../../ui/CheckerToggle'
import { ActionButton } from '../../ui/ActionButton'
import { FormatMenu } from '../../ui/FormatMenu'
import type { VectorFormat } from '../../../lib/export/vectorFormats'
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
  download: (format?: VectorFormat) => void
  /** Visible items only the SVG can carry (imported text, images…). */
  svgOnlyItems: number
  /** The drawing has live text, so the SVG can carry it either way. */
  hasText: boolean
  textAs: 'outlines' | 'live'
  setTextAs: (v: 'outlines' | 'live') => void
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
  svgOnlyItems,
  hasText,
  textAs,
  setTextAs,
  onClose,
}: EditorToolbarProps) {
  return (
    // Scrolls rather than wrapping on a phone: it never widens the page.
    <div className="no-scrollbar flex h-12 shrink-0 items-center gap-1 overflow-x-auto border-b border-line bg-surface px-2 [&>*]:shrink-0">
      {/* Grouped by purpose: select/reshape, draw, view. */}
      <div className="flex items-center gap-1.5">
        <ToolPill>
          <ToolBtn id="select" tool={tool} onPick={pickTool} />
          <ToolBtn id="node" tool={tool} onPick={pickTool} />
        </ToolPill>
        <ToolPill>
          <ToolBtn id="pen" tool={tool} onPick={pickTool} />
          <ToolBtn id="text" tool={tool} onPick={pickTool} />
          <ShapeFlyout tool={tool} onPick={pickTool} />
        </ToolPill>
        <ToolPill>
          <ToolBtn id="pan" tool={tool} onPick={pickTool} />
        </ToolPill>
      </div>

      <Divider />

      <BarBtn label="Undo (Ctrl+Z)" onClick={undo} reason={why.undo}>
        <Undo size={15} />
      </BarBtn>
      <BarBtn label="Redo (Ctrl+Shift+Z)" onClick={redo} reason={why.redo}>
        <Redo size={15} />
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
        {hasText && (
          <ActionButton
            label={textAs === 'live' ? 'SVG text: live' : 'SVG text: outlines'}
            note={
              textAs === 'live'
                ? 'Text is saved as <text>, so other editors can retype it — but it only looks right where its font is available. Click for outlines.'
                : 'Text is saved as shapes: it looks the same everywhere, but can no longer be retyped elsewhere. Click to keep it as live <text>.'
            }
            pressed={textAs === 'live'}
            onClick={() => setTextAs(textAs === 'live' ? 'outlines' : 'live')}
            className={`btn h-8 gap-1 px-2 text-xs ${textAs === 'live' ? 'btn-secondary is-active' : 'btn-ghost'}`}
          >
            <Type size={14} />
            {textAs === 'live' ? 'Live' : 'Outlines'}
          </ActionButton>
        )}
        <ActionButton
          label="Copy SVG markup"
          note="Puts the whole drawing on the clipboard as <svg> text."
          onClick={copy}
          className="btn btn-ghost h-8 w-8 px-0"
        >
          <Copy size={15} />
        </ActionButton>
        <div className="flex items-center">
          <ActionButton
            label="Download SVG"
            note="Saves the drawing as a file. Hidden layers are left out."
            onClick={() => download()}
            className="btn btn-primary h-8 gap-1.5 rounded-r-none px-2.5 text-xs"
          >
            <Download size={14} />
            SVG
          </ActionButton>
          <FormatMenu
            label="Other formats: Illustrator, PDF, DXF"
            onPick={download}
            footnote={
              svgOnlyItems > 0
                ? `${svgOnlyItems} imported element${svgOnlyItems === 1 ? '' : 's'} (text, images…) only the SVG can carry; AI, PDF and DXF leave ${svgOnlyItems === 1 ? 'it' : 'them'} out.`
                : null
            }
            className="btn btn-primary h-8 rounded-l-none border-l border-white/25 px-1"
          >
            <ChevronDown size={13} />
          </FormatMenu>
        </div>
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
