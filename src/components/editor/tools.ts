// The editor's tool set and its keyboard shortcuts.
//
// Single letters, matching what Affinity / Illustrator / Figma have trained
// people's hands to expect, so the tool you press for is the tool you get.

export type EditorTool =
  | 'select'
  | 'node'
  | 'pen'
  | 'rect'
  | 'ellipse'
  | 'line'
  | 'polygon'
  | 'star'
  | 'pan'

export interface ToolDef {
  id: EditorTool
  label: string
  /** Single-key shortcut (no modifier). */
  key: string
  hint: string
}

export const TOOLS: ToolDef[] = [
  { id: 'select', label: 'Move', key: 'v', hint: 'Select, move, scale and rotate' },
  { id: 'node', label: 'Node', key: 'a', hint: 'Edit anchors, handles and curves' },
  { id: 'pen', label: 'Pen', key: 'p', hint: 'Draw a path point by point' },
  { id: 'rect', label: 'Rectangle', key: 'r', hint: 'Drag a rectangle (Shift = square)' },
  { id: 'ellipse', label: 'Ellipse', key: 'e', hint: 'Drag an ellipse (Shift = circle)' },
  { id: 'line', label: 'Line', key: 'l', hint: 'Drag a line (Shift = 45°)' },
  { id: 'polygon', label: 'Polygon', key: 'g', hint: 'Drag a hexagon' },
  { id: 'star', label: 'Star', key: 's', hint: 'Drag a five-point star' },
  { id: 'pan', label: 'Pan', key: 'h', hint: 'Pan the view (or hold Space with any tool)' },
]

const BY_KEY = new Map(TOOLS.map((t) => [t.key, t.id]))

/** The tool a bare keypress selects, or null. */
export function toolForKey(key: string): EditorTool | null {
  return BY_KEY.get(key.toLowerCase()) ?? null
}

/** Tools that create a shape by dragging a box. */
export function isDrawTool(tool: EditorTool): boolean {
  return tool === 'rect' || tool === 'ellipse' || tool === 'line' || tool === 'polygon' || tool === 'star'
}
