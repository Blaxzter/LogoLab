// The studio's state: undoable document, selection, tool and view, every command, and the keyboard.

import type { BooleanOp } from '../../../lib/editor/boolean'
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import type { EditableDoc, Vec } from '../../../lib/path/types'
import {
  findItem,
  groupItems,
  isInert,
  isText,
  mapItems,
  moveItems,
  removeItems,
  reorderItems,
  topLevelSelection,
} from '../../../lib/path/docTree'
import { layoutGroup, textLabel } from '../../../lib/text/edit'
import { lookupFace } from '../../../lib/text/fonts'
import { caretIndexAt } from '../../../lib/text/layout'
import { textToSvg } from '../../../lib/text/svgText'
import { useTextEditing } from './useTextEditing'
import { docStats, serializeDoc } from '../../../lib/path/model'
import { flipAbout, selectionBox, transformItems, translation } from '../../../lib/editor/transform'
import { alignItems, distributeItems } from '../../../lib/editor/align'
import { fitGrowingArtboard } from '../../../lib/editor/artboard'
import type { AlignEdge, DistributeAxis } from '../../../lib/editor/align'
import { DEFAULT_SNAP, nudgeStep, type SnapConfig } from '../../../lib/editor/snapping'
import type { DropSpot } from '../../../lib/editor/layerRows'
import { applyNodeMove, parseNodeKey } from '../../../lib/editor/nodeEdit'
import { selectSame as matchSame, type SameWhat } from '../../../lib/editor/paintMatch'
import {
  reportedDoc,
  SIMPLIFY_DEFAULT_PERCENT,
  simplifySelected,
  type SimplifySession,
} from '../../../lib/editor/simplify'
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
  releaseClips,
} from '../selectionOps'
import { isTypingTarget } from '../stage/useSpaceHeld'
import {
  copySelection as copyItems,
  insertPasted,
  nextPaste,
  pasteClip,
  pasteEventText,
  placeForeign,
  readForeignSvg,
  type EditorClip,
} from '../clipboard'
import { useBoardCamera } from '../stage/useBoardCamera'

/**
 * The editor's last copy. Module-level, like the system clipboard it mirrors:
 * the editor is a lazy route and unmounts on every tab switch, and a copy has
 * to survive going to Preview and back.
 */
let lastClip: EditorClip | null = null

/** The tolerance Simplify last used; the next Simplify starts there (like the last copy, it outlives the tab). */
let lastSimplifyPercent = SIMPLIFY_DEFAULT_PERCENT

/** What the open Simplify panel shows. */
export interface SimplifyView {
  /** Tolerance, percent of each path's size. */
  percent: number
  /** Nodes in the reached paths before, and in the preview. */
  before: number
  after: number
}

/** Whether a paste has anything to read: our own copy, or the system clipboard. */
export function canPaste(): boolean {
  return lastClip !== null || typeof navigator.clipboard?.readText === 'function'
}

/** The page has a real text selection (a label, a field's value): Ctrl+C belongs to it. */
function hasPageTextSelection(): boolean {
  const s = window.getSelection()
  return !!s && !s.isCollapsed && s.toString().length > 0
}

/**
 * What Select all selects: every top-level layer. Inert markup (defs, an
 * invisible metadata box) is no layer, so Select all + Delete must not take it.
 */
export function selectAllIds(doc: EditableDoc): Set<string> {
  return new Set(doc.items.filter((it) => !isInert(it)).map((it) => it.id))
}

