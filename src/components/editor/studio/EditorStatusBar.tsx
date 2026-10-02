// The studio's bottom bar: document counts and the active tool's gesture hints.

import type { EditorTool } from '../tools'

export function EditorStatusBar({
  stats,
  viewBox,
  grow,
  tool,
}: {
  stats: { paths: number; nodes: number; colors: number }
  viewBox: readonly number[]
  /** The artboard follows the drawing. */
  grow: boolean
  tool: EditorTool
}) {
  return (
    <div className="hidden h-9 shrink-0 items-center gap-3 border-t border-line bg-surface px-3 text-[0.7rem] text-muted md:flex">
      <span>{stats.paths} paths</span>
      <span>{stats.nodes} nodes</span>
      <span>{stats.colors} colours</span>
      <span className="text-faint">
        {viewBox[2]} × {viewBox[3]}
        {grow && ' · grows'}
      </span>
      <span className="ml-auto text-faint">
        {tool === 'text'
          ? 'Click to start typing · click a shape to type along its outline · click a text to edit it · Esc to finish'
          : tool === 'pen'
            ? 'Click to add points · drag for curves · click the first point to close · Enter to finish'
            : tool === 'node'
              ? 'Drag a curve to bend it · double-click a segment to insert · double-click a node for corner/smooth · Alt-drag a handle to break the joint · Esc or double-click empty space to finish'
              : 'Double-click a shape to edit its nodes · hold Space to pan · Shift to constrain · Alt to scale from centre · Ctrl to bypass snapping'}
      </span>
    </div>
  )
}
