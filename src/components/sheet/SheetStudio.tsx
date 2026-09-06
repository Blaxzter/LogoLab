// The icon-sheet workspace: rail on the left, and a centre that is either the
// sheet with its crop boxes, the contact sheet of detected icons, or — when one
// is opened — the full vectorizer on that single icon.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Grid2x2, Layers, Loader2, MousePointer2, Play, Scissors, SlidersHorizontal, Square } from 'lucide-react'
import { useCheckerClass } from '../../store'
import { usePanZoom } from '../../hooks/usePanZoom'
import { useSheetStore } from '../../sheetStore'
import { Button } from '../ui/Button'
import { Segmented } from '../ui/controls'
import { CheckerToggle } from '../ui/CheckerToggle'
import { ZoomControls } from '../ui/ZoomControls'
import { Sheet } from '../ui/Sheet'
import { StudioActionBar, StudioTopBar } from '../studio/StudioBar'
import { LegalLinksInline } from '../legal/LegalFooter'
import { downloadBlob } from '../../lib/download'
import { exportName } from '../../lib/sheet'
import { SheetControls, SheetControlsBody } from './SheetControls'
import { SheetStage } from './SheetStage'
import { IconGrid } from './IconGrid'
import { IconStudio } from './IconStudio'
import { buildSheetZip, isImageFile, readSheetFile } from './sheetIo'

type View = 'sheet' | 'icons'

