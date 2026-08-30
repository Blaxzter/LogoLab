// The SVG editor: toolbar + canvas + layers rail + properties rail, over one
// undoable EditableDoc.
//
// This component owns the document, the selection and the keyboard; the stage
// owns pointer gestures and the panels own their own controls. Keeping the
// keyboard here (rather than on the canvas) is what makes shortcuts work while
// the focus is in the layers list — the one place people reach for Delete.

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronsDown,
  ChevronsUp,
  Copy,
  Download,
  Grid3x3,
  Group as GroupIcon,
  Layers,
  Magnet,
  Redo2,
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
  moveItems,
  removeItems,
  reorderItems,
  topLevelSelection,
  ungroup,
  walkItems,
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
import type { DropSpot } from '../../lib/editor/layerRows'
import { deleteNodes, moveNodes } from '../../lib/path/geometry'
import { breakAt, joinEnds, reversePath, splitCompound, combinePaths } from '../../lib/editor/pathOps'
import { useHistory } from '../../hooks/useHistory'
import { usePanZoom } from '../../hooks/usePanZoom'
import { useCheckerClass } from '../../store'
import { ZoomControls } from '../ui/ZoomControls'
import { CheckerToggle } from '../ui/CheckerToggle'
import { ActionButton, isOff } from '../ui/ActionButton'
import { downloadText } from '../../lib/download'
import { EditorStage, parseNodeKey } from './EditorStage'
import { LayersTree } from './LayersTree'
import { Inspector } from './Inspector'
import { toolDef, toolForKey, type EditorTool } from './tools'
import { TOOL_ICON } from './toolIcons'
import { ShapeFlyout } from './ShapeFlyout'
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

  // The document, for handlers that must stay identity-stable across renders
  // (see the layers rail below) — reading a ref rather than closing over the
  // render's document is what lets them be `useCallback([])`.
  const docRef = useRef(previewDoc)
  docRef.current = previewDoc

  // `history` is a fresh object every render; its methods are not. Depending on
  // the methods keeps every callback built from them stable.
  const { set: historySet, commitMerged: historyMerge } = history

  const commit = useCallback(
    (next: EditableDoc) => {
      historySet(next, true)
      setApplied(false)
    },
    [historySet],
  )
  const preview = useCallback((next: EditableDoc) => historySet(next), [historySet])

  /**
   * A paint edit that arrives as a STREAM — a colour well being scrubbed, an
   * opacity slider being dragged. Every frame is committed (so nothing is left
   * uncommitted when the gesture just stops, which is all a colour picker ever
   * does), but the whole burst folds into one undo entry. Keyed by the control
   * AND the selection, so moving to another shape starts a new entry rather
   * than absorbing it into the last one.
   */
  const selectionKey = useMemo(() => [...selection].sort().join(','), [selection])
  const commitLive = useCallback(
    (next: EditableDoc, control: string) => {
      historyMerge(next, `${control}:${selectionKey}`)
      setApplied(false)
    },
    [historyMerge, selectionKey],
  )

  /** Switch tools. Leaving the pen abandons the path it was drawing. */
  const pickTool = useCallback((next: EditorTool) => {
    setTool(next)
    if (next !== 'pen') setPenPathId(null)
  }, [])

  const box = useMemo(
    () => selectionBox(previewDoc.items, selection),
    [previewDoc.items, selection],
  )
  const stats = useMemo(() => docStats(previewDoc), [previewDoc])
  // Built on demand, NOT memoized per document: serializing rebuilds the `d` of
  // every path in the file, and the only three things that want it are a
  // download, a copy and an apply. Kept as a memo it re-ran on every frame of
  // every drag and every colour scrub, for a string nobody was looking at.
  const buildSvg = useCallback(() => serializeDoc(previewDoc, 2), [previewDoc])

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

  /** A layers-rail drag: drop the moved ids at a paint-order insertion point. */
  const doMove = useCallback(
    (ids: ReadonlySet<string>, to: DropSpot) => {
      const d = docRef.current
      const items = moveItems(d.items, ids, to)
      if (items) commit({ ...d, items })
    },
    [commit],
  )

  /* -------------------------------------------------------- layers rail */

  // The rail lags DELIBERATELY. It is the most expensive thing on screen (one
  // row per item, each with a thumbnail) and the least urgent: during a colour
  // scrub the only thing in it that changes is one 16px swatch. Deferred, React
  // renders it at low priority and simply drops the intermediate frames of a
  // drag — which it can only do if the rail bails out of the urgent render, so
  // `LayersTree` is memoized and every prop below is identity-stable.
  const railDoc = useDeferredValue(previewDoc)

  const selectRows = useCallback((ids: ReadonlySet<string>) => {
    setNodeSel(new Set())
    setSelection(ids)
  }, [])
  const rowToggleVisible = useCallback(
    (id: string) => commit(toggleVisible(docRef.current, id)),
    [commit],
  )
  const rowToggleExpanded = useCallback(
    (id: string) => preview(toggleExpanded(docRef.current, id)),
    [preview],
  )
  const rowRename = useCallback(
    (id: string, name: string) => commit(renameItem(docRef.current, id, name)),
    [commit],
  )
  const rowDelete = useCallback(
    (id: string) => {
      const d = docRef.current
      commit({ ...d, items: removeItems(d.items, new Set([id])) })
      setSelection((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    },
    [commit],
  )

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
        if (next) pickTool(next)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    history, previewDoc, selection, nodeSel, penPathId, enteredGroupId, snap.grid,
    deleteSelection, duplicateSelection, doGroup, doUngroup, doJoin, reorder, nudge, pickTool,
  ])

  /* ------------------------------------------------------------ export */

  const download = () => downloadText(buildSvg(), `${fileName}.svg`, 'image/svg+xml')
  const copy = () => void navigator.clipboard?.writeText(buildSvg())
  const apply = () => {
    onApply?.(buildSvg(), previewDoc.viewBox[2], previewDoc.viewBox[3])
    setApplied(true)
  }

  /* ------------------------------------------------------------ render */

  const selectedCount = topLevelSelection(previewDoc.items, selection).length

  // What is selected, counted in ONE walk. (The previous `findItem` per
  // selected id was a tree search each time — quadratic the moment you press
  // Ctrl+A on a traced document.)
  const sel = useMemo(() => {
    let paths = 0
    let groups = 0
    let other = 0
    walkItems(previewDoc.items, (it) => {
      if (!selection.has(it.id)) return
      if (isGroup(it)) groups++
      else if (it.kind === 'path') paths++
      else other++
    })
    return { paths, groups, other }
  }, [previewDoc.items, selection])

  /** The one path the single-path operations act on, or null. */
  const activePath = useMemo(() => {
    if (!activePathId) return null
    const it = findItem(previewDoc.items, activePathId)
    return it && it.kind === 'path' ? it : null
  }, [activePathId, previewDoc.items])

  /**
   * Why each action can't be used right now — null when it can.
   *
   * One place, so the greyed-out state and the tooltip that explains it can
   * never drift apart, and so every reason is phrased as what WOULD make the
   * button work rather than as a complaint that it doesn't.
   */
  const nothing = 'Nothing is selected — click a shape on the canvas or a row in the layers list.'
  const onePath =
    selection.size === 0
      ? 'Select one path.'
      : selection.size > 1
        ? `Select just one path — ${selection.size} items are selected.`
        : 'The selected item is a group or imported markup, not an editable path.'

  const why = {
    undo: history.canUndo ? null : 'Nothing to undo — this is the oldest state of the drawing.',
    redo: history.canRedo ? null : 'Nothing to redo — this is the newest state of the drawing.',
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

  return (
    <div className="canvas-ui flex h-full min-h-0 w-full shrink-0 flex-col animate-in-fade">
      {/* Toolbar */}
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-line bg-surface px-2">
        {/* Three groups, so the bar says what a tool DOES before you hover it:
            what you select and reshape with, what draws new geometry, the view. */}
        <div className="flex items-center gap-1.5">
          <ToolPill>
            <ToolBtn id="select" tool={tool} onPick={pickTool} />
            <ToolBtn id="node" tool={tool} onPick={pickTool} />
          </ToolPill>
          <ToolPill>
            <ToolBtn id="pen" tool={tool} onPick={pickTool} />
            <ShapeFlyout tool={tool} onPick={pickTool} />
          </ToolPill>
          <ToolPill>
            <ToolBtn id="pan" tool={tool} onPick={pickTool} />
          </ToolPill>
        </div>

        <Divider />

        <BarBtn label="Undo (Ctrl+Z)" onClick={history.undo} reason={why.undo}>
          <Undo2 size={15} />
        </BarBtn>
        <BarBtn label="Redo (Ctrl+Shift+Z)" onClick={history.redo} reason={why.redo}>
          <Redo2 size={15} />
        </BarBtn>

        <Divider />

        <BarBtn
          label={snap.enabled ? 'Snapping on' : 'Snapping off'}
          note="Edges and centres pull towards each other as you drag. Hold Ctrl to bypass it for one drag."
          onClick={() => setSnap((s) => ({ ...s, enabled: !s.enabled }))}
          active={snap.enabled}
        >
          <Magnet size={15} />
        </BarBtn>
        <BarBtn
          label={showGrid ? 'Hide grid' : 'Show grid'}
          note="A reference grid over the artboard. It is never exported."
          onClick={() => setShowGrid((g) => !g)}
          active={showGrid}
        >
          <Grid3x3 size={15} />
        </BarBtn>

        <div className="ml-auto flex items-center gap-1.5">
          {enteredGroupId && (
            <ActionButton
              label="Leave group"
              note="Go back to selecting whole groups instead of the shapes inside this one. Escape does the same."
              onClick={() => setEnteredGroupId(null)}
              className="btn btn-secondary h-8 gap-1.5 px-2 text-xs"
            >
              <Layers size={13} />
              Leave group
            </ActionButton>
          )}
          <CheckerToggle />
          <ZoomControls pz={pz} />
          {onApply && (
            <ActionButton
              label={applyLabel}
              note="Hand this drawing back to the app as the working logo. The editor stays open."
              onClick={apply}
              ariaLabel={applyLabel}
              className="btn btn-secondary h-8 px-2.5 text-xs"
            >
              {applied ? 'Applied' : applyLabel}
            </ActionButton>
          )}
          <ActionButton
            label="Copy SVG markup"
            note="Puts the whole drawing on the clipboard as <svg> text."
            onClick={copy}
            className="btn btn-ghost h-8 w-8 px-0"
          >
            <Copy size={15} />
          </ActionButton>
          <ActionButton
            label="Download SVG"
            note="Saves the drawing as a file. Hidden layers are left out."
            onClick={download}
            className="btn btn-primary h-8 gap-1.5 px-2.5 text-xs"
          >
            <Download size={14} />
            SVG
          </ActionButton>
          <ActionButton
            label="Close this drawing"
            note="Back to the start screen. Unsaved changes are lost."
            onClick={onClose}
            className="btn btn-ghost h-8 w-8 px-0"
          >
            <X size={15} />
          </ActionButton>
        </div>
      </div>

      {/* Body */}
      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-56 shrink-0 flex-col border-r border-line bg-surface md:flex">
          <div className="flex h-9 shrink-0 items-center justify-between border-b border-line px-3">
            <h3 className="field-label">Layers</h3>
            <span className="text-[0.68rem] text-faint">{stats.paths} paths</span>
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

          {/* The layer ops live WITH the layers. They act on the same selection
              the rail shows, and in the top bar they read as "tools" — sat next
              to the pen, they invite the question "what will this draw?". */}
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

/** One segmented group of tool buttons. */
function ToolPill({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-0.5 rounded-lg bg-surface-3 p-0.5">{children}</div>
  )
}

function ToolBtn({
  id, tool, onPick,
}: { id: EditorTool; tool: EditorTool; onPick: (t: EditorTool) => void }) {
  const def = toolDef(id)
  return (
    <ActionButton
      label={`${def.label} (${def.key.toUpperCase()})`}
      note={def.hint}
      ariaLabel={def.label}
      pressed={tool === id}
      onClick={() => onPick(id)}
      className={`flex h-8 w-8 items-center justify-center rounded-md transition-colors ${
        tool === id ? 'bg-surface text-accent shadow-xs' : 'text-ink-2 hover:text-ink'
      }`}
    >
      {TOOL_ICON[id]}
    </ActionButton>
  )
}

function Divider() {
  return <span className="mx-1 h-6 w-px shrink-0 bg-line" />
}

function BarBtn({
  label, note, onClick, reason, active, children,
}: {
  label: string
  note?: string
  onClick: () => void
  reason?: string | null
  active?: boolean
  children: React.ReactNode
}) {
  // Hover styling is DROPPED when the button is off rather than overridden: a
  // greyed control that lights up under the pointer still reads as pressable,
  // and the whole point of keeping it hoverable is the explanation, not the
  // invitation.
  const off = isOff(reason)
  return (
    <ActionButton
      label={label}
      note={note}
      reason={reason}
      onClick={onClick}
      pressed={active}
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors ${
        off
          ? 'cursor-not-allowed text-ink-2 opacity-35'
          : active
            ? 'bg-accent-soft text-accent'
            : 'text-ink-2 hover:bg-surface-3 hover:text-ink'
      }`}
    >
      {children}
    </ActionButton>
  )
}

function MiniBtn({
  label, note, onClick, reason,
}: { label: string; note?: string; onClick: () => void; reason?: string | null }) {
  // `.btn` dims and un-hovers itself off `aria-disabled` (see index.css), so
  // unlike the icon buttons this one needs no conditional class of its own.
  return (
    <ActionButton
      label={label}
      note={note}
      reason={reason}
      onClick={onClick}
      className="btn btn-secondary h-7 px-1.5 text-[0.68rem]"
    >
      {label}
    </ActionButton>
  )
}

/**
 * Join welds two loose ends of ONE path, so "two nodes selected" isn't the
 * whole requirement — two ends of different shapes is the mistake worth naming.
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

