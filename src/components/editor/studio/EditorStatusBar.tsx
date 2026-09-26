// The studio's bottom bar: document counts and the active tool's gesture hints.

import type { EditorTool } from '../tools'

export function EditorStatusBar({
  stats,
  viewBox,
  tool,
}: {
  stats: { paths: number; nodes: number; colors: number }
  viewBox: readonly number[]
  tool: EditorTool
}) {
  return (
    <div className="hidden h-9 shrink-0 items-center gap-3 border-t border-line bg-surface px-3 text-[0.7rem] text-muted md:flex">
      <span>{stats.paths} paths</span>
      <span>{stats.nodes} nodes</span>
      <span>{stats.colors} colours</span>
      <span className="text-faint">
        {viewBox[2]} × {viewBox[3]}
      </span>
      <span className="ml-auto text-faint">
        {tool === 'pen'
          ? 'Click to add points · drag for curves · click the first point to close · Enter to finish'
          : tool === 'node'
            ? 'Drag a curve to bend it · double-click a segment to insert · double-click a node for corner/smooth · Alt-drag a handle to break the joint'
            : 'Hold Space to pan · Shift to constrain · Alt to scale from centre · Ctrl to bypass snapping'}
      </span>
    </div>
  )
}
