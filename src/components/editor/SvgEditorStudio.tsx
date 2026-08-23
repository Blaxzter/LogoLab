// The SVG editor: toolbar + canvas + layers rail + properties rail, over one
// undoable EditableDoc.
//
// This component owns the document, the selection and the keyboard; the stage
// owns pointer gestures and the panels own their own controls. Keeping the
// keyboard here (rather than on the canvas) is what makes shortcuts work while
// the focus is in the layers list — the one place people reach for Delete.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronsDown,
  ChevronsUp,
  Copy,
  Download,
  Grid3x3,
  Group as GroupIcon,
  Hand,
  Layers,
  Magnet,
  Minus,
  MousePointer2,
  PenTool,
  Redo2,
  Circle as CircleIcon,
  Spline,
  Square as SquareIcon,
  Sparkles,
  Hexagon,
  Trash2,
  Undo2,
  Ungroup,
  X,
} from 'lucide-react'
import type { DocItem, EditableDoc, Stroke } from '../../lib/path/types'
import {
  findItem,
  groupItems,
  isGroup,
  removeItems,
  reorderItems,
  topLevelSelection,
  ungroup,
} from '../../lib/path/docTree'
import { docStats, serializeDoc } from '../../lib/path/model'
import {
  flipAbout,
  scaleAbout,
  selectionBox,
  transformItems,
  translation,
} from '../../lib/editor/transform'
import { alignItems, canDistribute as canDist, distributeItems } from '../../lib/editor/align'
import type { AlignEdge, DistributeAxis } from '../../lib/editor/align'
import { DEFAULT_SNAP, nudgeStep, type SnapConfig } from '../../lib/editor/snapping'
import { deleteNodes, moveNodes } from '../../lib/path/geometry'
import { breakAt, joinEnds, reversePath, splitCompound, combinePaths } from '../../lib/editor/pathOps'
import { useHistory } from '../../hooks/useHistory'
import { usePanZoom } from '../../hooks/usePanZoom'
import { useCheckerClass } from '../../store'
import { ZoomControls } from '../ui/ZoomControls'
import { CheckerToggle } from '../ui/CheckerToggle'
import { Tooltip } from '../ui/Tooltip'
import { downloadText } from '../../lib/download'
import { EditorStage, parseNodeKey } from './EditorStage'
import { LayersTree } from './LayersTree'
import { Inspector } from './Inspector'
import { TOOLS, toolForKey, type EditorTool } from './tools'
import {
  duplicateItems,
  newId,
  renameItem,
  setFill,
  setFillOpacity,
  setFillRule,
  setStroke,
  toggleExpanded,
  toggleVisible,
} from './editorDoc'

const TOOL_ICON: Record<EditorTool, React.ReactNode> = {
  select: <MousePointer2 size={15} />,
  node: <Spline size={15} />,
  pen: <PenTool size={15} />,
  rect: <SquareIcon size={15} />,
  ellipse: <CircleIcon size={15} />,
  line: <Minus size={15} />,
  polygon: <Hexagon size={15} />,
  star: <Sparkles size={15} />,
  pan: <Hand size={15} />,
}

export interface SvgEditorStudioProps {
  /** The document to open. */
  initialDoc: EditableDoc
  /** Suggested download name (without extension). */
  fileName?: string
  /** Leave the editor and go back to the intake screen. */
  onClose: () => void
  /** Optional "send this back to the app" action. */
  onApply?: (svgText: string, width: number, height: number) => void
  applyLabel?: string
}