export function SheetStudio() {
  const checkerClass = useCheckerClass()
  const pz = usePanZoom({ maxScale: 24 })

  const source = useSheetStore((s) => s.source)
  const image = useSheetStore((s) => s.image)
  const background = useSheetStore((s) => s.background)
  const tiles = useSheetStore((s) => s.tiles)
  const grid = useSheetStore((s) => s.grid)
  const warnings = useSheetStore((s) => s.warnings)
  const detect = useSheetStore((s) => s.detect)
  const traceOptions = useSheetStore((s) => s.traceOptions)
  const colorMode = useSheetStore((s) => s.colorMode)
  const hiRes = useSheetStore((s) => s.hiRes)
  const gradientMode = useSheetStore((s) => s.gradientMode)
  const naming = useSheetStore((s) => s.naming)
  const ocr = useSheetStore((s) => s.ocr)
  const running = useSheetStore((s) => s.running)
  const selectedId = useSheetStore((s) => s.selectedId)
  // Actions are created once with the store, so these references are stable and
  // safe to use as effect/memo dependencies.
  const patchDetect = useSheetStore((s) => s.patchDetect)
  const setTraceOptions = useSheetStore((s) => s.setTraceOptions)
  const setColorMode = useSheetStore((s) => s.setColorMode)
  const setHiRes = useSheetStore((s) => s.setHiRes)
  const setGradientMode = useSheetStore((s) => s.setGradientMode)
  const setNaming = useSheetStore((s) => s.setNaming)
  const readCaptions = useSheetStore((s) => s.readCaptions)
  const setAllIncluded = useSheetStore((s) => s.setAllIncluded)
  const setSource = useSheetStore((s) => s.setSource)
  const updateTile = useSheetStore((s) => s.updateTile)
  const setTileRect = useSheetStore((s) => s.setTileRect)
  const addTile = useSheetStore((s) => s.addTile)
  const removeTile = useSheetStore((s) => s.removeTile)
  const select = useSheetStore((s) => s.select)
  const traceAll = useSheetStore((s) => s.traceAll)
  const stopAll = useSheetStore((s) => s.stopAll)
  const clear = useSheetStore((s) => s.clear)

  const [view, setView] = useState<View>('icons')
  const [draw, setDraw] = useState(false)
  const [showTraced, setShowTraced] = useState(true)
  const [openId, setOpenId] = useState<string | null>(null)
  const [controlsOpen, setControlsOpen] = useState(false)
  const [exportSvg, setExportSvg] = useState(true)
  const [exportPng, setExportPng] = useState(false)
  const [transparentPng, setTransparentPng] = useState(true)
  const [exporting, setExporting] = useState(false)
  const replaceInput = useRef<HTMLInputElement | null>(null)

  const openIndex = tiles.findIndex((t) => t.id === openId)
  const openTile = openIndex >= 0 ? tiles[openIndex] : null
  // An icon that disappears under an open editor (re-detect, delete) closes it.
  useEffect(() => {
    if (openId && openIndex < 0) setOpenId(null)
  }, [openId, openIndex])

  const traced = tiles.filter((t) => t.svg).length
  const failed = tiles.filter((t) => t.status === 'error').length
  const included = tiles.filter((t) => t.included).length

  const open = useCallback(
    (id: string) => {
      setOpenId(id)
      select(id)
    },
    [select],
  )

  const step = useCallback(
    (delta: number) => {
      if (openIndex < 0 || tiles.length === 0) return
      const next = tiles[(openIndex + delta + tiles.length) % tiles.length]
      setOpenId(next.id)
      select(next.id)
    },
    [openIndex, tiles, select],
  )

  // Delete removes the selected box while the sheet is on screen. (The icon
  // editor owns Delete for node editing, so it only applies out here.)
  useEffect(() => {
    if (openTile || view !== 'sheet') return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target
      if (t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
        e.preventDefault()
        removeTile(selectedId)
      }
      if (e.key === 'Escape') select(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openTile, view, selectedId, removeTile, select])

  const onReplaceFile = async (file: File | undefined) => {
    if (!file || !isImageFile(file)) return
    const intake = await readSheetFile(file)
    setSource(intake.source, intake.image)
    setOpenId(null)
  }

  const onExport = async () => {
    if (!image) return
    setExporting(true)
    try {
      const state = useSheetStore.getState()
      const items = state.tiles
        .filter((t) => t.included)
        .map((t) => ({
          tile: t,
          pixels: exportPng ? state.crop(t.id) : null,
          name: exportName(t.name, state.naming.prefix, state.naming.suffix),
        }))
      const blob = await buildSheetZip(items, { svg: exportSvg, png: exportPng, transparent: transparentPng })
      const base = (source?.fileName ?? 'sheet').replace(/\.[^.]+$/, '') || 'sheet'
      downloadBlob(blob, `${base}-icons.zip`)
    } finally {
      setExporting(false)
    }
  }

  const controlProps = useMemo(
    () => ({
      detect,
      onDetect: patchDetect,
      grid,
      warnings,
      tiles,
      traceOptions,
      onTraceOptions: setTraceOptions,
      colorMode,
      onColorMode: setColorMode,
      hiRes,
      onHiRes: setHiRes,
      gradientMode,
      onGradientMode: setGradientMode,
      naming,
      onNaming: setNaming,
      ocr,
      onRetryCaptions: () => void readCaptions(),
      running,
      onTraceAll: () => void traceAll(),
      onTraceStale: () =>
        void traceAll(
          useSheetStore
            .getState()
            .tiles.filter((t) => t.included && (t.stale || !t.doc))
            .map((t) => t.id),
        ),
      onStop: stopAll,
      onSetAllIncluded: setAllIncluded,
      exportSvg,
      onExportSvg: setExportSvg,
      exportPng,
      onExportPng: setExportPng,
      transparentPng,
      onTransparentPng: setTransparentPng,
      exporting,
      onExport: () => void onExport(),
      onReplace: () => replaceInput.current?.click(),
      onClear: clear,
    }),
    // onExport closes over the export toggles, which are all in the dep list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [detect, grid, warnings, tiles, traceOptions, colorMode, hiRes, gradientMode, naming, ocr, running, exportSvg, exportPng, transparentPng, exporting, source],
  )

  if (!source || !image) return null

  if (openTile) {
    return (
      <div className="flex h-full min-h-0 shrink-0 animate-in-fade">
        <IconStudio
          tile={openTile}
          image={image}
          background={background}
          index={openIndex}
          total={tiles.length}
          onBack={() => setOpenId(null)}
          onStep={step}
        />
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 shrink-0 animate-in-fade">
      <SheetControls source={source} {...controlProps} />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* ---------------------------------------------- toolbar (desktop) */}
        <div className="hidden h-12 shrink-0 items-center gap-2 border-b border-line bg-surface px-3 md:flex">
          <Segmented<View>
            value={view}
            onChange={setView}
            options={[
              { value: 'icons', label: <><Grid2x2 size={13} /> Icons ({tiles.length})</> },
              { value: 'sheet', label: <><Layers size={13} /> Sheet</> },
            ]}
          />
          {view === 'sheet' ? (
            <Segmented<'select' | 'draw'>
              value={draw ? 'draw' : 'select'}
              onChange={(v) => setDraw(v === 'draw')}
              options={[
                { value: 'select', title: 'Select & adjust boxes', label: <><MousePointer2 size={13} /> Select</> },
                { value: 'draw', title: 'Drag on the sheet to add a box', label: <><Scissors size={13} /> Draw</> },
              ]}
            />
          ) : (
            <Segmented<'traced' | 'source'>
              value={showTraced ? 'traced' : 'source'}
              onChange={(v) => setShowTraced(v === 'traced')}
              options={[
                { value: 'traced', label: 'Traced' },
                { value: 'source', label: 'Source' },
              ]}
            />
          )}

          <div className="ml-auto flex items-center gap-2">
            {view === 'sheet' && <ZoomControls pz={pz} />}
            <CheckerToggle />
            <span className="h-5 w-px bg-line" aria-hidden />
            {running ? (
              <Button variant="secondary" className="h-8 px-3 text-xs" icon={<Square size={13} />} onClick={() => stopAll()}>
                Stop
              </Button>
            ) : (
              <Button
                variant="primary"
                className="h-8 px-3 text-xs"
                icon={<Play size={13} />}
                disabled={included === 0}
                onClick={() => void traceAll()}
              >
                {traced > 0 ? 'Re-trace all' : `Trace ${included} icons`}
              </Button>
            )}
          </div>
        </div>

        {/* ------------------------------------------------ top strip (mobile) */}
        <StudioTopBar>
          <Segmented<View>
            value={view}
            onChange={setView}
            options={[
              { value: 'icons', label: `Icons (${tiles.length})` },
              { value: 'sheet', label: 'Sheet' },
            ]}
          />
          {view === 'sheet' && (
            <Segmented<'select' | 'draw'>
              value={draw ? 'draw' : 'select'}
              onChange={(v) => setDraw(v === 'draw')}
              options={[
                { value: 'select', label: 'Select' },
                { value: 'draw', label: 'Draw' },
              ]}
            />
          )}
          <CheckerToggle />
        </StudioTopBar>

        {/* -------------------------------------------------------- workspace */}
        <div className={`min-h-0 flex-1 ${view === 'icons' ? 'overflow-y-auto bg-bg' : 'overflow-hidden bg-bg-2'}`}>
          {tiles.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
              <p className="text-sm font-medium text-ink">No icons found on this sheet</p>
              <p className="max-w-sm text-xs leading-relaxed text-muted">
                Lower the ink threshold if the art is faint, or switch the split to <strong>Grid</strong> and say how
                many rows and columns the sheet has.
              </p>
            </div>
          ) : view === 'sheet' ? (
            <SheetStage
              source={source}
              tiles={tiles}
              selectedId={selectedId}
              pz={pz}
              draw={draw}
              checkerClass={checkerClass}
              onSelect={select}
              onRectChange={setTileRect}
              onCreate={(rect) => addTile(rect)}
              onDelete={removeTile}
              onOpen={open}
            />
          ) : (
            <IconGrid
              image={image}
              background={background}
              tiles={tiles}
              naming={naming}
              checkerClass={checkerClass}
              showTraced={showTraced}
              onOpen={open}
              onToggleInclude={(id, included) => updateTile(id, { included })}
              onRename={(id, name) => updateTile(id, { name, renamed: true })}
            />
          )}
        </div>

        {/* ------------------------------------------------ status (desktop) */}
        <footer className="hidden h-9 shrink-0 items-center gap-4 border-t border-line bg-surface px-3 font-mono text-xs tabular-nums text-muted md:flex">
          <span className="shrink-0">
            {tiles.length} boxes · {included} included · {traced} traced
            {failed > 0 ? ` · ${failed} failed` : ''}
          </span>
          {running && (
            <span className="flex shrink-0 items-center gap-1.5 text-accent">
              <Loader2 size={12} className="animate-spin" />
              Tracing…
            </span>
          )}
          <LegalLinksInline className="mx-auto shrink-0" />
          <span className="hidden truncate sm:block">
            {view === 'sheet'
              ? draw
                ? 'Drag on the sheet to add a box'
                : 'Click a box to select · drag to move · corners resize · double-click opens'
              : 'Click an icon to open it in the vectorizer'}
          </span>
        </footer>

        {/* ----------------------------------------------- action bar (mobile) */}
        <StudioActionBar>
          <Button
            variant="secondary"
            className="h-10"
            icon={<SlidersHorizontal size={16} />}
            onClick={() => setControlsOpen(true)}
          >
            Sheet
          </Button>
          <div className="flex-1" />
          {running ? (
            <Button variant="secondary" className="h-10" icon={<Square size={15} />} onClick={() => stopAll()}>
              Stop
            </Button>
          ) : (
            <Button
              variant="primary"
              className="h-10"
              icon={<Play size={15} />}
              disabled={included === 0}
              onClick={() => void traceAll()}
            >
              Trace {included}
            </Button>
          )}
        </StudioActionBar>
      </div>

      <Sheet open={controlsOpen} onClose={() => setControlsOpen(false)} title="Icon sheet" side="bottom">
        <SheetControlsBody source={source} {...controlProps} />
      </Sheet>

      <input
        ref={replaceInput}
        type="file"
        accept="image/*,.svg"
        className="hidden"
        onChange={(e) => {
          void onReplaceFile(e.target.files?.[0])
          e.target.value = ''
        }}
      />
    </div>
  )
}
