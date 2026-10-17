// The SVG editor: toolbar + canvas + layers rail + properties rail, over one
// undoable EditableDoc.
//
// This component (through `useEditorModel`) owns the document, the selection
// and the keyboard; the stage owns pointer gestures and the panels own their
// controls. The keyboard lives here rather than on the canvas so shortcuts
// (notably Delete) also work while focus is in the layers list.

import { useCallback, useMemo, useState } from 'react'
import type { EditableDoc } from '../../lib/path/types'
import { ancestorsOf, findItem, isGroup, isText, topLevelSelection, walkItems } from '../../lib/path/docTree'
import { parseNodeKey, replaceIn } from '../../lib/editor/nodeEdit'
import { insertNode } from '../../lib/path/geometry'
import { downloadVector } from '../../lib/export/download'
import { unsupportedItemCount, type VectorFormat } from '../../lib/export/vectorFormats'
import { EditorStage } from './EditorStage'
import { booleanBase } from '../../lib/editor/booleanOrder'
import type { BooleanOp } from '../../lib/editor/boolean'
import { layerRows } from '../../lib/editor/layerRows'
import { itemLabel, toggleVisible } from './editorDoc'
import { setSelectedNodesKind } from './selectionOps'
import { leadPath, type SameWhat } from '../../lib/editor/paintMatch'
import { pathReach } from '../../lib/editor/simplify'
import { SimplifyPanel } from './studio/SimplifyPanel'
import { ContextMenu } from '../ui/ContextMenu'
import { editorMenu, type EditorAction, type MenuTarget } from './studio/editorMenu'
import type { StageMenuTarget } from './stage/useStageGestures'
import { actionReasons } from './studio/actionReasons'
import { EditorStatusBar } from './studio/EditorStatusBar'
import { EditorToolbar } from './studio/EditorToolbar'
import { LayersRail } from './studio/LayersRail'
import { PropertiesRail } from './studio/PropertiesRail'
import { canPaste, selectAllIds, useEditorModel } from './studio/useEditorModel'

export interface SvgEditorStudioProps {
  /** The document to open. */
  initialDoc: EditableDoc
  /** Suggested download name (without extension). */
  fileName?: string
  /** Leave the editor and go back to the intake screen. */
  onClose: () => void
  /**
   * Fires whenever the document changes, including once with the document it
   * opens with.
   *
   * Don't feed edits back through `initialDoc`: that prop re-seeds the history
   * on identity change, which would wipe undo on every edit.
   */
  onChange?: (doc: EditableDoc) => void
}