export function SvgEditorStudio({
  initialDoc,
  fileName = 'drawing',
  onClose,
  onApply,
  applyLabel = 'Use as logo',
}: SvgEditorStudioProps) {
  const history = useHistory<EditableDoc>(120)
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set())
  const [nodeSel, setNodeSel] = useState<ReadonlySet<string>>(new Set())
  const [tool, setTool] = useState<EditorTool>('select')
  const [snap, setSnap] = useState<SnapConfig>(DEFAULT_SNAP)
  const [showGrid, setShowGrid] = useState(false)
  const [penPathId, setPenPathId] = useState<string | null>(null)
  const [enteredGroupId, setEnteredGroupId] = useState<string | null>(null)
  const [applied, setApplied] = useState(false)
  const pz = usePanZoom({ minScale: 1, maxScale: 40, zoomStep: 1.4 })
  const checkerClass = useCheckerClass()

  // Seed the history once per incoming document.
  const seeded = useRef<EditableDoc | null>(null)
  useEffect(() => {
    if (seeded.current === initialDoc) return
    seeded.current = initialDoc
    history.reset(initialDoc)
    setSelection(new Set())
    setNodeSel(new Set())
    setEnteredGroupId(null)
  }, [initialDoc, history])

  const doc = history.value
  const previewDoc = doc ?? initialDoc

  const commit = useCallback(
    (next: EditableDoc) => {
      history.set(next, true)
      setApplied(false)
    },
    [history],
  )
  const preview = useCallback((next: EditableDoc) => history.set(next), [history])

  const box = useMemo(
    () => selectionBox(previewDoc.items, selection),
    [previewDoc.items, selection],
  )
  const stats = useMemo(() => docStats(previewDoc), [previewDoc])
  const svgText = useMemo(() => serializeDoc(previewDoc, 2), [previewDoc])

  /* --------------------------------------------------------- operations */

  const withDoc = useCallback(
    (fn: (d: EditableDoc) => EditableDoc | null) => {
      const next = fn(previewDoc)
      if (next && next !== previewDoc) commit(next)
    },
    [previewDoc, commit],
  )

  const deleteSelection = useCallback(() => {
    // With nodes selected, Delete removes NODES; otherwise it removes items.
    // The node case has to come first or you could never delete a single node
    // from a shape you also have selected — which is always.
    if (nodeSel.size > 0) {
      const byItem = new Map<string, { sub: number; idx: number }[]>()
      for (const key of nodeSel) {
        const ref = parseNodeKey(key)
        const list = byItem.get(ref.itemId) ?? []
        list.push({ sub: ref.sub, idx: ref.idx })
        byItem.set(ref.itemId, list)
      }
      let items = previewDoc.items
      const dropped = new Set<string>()
      for (const [itemId, refs] of byItem) {
        const item = findItem(items, itemId)
        if (!item || item.kind !== 'path') continue
        const next = deleteNodes(item, refs)
        if (next) items = replaceDeep(items, next)
        else dropped.add(itemId)
      }
      if (dropped.size > 0) items = removeItems(items, dropped)
      if (items !== previewDoc.items) {
        commit({ ...previewDoc, items })
        setNodeSel(new Set())
      }
      return
    }
    if (selection.size === 0) return
    commit({ ...previewDoc, items: removeItems(previewDoc.items, selection) })
    setSelection(new Set())
  }, [nodeSel, selection, previewDoc, commit])

  const duplicateSelection = useCallback(() => {
    if (selection.size === 0) return
    const top = topLevelSelection(previewDoc.items, selection)
    const originals = top
      .map((id) => findItem(previewDoc.items, id))
      .filter((it): it is DocItem => it !== null)
    if (originals.length === 0) return
    const copies = duplicateItems(originals)
    const offset = Math.max(previewDoc.viewBox[2], previewDoc.viewBox[3]) * 0.02
    const ids = new Set(copies.map((c) => c.id))
    const items = transformItems(
      [...previewDoc.items, ...copies],
      ids,
      translation(offset, offset),
    )
    commit({ ...previewDoc, items })
    setSelection(ids)
  }, [selection, previewDoc, commit])

  const doGroup = useCallback(() => {
    const res = groupItems(previewDoc.items, selection, newId('g'))
    if (!res) return
    commit({ ...previewDoc, items: res.items })
    setSelection(new Set([res.groupId]))
  }, [previewDoc, selection, commit])

  const doUngroup = useCallback(() => {
    let items = previewDoc.items
    const freed = new Set<string>()
    for (const id of selection) {
      const item = findItem(items, id)
      if (!item || !isGroup(item)) continue
      for (const c of item.children) freed.add(c.id)
      const next = ungroup(items, id)
      if (next) items = next
    }
    if (items === previewDoc.items) return
    commit({ ...previewDoc, items })
    setSelection(freed)
    setEnteredGroupId(null)
  }, [previewDoc, selection, commit])

  const reorder = useCallback(
    (how: 'front' | 'back' | 'forward' | 'backward') => {
      if (selection.size === 0) return
      withDoc((d) => ({ ...d, items: reorderItems(d.items, selection, how) }))
    },
    [selection, withDoc],
  )

  const align = useCallback(
    (edge: AlignEdge) => withDoc((d) => alignItems(d, selection, edge)),
    [selection, withDoc],
  )
  const distribute = useCallback(
    (axis: DistributeAxis) => withDoc((d) => distributeItems(d, selection, axis)),
    [selection, withDoc],
  )
  const flip = useCallback(
    (axis: 'x' | 'y') => {
      if (!box) return
      withDoc((d) => ({ ...d, items: transformItems(d.items, selection, flipAbout(box, axis)) }))
    },
    [box, selection, withDoc],
  )

  /** Numeric geometry entry: resolve X/Y/W/H into a transform of the box. */
  const setGeometry = useCallback(
    (patch: { x?: number; y?: number; w?: number; h?: number }) => {
      if (!box) return
      let items = previewDoc.items
      if (patch.w !== undefined || patch.h !== undefined) {
        const sx = patch.w !== undefined && box.w > 0 ? patch.w / box.w : 1
        const sy = patch.h !== undefined && box.h > 0 ? patch.h / box.h : 1
        // Resize about the top-left, so typing a width doesn't also move the
        // shape — the box origin is what the X/Y fields above it report.
        items = transformItems(items, selection, scaleAbout({ x: box.x, y: box.y }, sx, sy))
      }
      if (patch.x !== undefined || patch.y !== undefined) {
        items = transformItems(
          items,
          selection,
          translation(patch.x !== undefined ? patch.x - box.x : 0, patch.y !== undefined ? patch.y - box.y : 0),
        )
      }
      if (items !== previewDoc.items) commit({ ...previewDoc, items })
    },
    [box, previewDoc, selection, commit],
  )

  const nudge = useCallback(
    (dx: number, dy: number) => {
      if (nodeSel.size > 0) {
        const byItem = new Map<string, { sub: number; idx: number }[]>()
        for (const key of nodeSel) {
          const ref = parseNodeKey(key)
          const list = byItem.get(ref.itemId) ?? []
          list.push({ sub: ref.sub, idx: ref.idx })
          byItem.set(ref.itemId, list)
        }
        let items = previewDoc.items
        for (const [itemId, refs] of byItem) {
          const item = findItem(items, itemId)
          if (!item || item.kind !== 'path') continue
          items = replaceDeep(items, moveNodes(item, refs, dx, dy))
        }
        if (items !== previewDoc.items) commit({ ...previewDoc, items })
        return
      }
      if (selection.size === 0) return
      commit({
        ...previewDoc,
        items: transformItems(previewDoc.items, selection, translation(dx, dy)),
      })
    },
    [nodeSel, selection, previewDoc, commit],
  )

  /* ----------------------------------------------------------- path ops */

  const activePathId = selection.size === 1 ? [...selection][0] : null

  const doReverse = useCallback(() => {
    if (!activePathId) return
    const item = findItem(previewDoc.items, activePathId)
    if (!item || item.kind !== 'path') return
    commit({ ...previewDoc, items: replaceDeep(previewDoc.items, reversePath(item)) })
  }, [activePathId, previewDoc, commit])

  const doBreak = useCallback(() => {
    if (nodeSel.size !== 1) return
    const ref = parseNodeKey([...nodeSel][0])
    const item = findItem(previewDoc.items, ref.itemId)
    if (!item || item.kind !== 'path') return
    commit({ ...previewDoc, items: replaceDeep(previewDoc.items, breakAt(item, ref.sub, ref.idx)) })
    setNodeSel(new Set())
  }, [nodeSel, previewDoc, commit])

  const doJoin = useCallback(() => {
    if (nodeSel.size !== 2) return
    const [a, b] = [...nodeSel].map(parseNodeKey)
    if (a.itemId !== b.itemId) return
    const item = findItem(previewDoc.items, a.itemId)
    if (!item || item.kind !== 'path') return
    const next = joinEnds(item, { sub: a.sub, idx: a.idx }, { sub: b.sub, idx: b.idx })
    if (next === item) return
    commit({ ...previewDoc, items: replaceDeep(previewDoc.items, next) })
    setNodeSel(new Set())
  }, [nodeSel, previewDoc, commit])

  const doSplit = useCallback(() => {
    if (!activePathId) return
    const item = findItem(previewDoc.items, activePathId)
    if (!item || item.kind !== 'path' || item.subPaths.length < 2) return
    const parts = splitCompound(item, () => newId('p'))
    const items = previewDoc.items.flatMap((it) => (it.id === item.id ? parts : [it]))
    commit({ ...previewDoc, items })
    setSelection(new Set(parts.map((p) => p.id)))
  }, [activePathId, previewDoc, commit])

  const doCombine = useCallback(() => {
    const paths = [...selection]
      .map((id) => findItem(previewDoc.items, id))
      .filter((it): it is DocItem => it !== null && it.kind === 'path')
    if (paths.length < 2) return
    const merged = combinePaths(paths as never)
    if (!merged) return
    const keep = new Set(paths.slice(1).map((p) => p.id))
    const items = removeItems(previewDoc.items, keep).map((it) =>
      it.id === merged.id ? merged : it,
    )
    commit({ ...previewDoc, items })
    setSelection(new Set([merged.id]))
  }, [selection, previewDoc, commit])

  /* ---------------------------------------------------------- keyboard */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target
      if (
        t instanceof HTMLElement &&
        (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')
      ) {
        return
      }
      const mod = e.ctrlKey || e.metaKey
      const k = e.key

      if (mod) {
        const lk = k.toLowerCase()
        if (lk === 'z') {
          e.preventDefault()
          if (e.shiftKey) history.redo()
          else history.undo()
        } else if (lk === 'y') {
          e.preventDefault()
          history.redo()
        } else if (lk === 'a') {
          e.preventDefault()
          setSelection(new Set(previewDoc.items.map((it) => it.id)))
        } else if (lk === 'd') {
          e.preventDefault()
          duplicateSelection()
        } else if (lk === 'g') {
          e.preventDefault()
          if (e.shiftKey) doUngroup()
          else doGroup()
        } else if (lk === 'j') {
          e.preventDefault()
          doJoin()
        } else if (lk === ']') {
          e.preventDefault()
          reorder(e.shiftKey ? 'front' : 'forward')
        } else if (lk === '[') {
          e.preventDefault()
          reorder(e.shiftKey ? 'back' : 'backward')
        }
        return
      }

      if (k === 'Delete' || k === 'Backspace') {
        e.preventDefault()
        deleteSelection()
        return
      }
      if (k === 'Escape') {
        if (penPathId) {
          setPenPathId(null)
          setTool('select')
        } else if (nodeSel.size > 0) setNodeSel(new Set())
        else if (enteredGroupId) setEnteredGroupId(null)
        else setSelection(new Set())
        return
      }
      if (k === 'Enter' && penPathId) {
        setPenPathId(null)
        setTool('select')
        return
      }
      if (k.startsWith('Arrow')) {
        e.preventDefault()
        const step = nudgeStep(1, { shift: e.shiftKey, alt: e.altKey })
        const d =
          k === 'ArrowLeft' ? [-step, 0] : k === 'ArrowRight' ? [step, 0] : k === 'ArrowUp' ? [0, -step] : [0, step]
        nudge(d[0], d[1])
        return
      }
      if (!e.altKey && !e.shiftKey) {
        const next = toolForKey(k)
        if (next) {
          setTool(next)
          if (next !== 'pen') setPenPathId(null)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    history, previewDoc, selection, nodeSel, penPathId, enteredGroupId, snap.grid,
    deleteSelection, duplicateSelection, doGroup, doUngroup, doJoin, reorder, nudge,
  ])

  /* ------------------------------------------------------------ export */

  const download = () => downloadText(svgText, `${fileName}.svg`, 'image/svg+xml')
  const copy = () => void navigator.clipboard?.writeText(svgText)
  const apply = () => {
    onApply?.(svgText, previewDoc.viewBox[2], previewDoc.viewBox[3])
    setApplied(true)
  }

  /* ------------------------------------------------------------ render */

  const selectedCount = topLevelSelection(previewDoc.items, selection).length
  const canGroup = selectedCount >= 2
  const canUngroup = [...selection].some((id) => {
    const it = findItem(previewDoc.items, id)
    return it !== null && isGroup(it)
  })

  return (
    <div className="canvas-ui flex h-full min-h-0 w-full shrink-0 flex-col animate-in-fade">
      {/* Toolbar */}
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-line bg-surface px-2">
        <div className="flex items-center gap-0.5 rounded-lg bg-surface-3 p-0.5">
          {TOOLS.map((t) => (
            <Tooltip key={t.id} label={`${t.label} (${t.key.toUpperCase()}) — ${t.hint}`}>
              <button
                type="button"
                aria-label={t.label}
                onClick={() => {
                  setTool(t.id)
                  if (t.id !== 'pen') setPenPathId(null)
                }}
                className={`flex h-8 w-8 items-center justify-center rounded-md transition-colors ${
                  tool === t.id ? 'bg-surface text-accent shadow-xs' : 'text-ink-2 hover:text-ink'
                }`}
              >
                {TOOL_ICON[t.id]}
              </button>
            </Tooltip>
          ))}
        </div>

        <Divider />

        <BarBtn label="Undo (Ctrl+Z)" onClick={history.undo} disabled={!history.canUndo}>
          <Undo2 size={15} />
        </BarBtn>
        <BarBtn label="Redo (Ctrl+Shift+Z)" onClick={history.redo} disabled={!history.canRedo}>
          <Redo2 size={15} />
        </BarBtn>

        <Divider />

        <BarBtn label="Group (Ctrl+G)" onClick={doGroup} disabled={!canGroup}>
          <GroupIcon size={15} />
        </BarBtn>
        <BarBtn label="Ungroup (Ctrl+Shift+G)" onClick={doUngroup} disabled={!canUngroup}>
          <Ungroup size={15} />
        </BarBtn>
        <BarBtn label="Bring to front (Ctrl+Shift+])" onClick={() => reorder('front')} disabled={!selection.size}>
          <ChevronsUp size={15} />
        </BarBtn>
        <BarBtn label="Send to back (Ctrl+Shift+[)" onClick={() => reorder('back')} disabled={!selection.size}>
          <ChevronsDown size={15} />
        </BarBtn>
        <BarBtn label="Duplicate (Ctrl+D)" onClick={duplicateSelection} disabled={!selection.size}>
          <Copy size={15} />
        </BarBtn>
        <BarBtn label="Delete (Del)" onClick={deleteSelection} disabled={!selection.size && !nodeSel.size}>
          <Trash2 size={15} />
        </BarBtn>

        <Divider />

        <BarBtn
          label={snap.enabled ? 'Snapping on' : 'Snapping off'}
          onClick={() => setSnap((s) => ({ ...s, enabled: !s.enabled }))}
          active={snap.enabled}
        >
          <Magnet size={15} />
        </BarBtn>
        <BarBtn label={showGrid ? 'Hide grid' : 'Show grid'} onClick={() => setShowGrid((g) => !g)} active={showGrid}>
          <Grid3x3 size={15} />
        </BarBtn>

        <div className="ml-auto flex items-center gap-1.5">
          {enteredGroupId && (
            <button
              type="button"
              onClick={() => setEnteredGroupId(null)}
              className="btn btn-secondary h-8 gap-1.5 px-2 text-xs"
            >
              <Layers size={13} />
              Leave group
            </button>
          )}
          <CheckerToggle />
          <ZoomControls pz={pz} />
          {onApply && (
            <button
              type="button"
              onClick={apply}
              aria-label={applyLabel}
              className="btn btn-secondary h-8 px-2.5 text-xs"
            >
              {applied ? 'Applied' : applyLabel}
            </button>
          )}
          <Tooltip label="Copy SVG markup">
            <button
              type="button"
              onClick={copy}
              aria-label="Copy SVG markup"
              className="btn btn-ghost h-8 w-8 px-0"
            >
              <Copy size={15} />
            </button>
          </Tooltip>
          <button
            type="button"
            onClick={download}
            aria-label="Download SVG"
            className="btn btn-primary h-8 gap-1.5 px-2.5 text-xs"
          >
            <Download size={14} />
            SVG
          </button>
          <Tooltip label="Close this drawing">
            <button
              type="button"
              onClick={onClose}
              aria-label="Close this drawing"
              className="btn btn-ghost h-8 w-8 px-0"
            >
              <X size={15} />
            </button>
          </Tooltip>
        </div>
      </div>

      {/* Body */}
      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-56 shrink-0 flex-col overflow-y-auto border-r border-line bg-surface md:flex">
          <div className="flex h-9 shrink-0 items-center justify-between border-b border-line px-3">
            <h3 className="field-label">Layers</h3>
            <span className="text-[0.68rem] text-faint">{stats.paths} paths</span>
          </div>
          <LayersTree
            doc={previewDoc}
            selection={selection}
            onSelect={(id, additive) => {
              setNodeSel(new Set())
              setSelection((prev) => {
                if (!additive) return new Set([id])
                const next = new Set(prev)
                if (next.has(id)) next.delete(id)
                else next.add(id)
                return next
              })
            }}
            onToggleVisible={(id) => commit(toggleVisible(previewDoc, id))}
            onToggleExpanded={(id) => preview(toggleExpanded(previewDoc, id))}
            onRename={(id, name) => commit(renameItem(previewDoc, id, name))}
            onDelete={(id) => {
              commit({ ...previewDoc, items: removeItems(previewDoc.items, new Set([id])) })
              setSelection((prev) => {
                const next = new Set(prev)
                next.delete(id)
                return next
              })
            }}
          />
        </aside>

        <div className="relative min-w-0 flex-1 bg-bg">
          <EditorStage
            doc={previewDoc}
            pz={pz}
            tool={tool}
            selection={selection}
            nodeSel={nodeSel}
            snap={snap}
            showGrid={showGrid}
            checkerClass={checkerClass}
            penPathId={penPathId}
            enteredGroupId={enteredGroupId}
            onEnterGroup={setEnteredGroupId}
            onSelectionChange={(ids) => {
              setSelection(ids)
              if (ids.size !== 1) setNodeSel(new Set())
            }}
            onNodeSelChange={setNodeSel}
            onDocChange={preview}
            onDocCommit={commit}
            onPenPathChange={setPenPathId}
            onToolDone={() => setTool('select')}
          />
        </div>

        <aside className="hidden w-64 shrink-0 flex-col overflow-y-auto border-l border-line bg-surface lg:flex">
          <div className="flex h-9 shrink-0 items-center justify-between border-b border-line px-3">
            <h3 className="field-label">Properties</h3>
            {selection.size > 0 && (
              <span className="text-[0.68rem] text-faint">{selectedCount} selected</span>
            )}
          </div>
          <Inspector
            doc={previewDoc}
            selection={selection}
            box={box}
            canDistribute={canDist(previewDoc.items, selection)}
            onFill={(f) => commit(setFill(previewDoc, selection, f))}
            onFillOpacity={(v) => commit(setFillOpacity(previewDoc, selection, v))}
            onFillRule={(r) => commit(setFillRule(previewDoc, selection, r))}
            onStroke={(s: Stroke | null) => commit(setStroke(previewDoc, selection, s))}
            onGeometry={setGeometry}
            onAlign={align}
            onDistribute={distribute}
            onFlip={flip}
          />

          <div className="border-t border-line p-3">
            <h4 className="field-label mb-1.5">Path</h4>
            <div className="grid grid-cols-2 gap-1">
              <MiniBtn label="Reverse" onClick={doReverse} disabled={!activePathId} />
              <MiniBtn label="Split" onClick={doSplit} disabled={!activePathId} />
              <MiniBtn label="Combine" onClick={doCombine} disabled={selection.size < 2} />
              <MiniBtn label="Break node" onClick={doBreak} disabled={nodeSel.size !== 1} />
              <MiniBtn label="Join (Ctrl+J)" onClick={doJoin} disabled={nodeSel.size !== 2} />
            </div>
          </div>
        </aside>
      </div>

      {/* Status */}
      <div className="hidden h-9 shrink-0 items-center gap-3 border-t border-line bg-surface px-3 text-[0.7rem] text-muted md:flex">
        <span>{stats.paths} paths</span>
        <span>{stats.nodes} nodes</span>
        <span>{stats.colors} colours</span>
        <span className="text-faint">
          {previewDoc.viewBox[2]} × {previewDoc.viewBox[3]}
        </span>
        <span className="ml-auto text-faint">
          {tool === 'pen'
            ? 'Click to add points · drag for curves · click the first point to close · Enter to finish'
            : tool === 'node'
              ? 'Drag a curve to bend it · double-click a segment to insert · double-click a node for corner/smooth · Alt-drag a handle to break the joint'
              : 'Hold Space to pan · Shift to constrain · Alt to scale from centre · Ctrl to bypass snapping'}
        </span>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------- helpers */

function Divider() {
  return <span className="mx-1 h-6 w-px shrink-0 bg-line" />
}

function BarBtn({
  label, onClick, disabled, active, children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  active?: boolean
  children: React.ReactNode
}) {
  return (
    <Tooltip label={label}>
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        disabled={disabled}
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors disabled:opacity-35 ${
          active ? 'bg-accent-soft text-accent' : 'text-ink-2 hover:bg-surface-3 hover:text-ink'
        }`}
      >
        {children}
      </button>
    </Tooltip>
  )
}

function MiniBtn({
  label, onClick, disabled,
}: { label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="btn btn-secondary h-7 px-1.5 text-[0.68rem]"
    >
      {label}
    </button>
  )
}

/** Replace a path item anywhere in the tree. */
function replaceDeep(items: readonly DocItem[], next: DocItem): DocItem[] {
  return items.map((it) => {
    if (it.id === next.id) return next
    if (isGroup(it)) {
      const kids = replaceDeep(it.children, next)
      return kids === it.children ? it : { ...it, children: kids }
    }
    return it
  })
}

