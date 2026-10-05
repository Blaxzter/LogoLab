// The right rail: the inspector over the selection, then the single-path operations.

import type { EditableDoc, Stroke, TextData } from '../../../lib/path/types'
import { TextPanel } from '../TextPanel'
import type { TextEditing } from './useTextEditing'
import type { Box } from '../../../lib/editor/transform'
import { canDistribute as canDist } from '../../../lib/editor/align'
import type { AlignEdge, DistributeAxis } from '../../../lib/editor/align'
import { Inspector } from '../Inspector'
import { setFill, setFillOpacity, setFillRule, setStroke } from '../editorDoc'
import type { ActionReasons } from './actionReasons'
import type { BooleanOp } from '../../../lib/editor/boolean'
import {
  ArrowRightLeft,
  Combine,
  Link2,
  Scissors,
  Split,
  SquareSplitHorizontal,
  SquaresExclude,
  SquaresIntersect,
  SquaresSubtract,
  SquaresUnite,
} from '../../ui/icons'
import { BarBtn, MiniBtn } from './EditorButtons'
import { BASE } from '../stage/stageConstants'

/** The shape booleans, in Affinity's toolbar order. */
const BOOLEANS: { op: BooleanOp; label: string; note: string; icon: React.ReactNode }[] = [
  {
    op: 'add',
    label: 'Add',
    note: 'Merges the selected shapes into one outline in the base’s paint (the shape you selected first). With one shape selected, it merges that shape’s overlapping contours.',
    icon: <SquaresUnite size={15} />,
  },
  {
    op: 'subtract',
    label: 'Subtract',
    note: 'Cuts the other shapes out of the base (the one you selected first, outlined in teal).',
    icon: <SquaresSubtract size={15} />,
  },
  {
    op: 'intersect',
    label: 'Intersect',
    note: 'Keeps only where all the selected shapes overlap.',
    icon: <SquaresIntersect size={15} />,
  },
  {
    op: 'xor',
    label: 'Xor',
    note: 'Keeps the parts where the shapes don’t overlap. The overlaps become holes.',
    icon: <SquaresExclude size={15} />,
  },
  {
    op: 'divide',
    label: 'Divide',
    note: 'Cuts the shapes apart at every crossing into separate pieces, each keeping the paint it showed.',
    icon: <SquareSplitHorizontal size={15} />,
  },
]

export interface PropertiesRailProps {
  previewDoc: EditableDoc
  selection: ReadonlySet<string>
  selectedCount: number
  box: Box | null
  why: ActionReasons
  commit: (next: EditableDoc) => void
  commitLive: (next: EditableDoc, control: string) => void
  setGeometry: (patch: { x?: number; y?: number; w?: number; h?: number }, live?: boolean) => void
  align: (edge: AlignEdge) => void
  distribute: (axis: DistributeAxis) => void
  flip: (axis: 'x' | 'y') => void
  doReverse: () => void
  doSplit: () => void
  doCombine: () => void
  doBreak: () => void
  doJoin: () => void
  doBoolean: (op: BooleanOp) => void
  /** Set when a text is open or selected. */
  panelText: TextData | null
  /** The layer name of the boolean base, when several shapes are selected. */
  baseLabel: string | null
  text: TextEditing
  convertText: () => void
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
  doBoolean,
  panelText,
  baseLabel,
  text,
  convertText,
}: PropertiesRailProps) {
  return (
    <aside className="hidden w-64 shrink-0 flex-col overflow-y-auto border-l border-line bg-surface lg:flex">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-line px-3">
        <h3 className="field-label">Properties</h3>
        {selection.size > 0 && <span className="text-[0.68rem] text-faint">{selectedCount} selected</span>}
      </div>
      {panelText && (
        <div className="border-b border-line p-3">
          <TextPanel data={panelText} text={text} onConvert={convertText} />
        </div>
      )}
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
        onArtboard={(next, live) => {
          if (next === previewDoc) return
          if (live) commitLive(next, 'artboard')
          else commit(next)
        }}
      />

      <div className="border-t border-line p-3">
        <h4 className="field-label mb-1.5">Shape</h4>
        <div className="flex items-center gap-0.5">
          {BOOLEANS.map((b) => (
            <BarBtn
              key={b.op}
              label={b.label}
              note={b.note}
              onClick={() => doBoolean(b.op)}
              reason={b.op === 'add' ? why.add : why.boolean}
            >
              {b.icon}
            </BarBtn>
          ))}
        </div>
        {baseLabel && (
          <p className="mt-1.5 flex items-start gap-1.5 text-[0.68rem] leading-snug text-muted">
            <span className="mt-[3px] h-2 w-2 shrink-0 rounded-full" style={{ background: BASE }} />
            <span>
              Base: <span className="font-medium text-ink">{baseLabel}</span> (selected first). Subtract cuts the others
              out of it, and the result keeps its colour.
            </span>
          </p>
        )}
      </div>

      <div className="border-t border-line p-3">
        <h4 className="field-label mb-1.5">Path</h4>
        <div className="grid grid-cols-2 gap-1">
          <MiniBtn
            label="Reverse"
            icon={<ArrowRightLeft size={13} />}
            note="Flips the direction the path is drawn in. Changes which side a non-zero fill treats as inside."
            onClick={doReverse}
            reason={why.reverse}
          />
          <MiniBtn
            label="Split"
            icon={<Split size={13} />}
            note="Breaks a compound path into one separate shape per subpath."
            onClick={doSplit}
            reason={why.split}
          />
          <MiniBtn
            label="Combine"
            icon={<Combine size={13} />}
            note="Merges the selected paths into one compound path, set to even-odd so overlaps cut holes."
            onClick={doCombine}
            reason={why.combine}
          />
          <MiniBtn
            label="Break node"
            icon={<Scissors size={13} />}
            note="Splits the path open at the selected node, leaving two loose ends."
            onClick={doBreak}
            reason={why.breakNode}
          />
          <MiniBtn
            label="Join"
            icon={<Link2 size={13} />}
            shortcut="Ctrl+J"
            note="Welds two loose ends of the same path back together."
            onClick={doJoin}
            reason={why.join}
          />
        </div>
      </div>
    </aside>
  )
}
