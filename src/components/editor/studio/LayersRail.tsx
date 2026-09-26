// The left rail: the layers list and the layer operations that act on its selection.

import { ChevronsDown, ChevronsUp, Copy, Group as GroupIcon, Trash2, Ungroup } from 'lucide-react'
import type { EditableDoc } from '../../../lib/path/types'
import type { DropSpot } from '../../../lib/editor/layerRows'
import { LayersTree } from '../LayersTree'
import type { ActionReasons } from './actionReasons'
import { BarBtn } from './EditorButtons'

export interface LayersRailProps {
  /** Deferred document; every callback below must stay identity-stable for the memoized tree. */
  railDoc: EditableDoc
  pathCount: number
  selection: ReadonlySet<string>
  why: ActionReasons
  selectRows: (ids: ReadonlySet<string>) => void
  rowToggleVisible: (id: string) => void
  rowToggleExpanded: (id: string) => void
  rowRename: (id: string, name: string) => void
  doMove: (ids: ReadonlySet<string>, to: DropSpot) => void
  rowDelete: (id: string) => void
  doGroup: () => void
  doUngroup: () => void
  reorder: (how: 'front' | 'back' | 'forward' | 'backward') => void
  duplicateSelection: () => void
  deleteSelection: () => void
}

export function LayersRail({
  railDoc,
  pathCount,
  selection,
  why,
  selectRows,
  rowToggleVisible,
  rowToggleExpanded,
  rowRename,
  doMove,
  rowDelete,
  doGroup,
  doUngroup,
  reorder,
  duplicateSelection,
  deleteSelection,
}: LayersRailProps) {
  return (
    <aside className="hidden w-56 shrink-0 flex-col border-r border-line bg-surface md:flex">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-line px-3">
        <h3 className="field-label">Layers</h3>
        <span className="text-[0.68rem] text-faint">{pathCount} paths</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <LayersTree
          doc={railDoc}
          selection={selection}
          onSelect={selectRows}
          onToggleVisible={rowToggleVisible}
          onToggleExpanded={rowToggleExpanded}
          onRename={rowRename}
          onMove={doMove}
          onDelete={rowDelete}
        />
      </div>

      {/* Layer operations sit with the layers list, whose selection they
          act on, rather than in the toolbar where they'd read as drawing tools. */}
      <div className="flex shrink-0 items-center gap-0.5 border-t border-line px-1.5 py-1.5">
        <BarBtn label="Group (Ctrl+G)" onClick={doGroup} reason={why.group}>
          <GroupIcon size={15} />
        </BarBtn>
        <BarBtn label="Ungroup (Ctrl+Shift+G)" onClick={doUngroup} reason={why.ungroup}>
          <Ungroup size={15} />
        </BarBtn>
        <BarBtn
          label="Bring to front (Ctrl+Shift+])"
          note="Paints the selection above everything else in its group."
          onClick={() => reorder('front')}
          reason={why.selection}
        >
          <ChevronsUp size={15} />
        </BarBtn>
        <BarBtn
          label="Send to back (Ctrl+Shift+[)"
          note="Paints the selection below everything else in its group."
          onClick={() => reorder('back')}
          reason={why.selection}
        >
          <ChevronsDown size={15} />
        </BarBtn>
        <BarBtn
          label="Duplicate (Ctrl+D)"
          note="Copies the selection, nudged slightly so it isn't hidden behind the original."
          onClick={duplicateSelection}
          reason={why.selection}
        >
          <Copy size={15} />
        </BarBtn>
        <BarBtn
          label="Delete (Del)"
          note="Removes the selected shapes — or, with the Node tool, just the selected nodes."
          onClick={deleteSelection}
          reason={why.remove}
        >
          <Trash2 size={15} />
        </BarBtn>
      </div>
    </aside>
  )
}
