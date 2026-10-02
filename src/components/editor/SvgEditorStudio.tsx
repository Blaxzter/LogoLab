// The SVG editor: toolbar + canvas + layers rail + properties rail, over one
// undoable EditableDoc.
//
// This component (through `useEditorModel`) owns the document, the selection
// and the keyboard; the stage owns pointer gestures and the panels own their
// controls. The keyboard lives here rather than on the canvas so shortcuts
// (notably Delete) also work while focus is in the layers list.

import { useMemo } from 'react'
import type { EditableDoc } from '../../lib/path/types'
import { ancestorsOf, findItem, isGroup, isText, topLevelSelection, walkItems } from '../../lib/path/docTree'
import { parseNodeKey } from '../../lib/editor/nodeEdit'
import { downloadVector } from '../../lib/export/download'
import { unsupportedItemCount, type VectorFormat } from '../../lib/export/vectorFormats'
import { EditorStage } from './EditorStage'
import { booleanBase } from '../../lib/editor/booleanOrder'
import { layerRows } from '../../lib/editor/layerRows'
import { itemLabel } from './editorDoc'
import { actionReasons } from './studio/actionReasons'
import { EditorStatusBar } from './studio/EditorStatusBar'
import { EditorToolbar } from './studio/EditorToolbar'
import { LayersRail } from './studio/LayersRail'
import { PropertiesRail } from './studio/PropertiesRail'
import { useEditorModel } from './studio/useEditorModel'

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

  const why = actionReasons({
    canUndo: history.canUndo,
    canRedo: history.canRedo,
    selection,
    nodeSel,
    selectedCount,
    sel,
    activePath,
  })

  return (
    <div className="canvas-ui flex h-full min-h-0 w-full shrink-0 flex-col animate-in-fade">
      <EditorToolbar
        tool={tool}
        pickTool={pickTool}
        undo={history.undo}
        redo={history.redo}
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
            undo={history.undo}
            redo={history.redo}
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
          doBoolean={ops.doBoolean}
          panelText={panelText}
          baseLabel={base?.label ?? null}
          text={text}
          convertText={ops.convertText}
          doBreak={ops.doBreak}
          doJoin={ops.doJoin}
        />
      </div>

      {/* Status */}
      <EditorStatusBar stats={stats} viewBox={previewDoc.viewBox} grow={previewDoc.artboard === 'grow'} tool={tool} />
    </div>
  )
}
