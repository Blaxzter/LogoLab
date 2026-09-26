// Why each studio action can't be used right now — null when it can.

import { parseNodeKey } from '../../../lib/editor/nodeEdit'
import type { PathItem } from '../../../lib/path/types'

export interface ActionState {
  canUndo: boolean
  canRedo: boolean
  selection: ReadonlySet<string>
  nodeSel: ReadonlySet<string>
  /** Top-level items in the selection. */
  selectedCount: number
  /** Selected paths / groups, counted in one tree walk. */
  sel: { paths: number; groups: number }
  /** The one path the single-path operations act on, or null. */
  activePath: PathItem | null
}

export type ActionReasons = ReturnType<typeof actionReasons>

/**
 * Why each action can't be used right now — null when it can.
 *
 * Drives both the disabled state and its tooltip, so the two can't disagree.
 * Each reason says what would make the action available.
 */
export function actionReasons({ canUndo, canRedo, selection, nodeSel, selectedCount, sel, activePath }: ActionState) {
  const nothing = 'Nothing is selected — click a shape on the canvas or a row in the layers list.'
  const onePath =
    selection.size === 0
      ? 'Select one path.'
      : selection.size > 1
        ? `Select just one path — ${selection.size} items are selected.`
        : 'The selected item is a group or imported markup, not an editable path.'

  return {
    undo: canUndo ? null : 'Nothing to undo — this is the oldest state of the drawing.',
    redo: canRedo ? null : 'Nothing to redo — this is the newest state of the drawing.',
    group:
      selectedCount >= 2
        ? null
        : `Select two or more items to put in a group — ${
            selectedCount === 0 ? 'nothing is selected' : 'only one is selected'
          }.`,
    ungroup: sel.groups > 0 ? null : 'Select a group. A plain shape has nothing to ungroup.',
    selection: selection.size > 0 ? null : nothing,
    remove: selection.size > 0 || nodeSel.size > 0 ? null : nothing,
    reverse: activePath ? null : onePath,
    split: !activePath
      ? onePath
      : activePath.subPaths.length < 2
        ? 'This path has a single subpath, so there is nothing to split apart. Compound paths (a shape with holes) can be split.'
        : null,
    combine:
      sel.paths >= 2
        ? null
        : `Select two or more paths to merge into one compound path — ${
            sel.paths === 1 ? 'only one path is selected' : 'none are selected'
          }.`,
    breakNode:
      nodeSel.size === 1
        ? null
        : `Switch to the Node tool (A) and select exactly one node — ${
            nodeSel.size === 0 ? 'none are selected' : `${nodeSel.size} are selected`
          }.`,
    join: joinReason(nodeSel),
  }
}

/**
 * Join welds two loose ends of the same path, so two nodes on different shapes
 * get their own explanation.
 */
function joinReason(nodeSel: ReadonlySet<string>): string | null {
  if (nodeSel.size !== 2) {
    return `Switch to the Node tool (A) and select the two end nodes to weld — ${
      nodeSel.size === 0 ? 'none are selected' : `${nodeSel.size} are selected`
    }.`
  }
  const [a, b] = [...nodeSel].map(parseNodeKey)
  return a.itemId === b.itemId
    ? null
    : 'Both nodes have to be on the same path. Combine the two shapes first, then join.'
}