export function useEditorModel(initialDoc: EditableDoc, onChange: ((doc: EditableDoc) => void) | undefined) {
  const history = useHistory<EditableDoc>(120)
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set())
  const [nodeSel, setNodeSel] = useState<ReadonlySet<string>>(new Set())
  const [tool, setTool] = useState<EditorTool>('select')
  const [snap, setSnap] = useState<SnapConfig>(DEFAULT_SNAP)
  const [showGrid, setShowGrid] = useState(false)
  const [penPathId, setPenPathId] = useState<string | null>(null)
  const [enteredGroupId, setEnteredGroupId] = useState<string | null>(null)
  const fixedPz = usePanZoom({ minScale: 1, maxScale: 40, zoomStep: 1.4 })
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

  // The open Simplify session (see "outline + simplify" below), declared here
  // because what the drawing reports outward depends on it.
  const simplifyRef = useRef<SimplifySession | null>(null)

  // A fixed artboard pans and zooms within itself; a growing one is an
  // infinite board with a free camera. Both hooks always run (hook order);
  // only one drives the stage.
  const grow = previewDoc.artboard === 'grow'
  const board = useBoardCamera(previewDoc.viewBox, grow)
  const pz = grow ? board.pz : fixedPz
  const boardView = grow ? board.view : null

  // A Simplify preview is not the drawing yet: the outside world (the editor
  // slot, the working logo) keeps the document the session opened on, or
  // leaving the tab mid-preview would write a simplification nobody applied.
  useEffect(() => {
    if (doc) onChange?.(reportedDoc(doc, simplifyRef.current))
  }, [doc, onChange])

  // Read through a ref so handlers passed to the layers rail can stay
  // identity-stable (`useCallback([])`).
  const docRef = useRef(previewDoc)
  docRef.current = previewDoc

  // The selection, read the same way: async commands (a boolean after its
  // lazy load) must act on the selection as it is when they land.
  const selectionRef = useRef(selection)
  selectionRef.current = selection

  // `history` is a fresh object every render; its methods are not. Depending on
  // the methods keeps every callback built from them stable.
  const { set: historySet, commitMerged: historyMerge } = history

  // A growing artboard refits on COMMIT only: a drag's previews keep the
  // viewBox they started with, so the frame doesn't move under the pointer.
  const commit = useCallback((next: EditableDoc) => historySet(fitGrowingArtboard(next), true), [historySet])
  const preview = useCallback((next: EditableDoc) => historySet(next), [historySet])

  /**
   * Commit a streamed paint edit (a scrubbed colour well, a dragged slider).
   * Every frame is committed, since a colour picker has no "end" event, but the
   * burst merges into one undo entry keyed by control and selection, so
   * switching shapes starts a new entry.
   */
  const selectionKey = useMemo(() => [...selection].sort().join(','), [selection])
  const commitLive = useCallback(
    (next: EditableDoc, control: string) => historyMerge(fitGrowingArtboard(next), `${control}:${selectionKey}`),
    [historyMerge, selectionKey],
  )

  const commitKeyed = useCallback(
    (next: EditableDoc, key: string) => historyMerge(fitGrowingArtboard(next), key),
    [historyMerge],
  )
  const text = useTextEditing({ docRef, selection, commit, commitLive: commitKeyed, setSelection })
  const { end: endText, begin: beginText } = text

  // Selecting something else closes the open text.
  useEffect(() => {
    if (text.edit && !selection.has(text.edit.id)) endText()
  }, [text.edit, selection, endText])

  /** Switch tools. Leaving the pen abandons the path it was drawing. */
  const pickTool = useCallback(
    (next: EditorTool) => {
      setTool(next)
      if (next !== 'pen') setPenPathId(null)
      if (next !== 'text') endText()
    },
    [endText],
  )

  /**
   * Open one path for node editing — the double-click into a shape. A text
   * opens for typing instead, with the caret where it was clicked: its nodes
   * are glyphs, which take Convert to curves first (as in Affinity).
   */
  const editNodes = useCallback(
    (id: string, at?: Vec) => {
      const it = findItem(docRef.current.items, id)
      if (it && isText(it)) {
        const carets = layoutGroup(it, lookupFace).layout.carets
        beginText(id, at ? caretIndexAt(carets, at) : 'end')
        return
      }
      setSelection(new Set([id]))
      setNodeSel(new Set())
      pickTool('node')
    },
    [pickTool, beginText],
  )

  /** Back out of node editing to the Move tool; the shape stays selected. */
  const exitNodes = useCallback(() => {
    setNodeSel(new Set())
    pickTool('select')
  }, [pickTool])

  const box = useMemo(() => selectionBox(previewDoc.items, selection), [previewDoc.items, selection])
  const stats = useMemo(() => docStats(previewDoc), [previewDoc])
  // Built on demand rather than memoized: serializing is expensive and only
  // download/copy need it, so a memo would rerun on every drag frame for nothing.
  // Text as outlines (the default, renders the same everywhere) or as live
  // <text> another editor can retype — chosen at export.
  const [textAs, setTextAs] = useState<'outlines' | 'live'>('outlines')
  const buildSvg = useCallback(
    () => serializeDoc(previewDoc, 2, textAs === 'live' ? { group: textToSvg } : {}),
    [previewDoc, textAs],
  )

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

  /* ---------------------------------------------------------- clipboard */

  /** Remember the selection as the editor's clip; returns the markup for the system clipboard. */
  const copySelection = useCallback((): string | null => {
    const clip = copyItems(previewDoc, selection)
    if (!clip) return null
    lastClip = clip
    return clip.svg
  }, [previewDoc, selection])

  /** Copy, then remove the copied items: one undo step (the copy itself is no edit). */
  const cutSelection = useCallback((): string | null => {
    const svg = copySelection()
    if (!svg) return null
    commit({ ...previewDoc, items: removeItems(previewDoc.items, selection) })
    setSelection(new Set())
    setNodeSel(new Set())
    return svg
  }, [copySelection, previewDoc, selection, commit])

  /**
   * Paste clipboard text. Our own last copy pastes its items (lossless:
   * live text, names, everything); `null` — a clipboard that could not be read,
   * or holds nothing at all — falls back to them too, for a copy whose
   * system-clipboard write was refused. An empty string is NOT that: it is a
   * clipboard holding something else (an image), and pastes nothing. Any other SVG goes in
   * as one item, centred on the view and scaled only if it would not fit or
   * would be a speck. Returns whether anything was pasted.
   */
  const pasteText = useCallback(
    (text: string | null): boolean => {
      const d = docRef.current
      const clip = lastClip
      let res: { doc: EditableDoc; ids: Set<string> } | null = null
      if (clip && (text === null || text === clip.svg)) {
        const next = nextPaste(clip, d)
        lastClip = next.clip
        res = pasteClip(d, clip, next.steps)
      } else if (text !== null) {
        const foreign = readForeignSvg(text)
        if (foreign) {
          const [x, y, w, h] = d.viewBox
          const view = d.artboard === 'grow' && boardView ? boardView : { x, y, w, h }
          res = insertPasted(d, [foreign.item], placeForeign(foreign.frame, view))
        }
      }
      if (!res) return false
      commit(res.doc)
      setSelection(res.ids)
      setNodeSel(new Set())
      setEnteredGroupId(null)
      // What was pasted is a selection of objects; the pen's open path and
      // node editing were about something else.
      if (tool === 'node' || tool === 'pen') pickTool('select')
      return true
    },
    [boardView, commit, tool, pickTool],
  )

  // The menu's versions go through the async clipboard API: a menu click is a
  // user gesture, so writing needs no permission, and reading asks (or, where
  // it is refused, falls back to the editor's own copy).
  const copyToClipboard = useCallback(() => {
    const svg = copySelection()
    if (svg) void navigator.clipboard?.writeText(svg).catch(() => {})
  }, [copySelection])
  const cutToClipboard = useCallback(() => {
    const svg = cutSelection()
    if (svg) void navigator.clipboard?.writeText(svg).catch(() => {})
  }, [cutSelection])
  const pasteFromClipboard = useCallback(() => {
    const read = navigator.clipboard?.readText
    if (typeof read !== 'function') {
      pasteText(null)
      return
    }
    // Resolving to '' means the clipboard holds something that is not text,
    // which is not ours to paste; only a refused read falls back.
    navigator.clipboard.readText().then(
      (t) => pasteText(t),
      () => pasteText(null),
    )
  }, [pasteText])

  /**
   * Select every visible shape painted like the selection's lead (the path the
   * swatches show). A selection change, not an edit: nothing goes on the undo
   * stack. Node editing keeps going, on the new set of paths.
   */
  const selectSame = useCallback(
    (what: SameWhat) => {
      const ids = matchSame(docRef.current, selectionRef.current, what, enteredGroupId)
      if (!ids || ids.size === 0) return
      setNodeSel(new Set())
      setSelection(ids)
    },
    [enteredGroupId],
  )

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

  /** Release the clip of every selected clip group: one step, the selection kept. */
  const doReleaseClip = useCallback(() => {
    const next = releaseClips(previewDoc, selection)
    if (next) commit(next)
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
  const rowToggleVisible = useCallback((id: string) => commit(toggleVisible(docRef.current, id)), [commit])
  const rowToggleExpanded = useCallback((id: string) => preview(toggleExpanded(docRef.current, id)), [preview])
  const rowRename = useCallback((id: string, name: string) => commit(renameItem(docRef.current, id, name)), [commit])
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

  const align = useCallback((edge: AlignEdge) => withDoc((d) => alignItems(d, selection, edge)), [selection, withDoc])
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
    (patch: { x?: number; y?: number; w?: number; h?: number }, live = false) => {
      if (!box) return
      const next = setSelectionGeometry(previewDoc, selection, box, patch)
      if (!next) return
      // A scrubbed field streams values: one merged undo step per drag.
      if (live) commitLive(next, 'geometry')
      else commit(next)
    },
    [box, previewDoc, selection, commit, commitLive],
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

  /**
   * Add / Subtract / Intersect / Xor / Divide. The curve maths (paper.js) is
   * loaded on the first use, so the editor doesn't carry it until then; the
   * selection is read again after the load, in case it moved meanwhile.
   */
  const doBoolean = useCallback(
    async (op: BooleanOp) => {
      const { booleanSelected, mergeSelected } = await import('../../../lib/editor/boolean')
      // Add on a single shape merges that shape's own overlapping contours.
      if (op === 'add' && topLevelSelection(docRef.current.items, selectionRef.current).length === 1) {
        const merged = mergeSelected(docRef.current, selectionRef.current)
        if (merged) commit(merged)
        return
      }
      const res = booleanSelected(docRef.current, selectionRef.current, op, () => newId('p'))
      if (!res) return
      commit(res.doc)
      setNodeSel(new Set())
      setSelection(res.ids)
    },
    [commit],
  )

  /**
   * Convert the selected texts to plain shapes: the outlines stay, the words
   * go. Overlapping glyph contours are merged on the way (a script face's
   * joins, touching letters), so the shapes you then node-edit are the ones
   * that paint rather than a stack of hidden loops.
   */
  const convertText = useCallback(async () => {
    const { mergeOverlaps } = await import('../../../lib/editor/boolean')
    const d = docRef.current
    const items = mapItems(d.items, (it) => {
      if (!isText(it) || !selectionRef.current.has(it.id)) return it
      const { text: data, ...rest } = it
      const children = it.children.map((c) => (c.kind === 'path' ? mergeOverlaps(c) : c))
      return { ...rest, children, name: it.name ?? textLabel(data), expanded: true }
    })
    if (items === d.items) return
    endText()
    commit({ ...d, items })
  }, [commit, endText])

  /* ----------------------------------------------- outline + simplify */

  /**
   * Simplify is a session: the panel's slider previews the result (no undo
   * entry per move), Apply commits it as ONE step, Cancel puts the drawing
   * back. Every preview is computed from the document as it was when the
   * session opened, never from the previous preview.
   */
  const [simplifyView, setSimplifyView] = useState<SimplifyView | null>(null)

  const showSimplify = useCallback(
    (percent: number) => {
      const s = simplifyRef.current
      if (!s) return
      const res = simplifySelected(s.base, s.selection, percent)
      s.shown = res.doc
      preview(res.doc)
      setSimplifyView({ percent, before: res.before, after: res.after })
    },
    [preview],
  )

  const beginSimplify = useCallback(() => {
    if (simplifyRef.current || selectionRef.current.size === 0) return
    simplifyRef.current = { base: docRef.current, selection: selectionRef.current, shown: docRef.current }
    // The nodes of the paths about to change: their indices won't survive it.
    setNodeSel(new Set())
    showSimplify(lastSimplifyPercent)
  }, [showSimplify])

  const setSimplifyPercent = useCallback(
    (percent: number) => {
      lastSimplifyPercent = percent
      showSimplify(percent)
    },
    [showSimplify],
  )

  const applySimplify = useCallback(() => {
    const s = simplifyRef.current
    if (!s) return
    simplifyRef.current = null
    setSimplifyView(null)
    if (s.shown !== s.base) commit(s.shown)
  }, [commit])

  const cancelSimplify = useCallback(() => {
    const s = simplifyRef.current
    if (!s) return
    simplifyRef.current = null
    setSimplifyView(null)
    if (docRef.current === s.shown) preview(s.base)
  }, [preview])

  /**
   * Undo and redo for every surface (toolbar, canvas menu, keys). While a
   * Simplify preview is up, the step to take back is the preview itself:
   * stepping the history instead would discard it AND the edit before it.
   */
  const { undo: historyUndo, redo: historyRedo } = history
  const undo = useCallback(() => {
    if (simplifyRef.current) cancelSimplify()
    else historyUndo()
  }, [cancelSimplify, historyUndo])
  const redo = useCallback(() => {
    if (simplifyRef.current) cancelSimplify()
    else historyRedo()
  }, [cancelSimplify, historyRedo])

  // Selecting something else cancels; any other change to the drawing (an
  // undo, a drag) ends the session where it stands — what it showed is either
  // committed by that edit or gone.
  useEffect(() => {
    const s = simplifyRef.current
    if (s && selection !== s.selection) cancelSimplify()
  }, [selection, cancelSimplify])
  useEffect(() => {
    const s = simplifyRef.current
    if (s && previewDoc !== s.shown && previewDoc !== s.base) {
      simplifyRef.current = null
      setSimplifyView(null)
    }
  }, [previewDoc])

  /**
   * Outline stroke: every stroked path in the selection becomes the filled
   * shape its stroke paints. The geometry runs on paper.js, loaded on first use
   * like the booleans; the ids stay, so the selection stays on the result.
   */
  const doOutlineStroke = useCallback(async () => {
    const pending = simplifyRef.current?.base
    cancelSimplify()
    const { outlineSelected } = await import('../../../lib/editor/outlineStroke')
    const next = outlineSelected(pending ?? docRef.current, selectionRef.current, () => newId('p'))
    if (!next) return
    commit(next)
    setNodeSel(new Set())
  }, [commit, cancelSimplify])

  /* ---------------------------------------------------------- keyboard */

  // Ctrl+C / X / V arrive as the DOM's clipboard events, not as keys: only
  // those carry `clipboardData`, so a paste reads the clipboard without the
  // permission prompt `navigator.clipboard.readText` would raise. Typing,
  // an open text and a real text selection on the page keep the native
  // behaviour. In node editing a copy takes the shapes, never single nodes.
  useEffect(() => {
    const skip = (e: ClipboardEvent) => isTypingTarget(e.target) || text.edit !== null || hasPageTextSelection()
    const onCopy = (e: ClipboardEvent) => {
      if (skip(e)) return
      const svg = e.type === 'cut' ? cutSelection() : copySelection()
      if (!svg) return
      e.clipboardData?.setData('text/plain', svg)
      e.preventDefault()
    }
    const onPaste = (e: ClipboardEvent) => {
      if (skip(e) || !e.clipboardData) return
      const data = e.clipboardData
      // A .svg file copied in the file manager arrives as a file, not text.
      const file = [...data.files].find((f) => f.type === 'image/svg+xml' || /\.svg$/i.test(f.name))
      if (file) {
        e.preventDefault()
        void file.text().then((t) => pasteText(t))
        return
      }
      if (pasteText(pasteEventText([...data.types], () => data.getData('text/plain')))) e.preventDefault()
    }
    document.addEventListener('copy', onCopy)
    document.addEventListener('cut', onCopy)
    document.addEventListener('paste', onPaste)
    return () => {
      document.removeEventListener('copy', onCopy)
      document.removeEventListener('cut', onCopy)
      document.removeEventListener('paste', onPaste)
    }
  }, [text.edit, copySelection, cutSelection, pasteText])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) {
        return
      }
      const mod = e.ctrlKey || e.metaKey
      const k = e.key

      // The Simplify panel holds the drawing in preview: Enter applies, Esc
      // and undo put it back.
      if (simplifyRef.current) {
        if (k === 'Enter' || k === 'Escape' || (mod && k.toLowerCase() === 'z')) {
          e.preventDefault()
          if (k === 'Enter') applySimplify()
          else cancelSimplify()
          return
        }
      }

      // A text is open but its input lost focus (a click in the rail): a
      // letter must not switch tools or delete the selection mid-sentence.
      if (text.edit && !mod) {
        if (k === 'Escape') exitNodes()
        return
      }

      if (mod) {
        const lk = k.toLowerCase()
        if (lk === 'z') {
          e.preventDefault()
          if (e.shiftKey) redo()
          else undo()
        } else if (lk === 'y') {
          e.preventDefault()
          redo()
        } else if (lk === 'a') {
          e.preventDefault()
          setSelection(selectAllIds(previewDoc))
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
        else if (tool === 'node' || tool === 'eyedropper') setTool('select')
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
    undo,
    redo,
    previewDoc,
    selection,
    nodeSel,
    penPathId,
    enteredGroupId,
    tool,
    text.edit,
    exitNodes,
    snap.grid,
    deleteSelection,
    duplicateSelection,
    doGroup,
    doUngroup,
    doJoin,
    reorder,
    nudge,
    pickTool,
    applySimplify,
    cancelSimplify,
  ])

  return {
    history,
    undo,
    redo,
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
    boardView,
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
    text,
    textAs,
    setTextAs,
    simplify: {
      view: simplifyView,
      begin: beginSimplify,
      setPercent: setSimplifyPercent,
      apply: applySimplify,
      cancel: cancelSimplify,
    },
    ops: {
      convertText,
      editNodes,
      exitNodes,
      deleteSelection,
      duplicateSelection,
      copyToClipboard,
      cutToClipboard,
      pasteFromClipboard,
      selectSame,
      doGroup,
      doUngroup,
      doReleaseClip,
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
      doBoolean,
      doOutlineStroke,
    },
  }
}
