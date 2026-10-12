// What the editor's context menu offers for what was right-clicked. Pure, so a test can read it.
//
// Two rules decide whether an entry shows. A command that cannot apply to this
// KIND of target is left out (no Ungroup on a lone rectangle, no booleans on
// one shape), so the menu stays short and about the thing under the pointer.
// A command that applies but is blocked right now stays, disabled, carrying
// the same reason the toolbar's button gives (`actionReasons`).

import type { ActionReasons } from './actionReasons'

export type MenuTarget =
  | { kind: 'canvas' }
  | { kind: 'items'; from: 'canvas' | 'layers' }
  | { kind: 'nodes' }
  | { kind: 'segment' }

export type EditorAction =
  | 'editNodes'
  | 'editText'
  | 'enterGroup'
  | 'leaveGroup'
  | 'doneNodes'
  | 'rename'
  | 'toggleHidden'
  | 'duplicate'
  | 'delete'
  | 'group'
  | 'ungroup'
  | 'front'
  | 'forward'
  | 'backward'
  | 'back'
  | 'flipX'
  | 'flipY'
  | 'bool:add'
  | 'bool:subtract'
  | 'bool:intersect'
  | 'bool:xor'
  | 'bool:divide'
  | 'combine'
  | 'split'
  | 'reverse'
  | 'convertText'
  | 'selectAll'
  | 'undo'
  | 'redo'
  | 'toggleSnap'
  | 'toggleGrid'
  | 'smooth'
  | 'corner'
  | 'breakNode'
  | 'join'
  | 'addNode'

export interface EditorMenuItem {
  kind: 'item'
  action: EditorAction
  label: string
  shortcut?: string
  reason: string | null
  danger?: boolean
  checked?: boolean
}
export type EditorMenuEntry = EditorMenuItem | { kind: 'sep' }

export interface EditorMenuContext {
  why: ActionReasons
  /** Top-level items selected. */
  selectedCount: number
  /** What the one selected item is, when exactly one is. */
  single: 'path' | 'group' | 'text' | 'other' | null
  /** The selection holds a live text. */
  hasText: boolean
  /** Every selected item is hidden (only reachable from the layers list). */
  allHidden: boolean
  enteredGroup: boolean
  nodeTool: boolean
  showGrid: boolean
  snapOn: boolean
  /** Selected nodes by kind. */
  nodeKinds: { smooth: number; corner: number }
}

const item = (action: EditorAction, label: string, reason: string | null, extra: Partial<EditorMenuItem> = {}) =>
  ({ kind: 'item', action, label, reason, ...extra }) as EditorMenuItem
const SEP = { kind: 'sep' } as const

export function editorMenu(target: MenuTarget, ctx: EditorMenuContext): EditorMenuEntry[] {
  const { why } = ctx
  const out: (EditorMenuEntry | null | false)[] = []

  if (target.kind === 'canvas') {
    out.push(
      item('selectAll', 'Select all', null, { shortcut: 'Ctrl+A' }),
      item('undo', 'Undo', why.undo, { shortcut: 'Ctrl+Z' }),
      item('redo', 'Redo', why.redo, { shortcut: 'Ctrl+Shift+Z' }),
      SEP,
      item('toggleSnap', 'Snapping', null, { checked: ctx.snapOn }),
      item('toggleGrid', 'Show grid', null, { checked: ctx.showGrid }),
      SEP,
      ctx.enteredGroup && item('leaveGroup', 'Leave group', null, { shortcut: 'Esc' }),
      ctx.nodeTool && item('doneNodes', 'Done editing nodes', null, { shortcut: 'Esc' }),
    )
    return tidy(out)
  }

  if (target.kind === 'segment') {
    out.push(
      item('addNode', 'Add node here', null),
      SEP,
      item('doneNodes', 'Done editing nodes', null, { shortcut: 'Esc' }),
    )
    return tidy(out)
  }

  if (target.kind === 'nodes') {
    const { smooth, corner } = ctx.nodeKinds
    const many = smooth + corner > 1
    out.push(
      item('smooth', 'Make smooth', corner === 0 ? alreadyAll('smooth', many) : null),
      item('corner', 'Make corner', smooth === 0 ? alreadyAll('a corner', many) : null),
      SEP,
      item('breakNode', 'Break at node', why.breakNode),
      item('join', 'Join ends', why.join, { shortcut: 'Ctrl+J' }),
      SEP,
      item('delete', many ? 'Delete nodes' : 'Delete node', why.remove, { shortcut: 'Del', danger: true }),
      SEP,
      item('doneNodes', 'Done editing nodes', null, { shortcut: 'Esc' }),
    )
    return tidy(out)
  }

  // Items, from the canvas or the layers list.
  const layers = target.from === 'layers'
  const one = ctx.single
  out.push(
    one === 'path' && !ctx.nodeTool && item('editNodes', 'Edit nodes', null),
    one === 'text' && item('editText', 'Edit text', null),
    one === 'group' && !layers && item('enterGroup', 'Enter group', null),
    layers && ctx.selectedCount === 1 && item('rename', 'Rename', null),
    SEP,
    item('duplicate', 'Duplicate', why.selection, { shortcut: 'Ctrl+D' }),
    item('toggleHidden', ctx.allHidden ? 'Show' : 'Hide', why.selection),
    item('delete', 'Delete', why.remove, { shortcut: 'Del', danger: true }),
    SEP,
    // Always offered: one item is "not yet" (select another), not "never".
    item('group', 'Group', why.group, { shortcut: 'Ctrl+G' }),
    why.ungroup === null && item('ungroup', 'Ungroup', null, { shortcut: 'Ctrl+Shift+G' }),
    SEP,
    item('front', 'Bring to front', why.selection, { shortcut: 'Ctrl+Shift+]' }),
    item('forward', 'Bring forward', why.selection, { shortcut: 'Ctrl+]' }),
    item('backward', 'Send backward', why.selection, { shortcut: 'Ctrl+[' }),
    item('back', 'Send to back', why.selection, { shortcut: 'Ctrl+Shift+[' }),
    SEP,
    item('flipX', 'Flip horizontal', why.selection),
    item('flipY', 'Flip vertical', why.selection),
    SEP,
    ctx.selectedCount >= 2 && item('bool:add', 'Add', why.add),
    ctx.selectedCount >= 2 && item('bool:subtract', 'Subtract', why.boolean),
    ctx.selectedCount >= 2 && item('bool:intersect', 'Intersect', why.boolean),
    ctx.selectedCount >= 2 && item('bool:xor', 'Xor', why.boolean),
    ctx.selectedCount >= 2 && item('bool:divide', 'Divide', why.boolean),
    SEP,
    why.combine === null && item('combine', 'Combine paths', null),
    one === 'path' && why.split === null && item('split', 'Split subpaths', null),
    one === 'path' && item('reverse', 'Reverse direction', why.reverse),
    ctx.hasText && item('convertText', 'Convert to curves', null),
  )
  return tidy(out)
}

function alreadyAll(kind: string, many: boolean): string {
  return many ? `Every selected node is already ${kind}.` : `This node is already ${kind}.`
}

/** Drop the falsy slots, and every separator that would lead, trail or double up. */
function tidy(list: (EditorMenuEntry | null | false)[]): EditorMenuEntry[] {
  const out: EditorMenuEntry[] = []
  for (const e of list) {
    if (!e) continue
    if (e.kind === 'sep' && (out.length === 0 || out[out.length - 1].kind === 'sep')) continue
    out.push(e)
  }
  while (out.length > 0 && out[out.length - 1].kind === 'sep') out.pop()
  return out
}
