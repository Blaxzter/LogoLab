// The studio's state: undoable document, selection, tool and view, every command, and the keyboard.

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import type { EditableDoc } from '../../../lib/path/types'
import { groupItems, moveItems, removeItems, reorderItems } from '../../../lib/path/docTree'
import { docStats, serializeDoc } from '../../../lib/path/model'
import { flipAbout, selectionBox, transformItems, translation } from '../../../lib/editor/transform'
import { alignItems, distributeItems } from '../../../lib/editor/align'
import type { AlignEdge, DistributeAxis } from '../../../lib/editor/align'
import { DEFAULT_SNAP, nudgeStep, type SnapConfig } from '../../../lib/editor/snapping'
import type { DropSpot } from '../../../lib/editor/layerRows'
import { applyNodeMove, parseNodeKey } from '../../../lib/editor/nodeEdit'
import { useHistory } from '../../../hooks/useHistory'
import { usePanZoom } from '../../../hooks/usePanZoom'
import { svgPrefersDarkChecker } from '../../../lib/image'
import { useCheckerClass, useStore } from '../../../state/store'
import { toolForKey, type EditorTool } from '../tools'
import { newId, renameItem, toggleExpanded, toggleVisible } from '../editorDoc'
import {
  breakNodeIn,
  combineSelected,
  deleteSelectedNodes,
  duplicateSelected,
  joinNodesIn,
  reversePathIn,
  setSelectionGeometry,
  splitPathIn,
  ungroupSelected,
} from '../selectionOps'
import { isTypingTarget } from '../stage/useSpaceHeld'