export function SvgEditorStudio({ initialDoc, fileName = 'drawing', onClose, onChange }: SvgEditorStudioProps) {
  const {
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
    simplify,
    ops,
  } = useEditorModel(initialDoc, onChange)

  /* ------------------------------------------------------------ export */

  const download = (format: VectorFormat = 'svg') => downloadVector(format, previewDoc, buildSvg(), fileName)
  const copy = () => void navigator.clipboard?.writeText(buildSvg())

  /* ------------------------------------------------------------ render */

  const selectedCount = topLevelSelection(previewDoc.items, selection).length

  // Selection counts in a single tree walk (a lookup per id is quadratic after
  // Ctrl+A on a large traced document).
  const sel = useMemo(() => {
    let paths = 0
    let groups = 0
    let clipGroups = 0
    let other = 0
    walkItems(previewDoc.items, (it) => {
      if (!selection.has(it.id)) return
      if (isGroup(it)) {
        groups++
        if (it.clip) clipGroups++
      } else if (it.kind === 'path') paths++
      else other++
    })
    return { paths, groups, clipGroups, other }
  }, [previewDoc.items, selection])

  /** The one path the single-path operations act on, or null. */
  const activePath = useMemo(() => {
    if (!activePathId) return null
    const it = findItem(previewDoc.items, activePathId)
    return it && it.kind === 'path' ? it : null
  }, [activePathId, previewDoc.items])

  /** The text the Text panel shows: the open one, else the first selected. */
  const panelText = useMemo(() => {
    const id =
      text.edit?.id ??
      [...selection].find((s) => {
        const it = findItem(previewDoc.items, s)
        return it && isText(it)
      })
    const it = id ? findItem(previewDoc.items, id) : null
    return it && isText(it) ? it.text : null
  }, [text.edit, selection, previewDoc.items])
  const hasText = useMemo(() => {
    let found = false
    walkItems(previewDoc.items, (it) => {
      if (isText(it) && it.visible) found = true
    })
    return found
  }, [previewDoc.items])

  // The boolean base: marked on the canvas and named in the Shape section, so
  // it is never a guess what Subtract cuts from.
  const base = useMemo(() => {
    if (tool !== 'select') return null
    const id = booleanBase(previewDoc, selection)
    if (!id) return null
    const row = layerRows(previewDoc.items).find((r) => r.item.id === id)
    return { id, label: row ? itemLabel(row.item, row.number) : 'the first shape' }
  }, [tool, previewDoc, selection])

  /* ------------------------------------------------- hover + context menu */

  // The canvas and the layers list echo each other's hover.
  const [canvasHover, setCanvasHover] = useState<string | null>(null)
  const [railHover, setRailHover] = useState<string | null>(null)

  const [menu, setMenu] = useState<{
    target: MenuTarget
    at: { x: number; y: number }
    segment?: { pathId: string; sub: number; seg: number; t: number }
    rename?: () => void
  } | null>(null)
  const openStageMenu = useCallback((target: StageMenuTarget, at: { x: number; y: number }) => {
    if (target.kind === 'segment') {
      const { kind: _, ...segment } = target
      setMenu({ target: { kind: 'segment' }, at, segment })
    } else setMenu({ target: target.kind === 'items' ? { kind: 'items', from: 'canvas' } : target, at })
  }, [])
  const openRowMenu = useCallback((_id: string, at: { x: number; y: number }, rename: () => void) => {
    setMenu({ target: { kind: 'items', from: 'layers' }, at, rename })
  }, [])

  // What Outline stroke and Simplify would act on, walking into selected groups.
  const reach = useMemo(() => pathReach(previewDoc.items, selection), [previewDoc.items, selection])

  const why = actionReasons({
    // An open Simplify preview is itself a step to take back.
    canUndo: history.canUndo || simplify.view !== null,
    canRedo: history.canRedo || simplify.view !== null,
    selection,
    nodeSel,
    selectedCount,
    sel,
    activePath,
    canPaste: canPaste(),
    hasPaint: leadPath(previewDoc, selection) !== null,
    reach,
  })

  const menuEntries = useMemo(() => {
    if (!menu) return []
    const top = topLevelSelection(previewDoc.items, selection)
    const items = top.map((id) => findItem(previewDoc.items, id))
    const one = items.length === 1 ? items[0] : null
    let hasSelText = false
    for (const it of items) {
      if (!it) continue
      walkItems([it], (c) => {
        if (isText(c)) hasSelText = true
      })
    }
    const nodeKinds = { smooth: 0, corner: 0 }
    for (const k of nodeSel) {
      const ref = parseNodeKey(k)
      const it = findItem(previewDoc.items, ref.itemId)
      const node = it?.kind === 'path' ? it.subPaths[ref.sub]?.nodes[ref.idx] : null
      if (node) nodeKinds[node.kind]++
    }
    return editorMenu(menu.target, {
      why,
      selectedCount: top.length,
      single: !one ? null : isText(one) ? 'text' : isGroup(one) ? 'group' : one.kind === 'path' ? 'path' : 'other',
      hasText: hasSelText,
      allHidden: items.length > 0 && items.every((it) => it && !it.visible),
      enteredGroup: enteredGroupId !== null,
      nodeTool: tool === 'node',
      showGrid,
      snapOn: snap.enabled,
      nodeKinds,
    })
  }, [menu, previewDoc.items, selection, nodeSel, why, enteredGroupId, tool, showGrid, snap.enabled])

  const run = (action: EditorAction) => {
    const top = topLevelSelection(previewDoc.items, selection)
    switch (action) {
      case 'editNodes':
      case 'editText':
        if (top.length === 1) ops.editNodes(top[0])
        break
      case 'enterGroup':
        if (top.length === 1) {
          setEnteredGroupId(top[0])
          setSelection(new Set())
        }
        break
      case 'leaveGroup':
        setEnteredGroupId(null)
        break
      case 'doneNodes':
        ops.exitNodes()
        break
      case 'rename':
        menu?.rename?.()
        break
      case 'toggleHidden': {
        // One undo step for the whole selection, every item to the same state.
        const show = top.every((id) => findItem(previewDoc.items, id)?.visible === false)
        let next = previewDoc
        for (const id of top) {
          if (findItem(next.items, id)?.visible !== show) next = toggleVisible(next, id)
        }
        if (next !== previewDoc) commit(next)
        break
      }
      case 'copy':
        ops.copyToClipboard()
        break
      case 'cut':
        ops.cutToClipboard()
        break
      case 'paste':
        ops.pasteFromClipboard()
        break
      case 'duplicate':
        ops.duplicateSelection()
        break
      case 'delete':
        ops.deleteSelection()
        break
      case 'group':
        ops.doGroup()
        break
      case 'ungroup':
        ops.doUngroup()
        break
      case 'releaseClip':
        ops.doReleaseClip()
        break
      case 'front':
      case 'forward':
      case 'backward':
      case 'back':
        ops.reorder(action)
        break
      case 'flipX':
        ops.flip('x')
        break
      case 'flipY':
        ops.flip('y')
        break
      case 'bool:add':
      case 'bool:subtract':
      case 'bool:intersect':
      case 'bool:xor':
      case 'bool:divide':
        void ops.doBoolean(action.slice(5) as BooleanOp)
        break
      case 'combine':
        ops.doCombine()
        break
      case 'split':
        ops.doSplit()
        break
      case 'reverse':
        ops.doReverse()
        break
      case 'convertText':
        void ops.convertText()
        break
      case 'outlineStroke':
        void ops.doOutlineStroke()
        break
      case 'simplify':
        simplify.begin()
        break
      case 'same:fill':
      case 'same:stroke':
      case 'same:fillStroke':
      case 'same:appearance':
        ops.selectSame(action.slice(5) as SameWhat)
        break
      case 'selectAll':
        setSelection(selectAllIds(previewDoc))
        break
      case 'undo':
        undo()
        break
      case 'redo':
        redo()
        break
      case 'toggleSnap':
        setSnap((v) => ({ ...v, enabled: !v.enabled }))
        break
      case 'toggleGrid':
        setShowGrid((g) => !g)
        break
      case 'smooth':
      case 'corner': {
        const next = setSelectedNodesKind(previewDoc, nodeSel, action)
        if (next) commit(next)
        break
      }
      case 'breakNode':
        ops.doBreak()
        break
      case 'join':
        ops.doJoin()
        break
      case 'addNode': {
        const seg = menu?.segment
        const it = seg ? findItem(previewDoc.items, seg.pathId) : null
        if (seg && it?.kind === 'path') {
          commit({ ...previewDoc, items: replaceIn(previewDoc.items, insertNode(it, seg.sub, seg.seg, seg.t)) })
        }
        break
      }
    }
  }

  return (
    <div className="canvas-ui flex h-full min-h-0 w-full shrink-0 flex-col animate-in-fade">
      <EditorToolbar
        tool={tool}
        pickTool={pickTool}
        undo={undo}
        redo={redo}
        why={why}
        snap={snap}
        setSnap={setSnap}
        showGrid={showGrid}
        setShowGrid={setShowGrid}
        enteredGroupId={enteredGroupId}
        setEnteredGroupId={setEnteredGroupId}
        pz={pz}
        copy={copy}
        download={download}
        svgOnlyItems={unsupportedItemCount(previewDoc)}
        hasText={hasText}
        textAs={textAs}
        setTextAs={setTextAs}
        onClose={onClose}
      />

      {/* Body */}
      <div className="flex min-h-0 flex-1">
        <LayersRail
          railDoc={railDoc}
          pathCount={stats.paths}
          selection={selection}
          why={why}
          selectRows={ops.selectRows}
          rowToggleVisible={ops.rowToggleVisible}
          rowToggleExpanded={ops.rowToggleExpanded}
          rowRename={ops.rowRename}
          doMove={ops.doMove}
          rowDelete={ops.rowDelete}
          doGroup={ops.doGroup}
          doUngroup={ops.doUngroup}
          reorder={ops.reorder}
          duplicateSelection={ops.duplicateSelection}
          deleteSelection={ops.deleteSelection}
          hoverId={canvasHover}
          onHover={setRailHover}
          onRowMenu={openRowMenu}
        />

        <div className="relative min-w-0 flex-1 bg-bg">
          <EditorStage
            doc={previewDoc}
            pz={pz}
            boardView={boardView}
            tool={tool}
            selection={selection}
            nodeSel={nodeSel}
            snap={snap}
            showGrid={showGrid}
            checkerClass={checkerClass}
            penPathId={penPathId}
            enteredGroupId={enteredGroupId}
            onEnterGroup={setEnteredGroupId}
            onEditNodes={ops.editNodes}
            onExitNodes={ops.exitNodes}
            text={text}
            baseId={base?.id ?? null}
            undo={undo}
            redo={redo}
            railHoverId={railHover}
            onHoverChange={setCanvasHover}
            onMenu={openStageMenu}
            onSelectionChange={(ids) => {
              setSelection(ids)
              // Keep the selected nodes of shapes that stay selected: shift-adding
              // a second shape in node editing must not drop the first one's.
              setNodeSel((prev) => {
                const kept = [...prev].filter((k) => {
                  const id = parseNodeKey(k).itemId
                  // A node of a path inside a selected group is still in play.
                  return ids.has(id) || ancestorsOf(previewDoc.items, id).some((g) => ids.has(g.id))
                })
                return kept.length === prev.size ? prev : new Set(kept)
              })
            }}
            onNodeSelChange={setNodeSel}
            onDocChange={preview}
            onDocCommit={commit}
            onPenPathChange={setPenPathId}
            onToolDone={() => setTool('select')}
          />
          {simplify.view && (
            <SimplifyPanel
              view={simplify.view}
              setPercent={simplify.setPercent}
              apply={simplify.apply}
              cancel={simplify.cancel}
            />
          )}
        </div>

        <PropertiesRail
          previewDoc={previewDoc}
          selection={selection}
          selectedCount={selectedCount}
          box={box}
          why={why}
          commit={commit}
          commitLive={commitLive}
          setGeometry={ops.setGeometry}
          align={ops.align}
          distribute={ops.distribute}
          flip={ops.flip}
          doReverse={ops.doReverse}
          doSplit={ops.doSplit}
          doCombine={ops.doCombine}
          doOutlineStroke={ops.doOutlineStroke}
          beginSimplify={simplify.begin}
          simplifying={simplify.view !== null}
          doBoolean={ops.doBoolean}
          selectSame={ops.selectSame}
          panelText={panelText}
          baseLabel={base?.label ?? null}
          text={text}
          convertText={ops.convertText}
          doBreak={ops.doBreak}
          doJoin={ops.doJoin}
        />
      </div>

      {/* Status */}
      <EditorStatusBar
        stats={stats}
        viewBox={previewDoc.viewBox}
        grow={previewDoc.artboard === 'grow'}
        tool={tool}
        hasSelection={selection.size > 0}
      />

      {menu && menuEntries.length > 0 && (
        <ContextMenu
          at={menu.at}
          label={menu.target.kind === 'canvas' ? 'Canvas' : menu.target.kind === 'items' ? 'Selection' : 'Nodes'}
          onClose={() => setMenu(null)}
          entries={menuEntries.map((e, i) =>
            e.kind === 'sep'
              ? e
              : {
                  kind: 'item',
                  id: `${e.action}-${i}`,
                  label: e.label,
                  shortcut: e.shortcut,
                  reason: e.reason,
                  danger: e.danger,
                  checked: e.checked,
                  onSelect: () => run(e.action),
                },
          )}
        />
      )}
    </div>
  )
}
