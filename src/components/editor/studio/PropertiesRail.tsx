// The right rail: the inspector over the selection, then the single-path operations.

import type { EditableDoc, Stroke } from '../../../lib/path/types'
import type { Box } from '../../../lib/editor/transform'
import { canDistribute as canDist } from '../../../lib/editor/align'
import type { AlignEdge, DistributeAxis } from '../../../lib/editor/align'
import { Inspector } from '../Inspector'
import { setFill, setFillOpacity, setFillRule, setStroke } from '../editorDoc'
import type { ActionReasons } from './actionReasons'
import { MiniBtn } from './EditorButtons'

export interface PropertiesRailProps {
  previewDoc: EditableDoc
  selection: ReadonlySet<string>
  selectedCount: number
  box: Box | null
  why: ActionReasons
  commit: (next: EditableDoc) => void
  commitLive: (next: EditableDoc, control: string) => void
  setGeometry: (patch: { x?: number; y?: number; w?: number; h?: number }) => void
  align: (edge: AlignEdge) => void
  distribute: (axis: DistributeAxis) => void
  flip: (axis: 'x' | 'y') => void
  doReverse: () => void
  doSplit: () => void
  doCombine: () => void
  doBreak: () => void
  doJoin: () => void
}

export function PropertiesRail({
  previewDoc,
  selection,
  selectedCount,
  box,
  why,
  commit,
  commitLive,
  setGeometry,
  align,
  distribute,
  flip,
  doReverse,
  doSplit,
  doCombine,
  doBreak,
  doJoin,
}: PropertiesRailProps) {
  return (
    <aside className="hidden w-64 shrink-0 flex-col overflow-y-auto border-l border-line bg-surface lg:flex">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-line px-3">
        <h3 className="field-label">Properties</h3>
        {selection.size > 0 && <span className="text-[0.68rem] text-faint">{selectedCount} selected</span>}
      </div>
      <Inspector
        doc={previewDoc}
        selection={selection}
        box={box}
        canDistribute={canDist(previewDoc.items, selection)}
        onFill={(f, live) => {
          const next = setFill(previewDoc, selection, f)
          if (live) commitLive(next, 'fill')
          else commit(next)
        }}
        onFillOpacity={(v, live) => {
          const next = setFillOpacity(previewDoc, selection, v)
          if (live) commitLive(next, 'fillOpacity')
          else commit(next)
        }}
        onFillRule={(r) => commit(setFillRule(previewDoc, selection, r))}
        onStroke={(s: Stroke | null, live?: boolean) => {
          const next = setStroke(previewDoc, selection, s)
          if (live) commitLive(next, 'stroke')
          else commit(next)
        }}
        onGeometry={setGeometry}
        onAlign={align}
        onDistribute={distribute}
        onFlip={flip}
      />

      <div className="border-t border-line p-3">
        <h4 className="field-label mb-1.5">Path</h4>
        <div className="grid grid-cols-2 gap-1">
          <MiniBtn
            label="Reverse"
            note="Flips the direction the path is drawn in. Changes which side a non-zero fill treats as inside."
            onClick={doReverse}
            reason={why.reverse}
          />
          <MiniBtn
            label="Split"
            note="Breaks a compound path into one separate shape per subpath."
            onClick={doSplit}
            reason={why.split}
          />
          <MiniBtn
            label="Combine"
            note="Merges the selected paths into one compound path, set to even-odd so overlaps cut holes."
            onClick={doCombine}
            reason={why.combine}
          />
          <MiniBtn
            label="Break node"
            note="Splits the path open at the selected node, leaving two loose ends."
            onClick={doBreak}
            reason={why.breakNode}
          />
          <MiniBtn
            label="Join (Ctrl+J)"
            note="Welds two loose ends of the same path back together."
            onClick={doJoin}
            reason={why.join}
          />
        </div>
      </div>
    </aside>
  )
}