export function useEditorModel(initialDoc: EditableDoc, onChange: ((doc: EditableDoc) => void) | undefined) {
  const history = useHistory<EditableDoc>(120)
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set())
  const [nodeSel, setNodeSel] = useState<ReadonlySet<string>>(new Set())
  const [tool, setTool] = useState<EditorTool>('select')
  const [snap, setSnap] = useState<SnapConfig>(DEFAULT_SNAP)
  const [showGrid, setShowGrid] = useState(false)
  const [penPathId, setPenPathId] = useState<string | null>(null)
  const [enteredGroupId, setEnteredGroupId] = useState<string | null>(null)
  const pz = usePanZoom({ minScale: 1, maxScale: 40, zoomStep: 1.4 })
  const checkerClass = useCheckerClass()
  const autoChecker = useStore((s) => s.autoChecker)

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

  // Pick a light or dark checker from the artwork on open (white line-art is
  // invisible on the light one); a manual choice always wins. Only on open, so
  // the backdrop doesn't flip while you paint.
  useEffect(() => {
    // An empty artboard gives no signal; leave the backdrop alone.
    if (docStats(initialDoc).paths === 0) return
    let alive = true
    void svgPrefersDarkChecker(serializeDoc(initialDoc)).then((dark) => {
      if (alive) autoChecker(dark)
    })
    return () => {
      alive = false
    }
  }, [initialDoc, autoChecker])

  const doc = history.value
  const previewDoc = doc ?? initialDoc

  useEffect(() => {
    if (doc) onChange?.(doc)
  }, [doc, onChange])

  // Read through a ref so handlers passed to the layers rail can stay
  // identity-stable (`useCallback([])`).
  const docRef = useRef(previewDoc)
  docRef.current = previewDoc

  // `history` is a fresh object every render; its methods are not. Depending on
  // the methods keeps every callback built from them stable.
  const { set: historySet, commitMerged: historyMerge } = history

  const commit = useCallback((next: EditableDoc) => historySet(next, true), [historySet])
  const preview = useCallback((next: EditableDoc) => historySet(next), [historySet])

  /**
   * Commit a streamed paint edit (a scrubbed colour well, a dragged slider).
   * Every frame is committed, since a colour picker has no "end" event, but the
   * burst merges into one undo entry keyed by control and selection, so
   * switching shapes starts a new entry.
   */
  const selectionKey = useMemo(() => [...selection].sort().join(','), [selection])
  const commitLive = useCallback(
    (next: EditableDoc, control: string) => historyMerge(next, `${control}:${selectionKey}`),
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
  // Built on demand rather than memoized: serializing is expensive and only
  // download/copy need it, so a memo would rerun on every drag frame for nothing.
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
    // Selected nodes take precedence over selected items: a node is always
    // selected together with its shape, so checking items first would make
    // deleting a single node impossible.
    if (nodeSel.size > 0) {
      const next = deleteSelectedNodes(previewDoc, nodeSel)
      if (next) {
        commit(next)
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
    const res = duplicateSelected(previewDoc, selection)
    if (!res) return
    commit(res.doc)
    setSelection(res.ids)
  }, [selection, previewDoc, commit])

  const doGroup = useCallback(() => {
    const res = groupItems(previewDoc.items, selection, newId('g'))
    if (!res) return
    commit({ ...previewDoc, items: res.items })
    setSelection(new Set([res.groupId]))
  }, [previewDoc, selection, commit])

  const doUngroup = useCallback(() => {
    const res = ungroupSelected(previewDoc, selection)
    if (!res) return
    commit(res.doc)
    setSelection(res.freed)
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

  // The rail renders from a deferred document: it is the most expensive and
  // least urgent thing on screen (a thumbnail per row). Deferral only helps if
  // the rail bails out of the urgent render, so `LayersTree` is memoized and
  // every prop below must stay identity-stable.
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
      const next = setSelectionGeometry(previewDoc, selection, box, patch)
      if (next) commit(next)
    },
    [box, previewDoc, selection, commit],
  )

  const nudge = useCallback(
    (dx: number, dy: number) => {
      if (nodeSel.size > 0) {
        const next = applyNodeMove(previewDoc, [...nodeSel].map(parseNodeKey), { x: dx, y: dy })
        if (next !== previewDoc) commit(next)
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
    const next = reversePathIn(previewDoc, activePathId)
    if (next) commit(next)
  }, [activePathId, previewDoc, commit])

  const doBreak = useCallback(() => {
    if (nodeSel.size !== 1) return
    const next = breakNodeIn(previewDoc, [...nodeSel][0])
    if (!next) return
    commit(next)
    setNodeSel(new Set())
  }, [nodeSel, previewDoc, commit])

  const doJoin = useCallback(() => {
    if (nodeSel.size !== 2) return
    const next = joinNodesIn(previewDoc, [...nodeSel])
    if (!next) return
    commit(next)
    setNodeSel(new Set())
  }, [nodeSel, previewDoc, commit])

  const doSplit = useCallback(() => {
    if (!activePathId) return
    const res = splitPathIn(previewDoc, activePathId)
    if (!res) return
    commit(res.doc)
    setSelection(res.ids)
  }, [activePathId, previewDoc, commit])

  const doCombine = useCallback(() => {
    const res = combineSelected(previewDoc, selection)
    if (!res) return
    commit(res.doc)
    setSelection(new Set([res.id]))
  }, [selection, previewDoc, commit])

  /* ---------------------------------------------------------- keyboard */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) {
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

  return {
    history,
    selection,
    setSelection,
    nodeSel,
    setNodeSel,
    tool,
    setTool,
    snap,
    setSnap,
    showGrid,
    setShowGrid,
    penPathId,
    setPenPathId,
    enteredGroupId,
    setEnteredGroupId,
    pz,
    checkerClass,
    previewDoc,
    railDoc,
    commit,
    preview,
    commitLive,
    pickTool,
    box,
    stats,
    buildSvg,
    activePathId,
    ops: {
      deleteSelection,
      duplicateSelection,
      doGroup,
      doUngroup,
      doMove,
      selectRows,
      rowToggleVisible,
      rowToggleExpanded,
      rowRename,
      rowDelete,
      reorder,
      align,
      distribute,
      flip,
      setGeometry,
      doReverse,
      doBreak,
      doJoin,
      doSplit,
      doCombine,
    },
  }
}
