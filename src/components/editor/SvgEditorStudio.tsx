// The SVG editor: toolbar + canvas + layers rail + properties rail, over one
// undoable EditableDoc.
//
// This component (through `useEditorModel`) owns the document, the selection
// and the keyboard; the stage owns pointer gestures and the panels own their
// controls. The keyboard lives here rather than on the canvas so shortcuts
// (notably Delete) also work while focus is in the layers list.

import { useMemo } from 'react'
import type { EditableDoc } from '../../lib/path/types'
import { findItem, isGroup, topLevelSelection, walkItems } from '../../lib/path/docTree'
import { downloadText } from '../../lib/export/download'
import { EditorStage } from './EditorStage'
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
    ops,
  } = useEditorModel(initialDoc, onChange)

  /* ------------------------------------------------------------ export */

  const download = () => downloadText(buildSvg(), `${fileName}.svg`, 'image/svg+xml')
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
          doBreak={ops.doBreak}
          doJoin={ops.doJoin}
        />
      </div>

      {/* Status */}
      <EditorStatusBar stats={stats} viewBox={previewDoc.viewBox} tool={tool} />
    </div>
  )
}
