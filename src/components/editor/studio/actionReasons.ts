// Why each studio action can't be used right now — null when it can.

import { parseNodeKey } from '../../../lib/editor/nodeEdit.ts'
import type { PathReach } from '../../../lib/editor/simplify.ts'
import type { PathItem } from '../../../lib/path/types.ts'

export interface ActionState {
  canUndo: boolean
  canRedo: boolean
  selection: ReadonlySet<string>
  nodeSel: ReadonlySet<string>
  /** Top-level items in the selection. */
  selectedCount: number
  /** Selected paths / groups (and how many of those groups clip), counted in one tree walk. */
  sel: { paths: number; groups: number; clipGroups: number }
  /** The one path the single-path operations act on, or null. */
  activePath: PathItem | null
  /** The editor holds a copy, or the system clipboard can be read. */
  canPaste: boolean
  /** The selection holds a path (walking into groups) whose paint "select same" can match. */
  hasPaint: boolean
  /** What Outline stroke and Simplify would act on (`pathReach`). */
  reach: PathReach
}

export type ActionReasons = ReturnType<typeof actionReasons>

/**
 * Why each action can't be used right now — null when it can.
 *
 * Drives both the disabled state and its tooltip, so the two can't disagree.
 * Each reason says what would make the action available.
 */
export function actionReasons({
  canUndo,
  canRedo,
  selection,
  nodeSel,
  selectedCount,
  sel,
  activePath,
  canPaste,
  hasPaint,
  reach,
}: ActionState) {
  const nothing = 'Nothing is selected. Click a shape on the canvas or a row in the layers list.'
  const onePath =
    selection.size === 0
      ? 'Select one path.'
      : selection.size > 1
        ? `Select just one path (${selection.size} items are selected).`
        : 'The selected item is a group or imported markup, so it can\u2019t be edited as a path.'

  return {
    undo: canUndo ? null : 'Nothing to undo. This is the oldest state of the drawing.',
    redo: canRedo ? null : 'Nothing to redo. This is the newest state of the drawing.',
    group: selectedCount >= 1 ? null : 'Select one or more items to group.',
    ungroup:
      sel.groups > sel.clipGroups
        ? null
        : sel.clipGroups > 0
          ? 'A clip group can’t be ungrouped: its contents would show everything the clip hides. Release the clip first.'
          : 'Select a group. A plain shape has nothing to ungroup.',
    releaseClip: sel.clipGroups > 0 ? null : 'Select a clip group. Only a group with a clip has one to release.',
    selection: selection.size > 0 ? null : nothing,
    paste: canPaste ? null : 'Nothing to paste. Copy a shape first (Ctrl+C), or paste SVG markup with Ctrl+V.',
    remove: selection.size > 0 || nodeSel.size > 0 ? null : nothing,
    selectSame:
      selection.size === 0
        ? 'Nothing is selected. Select a shape whose paint you want to find everywhere else.'
        : hasPaint
          ? null
          : 'The selection has no shape to take a paint from. Imported markup keeps its own paint, so it can’t be matched.',
    reverse: activePath ? null : onePath,
    split: !activePath
      ? onePath
      : activePath.subPaths.length < 2
        ? 'This path has only one subpath, so there is nothing to split. Only compound paths (a shape with holes) can be split.'
        : null,
    outlineStroke:
      selection.size === 0
        ? nothing
        : reach.stroked > 0
          ? null
          : reach.texts > 0
            ? 'Live text can’t be outlined. Convert it to curves first, then outline its stroke.'
            : 'None of the selected shapes has a stroke. Give one an outline in the Stroke section first.',
    simplify:
      selection.size === 0
        ? nothing
        : reach.simplifiable > 0
          ? null
          : reach.texts > 0
            ? 'Live text is rebuilt from its font, so it can’t be simplified. Convert it to curves first.'
            : 'Nothing to simplify: the selection has no path with three or more nodes.',
    combine:
      sel.paths >= 2
        ? null
        : `Select two or more paths to merge into one compound path (${
            sel.paths === 1 ? 'only one path is selected' : 'none are selected'
          }).`,
    breakNode:
      nodeSel.size === 1
        ? null
        : `Switch to the Node tool (A) and select exactly one node (${
            nodeSel.size === 0 ? 'none are selected' : `${nodeSel.size} are selected`
          }).`,
    join: joinReason(nodeSel),
    // With one shape, Add merges that shape's own overlapping contours.
    add:
      selectedCount >= 2 || (selectedCount === 1 && (sel.paths > 0 || sel.groups > 0))
        ? null
        : 'Select two or more shapes to merge, or one shape to merge its own overlapping contours.',
    boolean:
      selectedCount >= 2
        ? null
        : `Select two or more shapes to combine (${
            selectedCount === 0 ? 'nothing is selected' : 'only one is selected'
          }). A group counts as one shape.`,
  }
}

/**
 * Join welds two loose ends of the same path, so two nodes on different shapes
 * get their own explanation.
 */
function joinReason(nodeSel: ReadonlySet<string>): string | null {
  if (nodeSel.size !== 2) {
    return `Switch to the Node tool (A) and select the two end nodes to weld (${
      nodeSel.size === 0 ? 'none are selected' : `${nodeSel.size} are selected`
    }).`
  }
  const [a, b] = [...nodeSel].map(parseNodeKey)
  return a.itemId === b.itemId
    ? null
    : 'Both nodes have to be on the same path. Combine the two shapes first, then join.'
}
