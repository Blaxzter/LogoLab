// State for the icon-sheet splitter.
//
// Separate from `useStore`, which holds the single working logo: a sheet is N
// icons, each with its own trace. The sheet (source bytes and every trace) is
// persisted to its own IndexedDB slot, because a batch trace is expensive to
// redo after a reload.

import { create } from 'zustand'
import { DEFAULT_VECTORIZE_OPTIONS } from '../lib/trace'
import { cropTile, defaultTileName, detectSheetIcons, gridTiles, nameStem } from '../lib/sheet'
import { captionToName, matchCaptions, prepareCaption } from '../lib/sheet/captions.ts'
import { captionOcrSupported, loadCaptionReader, type CaptionRead } from '../lib/sheet/ocr.ts'
import type { ImageDataLike, Rect, SheetBackground, SheetGrid, TileKind } from '../lib/sheet'
import { traceTile, planTileTrace, tileTraceInput, type SheetColorMode } from '../lib/sheet/traceTile'
import type { EditableDoc } from '../lib/path/types'
import type { VectorizeOptions } from '../types'
import { getImageData } from '../lib/image'
import { logError } from '../lib/report/errorLog'
import { raiseFailure } from '../lib/report/failureNotice'
import { saveSlot, SLOTS, srcToBlob, type StoredSheet } from '../lib/persist/session'

export type TileStatus = 'idle' | 'queued' | 'tracing' | 'done' | 'error'

export interface SheetIcon {
  id: string
  name: string
  /** Crop box in SHEET pixels. May hang off the edge (uniform boxes do). */
  rect: Rect
  /** What the detector thought this was; the user can overrule it. */
  kind: TileKind
  /** In the batch: traced, exported, counted. */
  included: boolean
  status: TileStatus
  progress: number
  error: string | null
  doc: EditableDoc | null
  svg: string | null
  stats: { paths: number; nodes: number; colors: number } | null
  /** The trace on screen no longer matches the current box/settings. */
  stale: boolean
  /** Per-icon trace overrides; null ⇒ follow the sheet's defaults. */
  opts: VectorizeOptions | null
  /**
   * The options the last run actually used, after the per-tile colour/mono and
   * gradient decisions. The studio must open with these, not the sheet
   * defaults, or its controls won't match the document and the first tweak
   * re-traces the icon differently.
   */
  resolved: VectorizeOptions | null
  /** The user renamed it — a re-detect must not overwrite that. */
  renamed: boolean
  /** The user drew or edited this box by hand. */
  manual: boolean
  /**
   * The caption under this icon, when the detector found one: its ink on the
   * sheet, and what the OCR read off it once it has run.
   */
  caption: TileCaption | null
}

export interface TileCaption {
  /** The caption's ink, in sheet px — what the OCR is shown. */
  ink: Rect
  /** What the OCR read; null until it has run on this caption. */
  text: string | null
  /** Tesseract's 0–100 confidence in `text`. */
  confidence: number | null
}

export interface SheetSource {
  src: string
  fileName: string | null
  width: number
  height: number
  svgText: string | null
  /**
   * We created this object URL and must revoke it. False when the sheet borrows
   * the app's working logo — revoking that one would blank the other tabs.
   */
  owned: boolean
}

export type DetectMode = 'auto' | 'grid'
export type GradientMode = 'auto' | 'flat' | 'rich'

export interface SheetDetectSettings {
  mode: DetectMode
  /** Colour distance from the paper that counts as ink. */
  threshold: number
  /** Merge gap in sheet px; null ⇒ let the detector pick it. */
  gap: number | null
  padding: number
  square: boolean
  uniform: boolean
  /** Keep the caption text the detector filtered out. */
  keepLabels: boolean
  /** Manual grid. */
  rows: number
  cols: number
  margin: number
  gutter: number
}

export const DEFAULT_DETECT: SheetDetectSettings = {
  mode: 'auto',
  threshold: 24,
  gap: null,
  padding: 0.08,
  square: true,
  uniform: true,
  keepLabels: false,
  rows: 3,
  cols: 3,
  margin: 0,
  gutter: 0,
}

export interface SheetNaming {
  /** Put in front of every exported name (`ic-` → `ic-sun.svg`). */
  prefix: string
  /** Put after every exported name (`-24` → `sun-24.svg`). */
  suffix: string
  /** Name each icon after the caption under it, read by OCR. */
  fromCaptions: boolean
}

/**
 * Captions are read by default, since the caption is usually the name the user
 * wants. The OCR engine is only fetched when a sheet actually has captions.
 */
export const DEFAULT_NAMING: SheetNaming = { prefix: '', suffix: '', fromCaptions: true }

/** Below this OCR confidence a caption name is flagged for a second look. */
export const CAPTION_UNSURE_BELOW = 80

export type OcrStatus = 'idle' | 'loading' | 'reading' | 'done' | 'error'

export interface OcrState {
  status: OcrStatus
  /** Engine download/initialisation, 0–1 (`loading` only). */
  progress: number
  /** Captions read so far in this run, and how many it set out to read. */
  done: number
  total: number
  error: string | null
}

const IDLE_OCR: OcrState = { status: 'idle', progress: 0, done: 0, total: 0, error: null }

/**
 * Sheet tiles carry the paper colour around their icon, so the tracer's
 * background removal is on by default. Dropping the background region during
 * the trace leaves no fringe, unlike knocking pixels out beforehand.
 */
export const DEFAULT_SHEET_TRACE: VectorizeOptions = {
  ...DEFAULT_VECTORIZE_OPTIONS,
  removeBackground: true,
}

interface SheetState {
  source: SheetSource | null
  /** Full-resolution sheet pixels — the source every crop is cut from. */
  image: ImageDataLike | null
  background: SheetBackground | null
  grid: SheetGrid | null
  warnings: string[]
  detect: SheetDetectSettings
  traceOptions: VectorizeOptions
  /**
   * Colour vs mono, decided per tile by default. Sheet icons are usually one ink
   * on paper, and the colour path would split that ink's shading into separate
   * regions. See planTileTrace.
   */
  colorMode: SheetColorMode
  /**
   * Trace small crops enlarged (toward ~512px long side) so the tracer can use
   * the sub-pixel edge information in the anti-aliasing. See `traceScale`.
   */
  hiRes: boolean
  /**
   * Gradient fitting is decided per crop by default. Forcing "flat" is useful
   * because icon sets are usually flat on purpose, and it also selects the
   * palette-first segmenter.
   */
  gradientMode: GradientMode
  tiles: SheetIcon[]
  selectedId: string | null
  /** A batch run is in flight. */
  running: boolean
  naming: SheetNaming
  /** Where the caption OCR is: not asked for, loading the engine, reading, done, failed. */
  ocr: OcrState

  setSource: (source: SheetSource, image: ImageDataLike) => void
  /**
   * Adopt a stored sheet with its boxes and traces. Not `setSource`: that
   * re-splits from scratch and would discard the restored tiles. Async because
   * the stored source bytes are decoded back to pixels rather than storing the
   * raster too.
   */
  hydrate: (stored: StoredSheet) => Promise<boolean>
  clear: () => void
  setColorMode: (mode: SheetColorMode) => void
  setHiRes: (on: boolean) => void
  setGradientMode: (mode: GradientMode) => void
  setNaming: (patch: Partial<SheetNaming>) => void
  /** Read every caption that has not been read yet and name its icon after it. */
  readCaptions: () => Promise<void>
  patchDetect: (patch: Partial<SheetDetectSettings>) => void
  redetect: () => void
  setTraceOptions: (patch: Partial<VectorizeOptions>) => void
  updateTile: (id: string, patch: Partial<SheetIcon>) => void
  setTileRect: (id: string, rect: Rect) => void
  addTile: (rect: Rect) => string
  removeTile: (id: string) => void
  select: (id: string | null) => void
  setAllIncluded: (included: boolean) => void
  /** Crop one tile's pixels out of the sheet (paper colour fills any overhang). */
  crop: (id: string) => ImageDataLike | null
  traceAll: (ids?: string[]) => Promise<void>
  stopAll: () => void
  /** Adopt a document the per-icon studio produced. */
  setTileDoc: (id: string, doc: EditableDoc, svg: string, stats: SheetIcon['stats']) => void
}

/** Bumped by every stopAll/new run so late results from a dead run are dropped. */
let runToken = 0
const controllers = new Map<string, AbortController>()

const REDETECT_DEBOUNCE_MS = 160
let redetectTimer: number | null = null

function blankTile(id: string, name: string, rect: Rect, kind: TileKind): SheetIcon {
  return {
    id,
    name,
    rect,
    kind,
    included: kind === 'icon',
    status: 'idle',
    progress: 0,
    error: null,
    doc: null,
    svg: null,
    stats: null,
    stale: false,
    opts: null,
    resolved: null,
    renamed: false,
    manual: false,
    caption: null,
  }
}

/**
 * OCR results by caption ink box, so a re-detect (which rebuilds every tile)
 * does not re-read unchanged captions. Cleared with the sheet.
 */
const captionCache = new Map<string, CaptionRead>()
const captionKey = (r: Rect) => `${r.x}:${r.y}:${r.w}:${r.h}`
/** Bumped by anything that makes an in-flight caption run obsolete. */
let ocrToken = 0

/** The name a tile gets by itself: its caption when that is wanted and known, else its number. */
function autoName(tile: Pick<SheetIcon, 'caption'>, index: number, stem: string, fromCaptions: boolean): string {
  if (fromCaptions && tile.caption?.text) {
    const name = captionToName(tile.caption.text)
    if (name) return name
  }
  return defaultTileName(index, stem)
}

/** How many tiles trace at once. Each one is a dedicated Worker holding its own copy of the pixels. */
function concurrency(): number {
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4
  return Math.max(1, Math.min(4, cores - 1))
}

export const useSheetStore = create<SheetState>((set, get) => ({
  source: null,
  image: null,
  background: null,
  grid: null,
  warnings: [],
  detect: DEFAULT_DETECT,
  traceOptions: DEFAULT_SHEET_TRACE,
  colorMode: 'auto',
  hiRes: true,
  gradientMode: 'auto',
  tiles: [],
  selectedId: null,
  running: false,
  naming: DEFAULT_NAMING,
  ocr: IDLE_OCR,

  setSource: (source, image) => {
    get().stopAll()
    ocrToken++
    captionCache.clear()
    const previous = get().source
    if (previous?.owned && previous.src !== source.src) URL.revokeObjectURL(previous.src)
    set({
      source,
      image,
      tiles: [],
      selectedId: null,
      grid: null,
      background: null,
      warnings: [],
      ocr: IDLE_OCR,
      // A new sheet starts from default detection settings; a previous sheet's
      // tuned threshold rarely transfers.
      detect: { ...DEFAULT_DETECT, mode: get().detect.mode },
    })
    get().redetect()
  },

  hydrate: async (stored) => {
    const src = URL.createObjectURL(stored.source)
    let image: ImageDataLike
    try {
      // Decode at exactly the stored size: every tile rect is in those pixels,
      // and re-deriving the cap could slide every box off its icon.
      image = await getImageData(src, Math.max(stored.width, stored.height), stored.svgText)
    } catch {
      URL.revokeObjectURL(src)
      return false
    }
    // A tile caught mid-batch comes back settled, not "tracing": its worker
    // died with the old page.
    const tiles = (stored.tiles as SheetIcon[]).map((t) => ({
      ...t,
      status: (t.doc ? 'done' : 'idle') as TileStatus,
      progress: 0,
      error: null,
    }))
    set({
      source: {
        src,
        fileName: stored.fileName,
        width: stored.width,
        height: stored.height,
        svgText: stored.svgText,
        owned: true,
      },
      image,
      tiles,
      selectedId: stored.selectedId,
      background: stored.background as SheetBackground | null,
      grid: stored.grid as SheetGrid | null,
      warnings: stored.warnings,
      detect: stored.detect as SheetDetectSettings,
      traceOptions: stored.traceOptions,
      colorMode: stored.colorMode as SheetColorMode,
      gradientMode: stored.gradientMode as GradientMode,
      hiRes: stored.hiRes,
      naming: stored.naming as SheetNaming,
      running: false,
      ocr: IDLE_OCR,
    })
    return true
  },

  clear: () => {
    get().stopAll()
    ocrToken++
    captionCache.clear()
    const previous = get().source
    if (previous?.owned) URL.revokeObjectURL(previous.src)
    set({
      source: null,
      image: null,
      background: null,
      grid: null,
      warnings: [],
      tiles: [],
      selectedId: null,
      detect: DEFAULT_DETECT,
      ocr: IDLE_OCR,
    })
  },

  setColorMode: (mode) =>
    set((s) => ({
      colorMode: mode,
      tiles: s.tiles.map((t) => (t.doc && !t.opts ? { ...t, stale: true } : t)),
    })),

  // Resolution changes every tile's trace, hand-tuned ones included.
  setHiRes: (on) => set((s) => ({ hiRes: on, tiles: s.tiles.map((t) => (t.doc ? { ...t, stale: true } : t)) })),

  setGradientMode: (mode) =>
    set((s) => ({
      gradientMode: mode,
      traceOptions: mode === 'auto' ? s.traceOptions : { ...s.traceOptions, gradients: mode === 'rich' },
      tiles: s.tiles.map((t) => (t.doc && !t.opts ? { ...t, stale: true } : t)),
    })),

  // Update the control immediately and debounce the re-split, which is too
  // slow to run on every slider tick.
  patchDetect: (patch) => {
    set((s) => ({ detect: { ...s.detect, ...patch } }))
    if (redetectTimer !== null) clearTimeout(redetectTimer)
    redetectTimer = setTimeout(() => {
      redetectTimer = null
      get().redetect()
    }, REDETECT_DEBOUNCE_MS) as unknown as number
  },

  redetect: () => {
    const { image, detect, naming, tiles: previous } = get()
    if (!image) return
    get().stopAll()
    // The tiles a caption run is naming are about to be replaced.
    ocrToken++

    // Renamed tiles keep their name by position: boxes are recomputed from
    // scratch, so ids do not survive a re-run.
    const keptNames = new Map<number, string>()
    previous.forEach((t, i) => {
      if (t.renamed) keptNames.set(i, t.name)
    })
    const stem = nameStem(get().source?.fileName)
    const named = (tile: SheetIcon, i: number): SheetIcon => {
      const kept = keptNames.get(i)
      return kept !== undefined
        ? { ...tile, name: kept, renamed: true }
        : { ...tile, name: autoName(tile, i, stem, naming.fromCaptions) }
    }

    if (detect.mode === 'grid') {
      const raw = gridTiles(image.width, image.height, detect)
      set({
        tiles: raw.map((t, i) => named(blankTile(t.id, '', t.box, 'icon'), i)),
        grid: { rows: detect.rows, cols: detect.cols, pitchX: 0, pitchY: 0 },
        warnings: [],
        background: null,
        selectedId: null,
        ocr: IDLE_OCR,
      })
      return
    }

    const result = detectSheetIcons(image, {
      threshold: detect.threshold,
      gap: detect.gap ?? undefined,
      padding: detect.padding,
      square: detect.square,
      uniform: detect.uniform,
    })
    const visible = result.tiles.filter((t) => (detect.keepLabels ? t.kind !== 'noise' : t.kind === 'icon'))
    // Pair every icon with its caption even if captions are not read now; the
    // naming toggle uses the pairing later.
    const captions = matchCaptions(result.tiles, result.grid)
    const tiles = visible.map((t, i) => {
      const match = captions.get(t.id)
      const cached = match ? captionCache.get(captionKey(match.ink)) : undefined
      const tile = blankTile(t.id, '', t.box, t.kind)
      tile.caption = match
        ? { ink: match.ink, text: cached?.text ?? null, confidence: cached?.confidence ?? null }
        : null
      return named(tile, i)
    })
    set({
      tiles,
      grid: result.grid,
      background: result.background,
      warnings: result.warnings,
      selectedId: null,
      ocr: IDLE_OCR,
    })
    if (naming.fromCaptions) void get().readCaptions()
  },

  setNaming: (patch) => {
    const before = get().naming
    set({ naming: { ...before, ...patch } })
    if (patch.fromCaptions === undefined || patch.fromCaptions === before.fromCaptions) return
    if (patch.fromCaptions) {
      void get().readCaptions()
      return
    }
    // Back to numbers. Names the user typed stay; a run in flight is dropped.
    ocrToken++
    const stem = nameStem(get().source?.fileName)
    set((s) => ({
      ocr: IDLE_OCR,
      tiles: s.tiles.map((t, i) => (t.renamed ? t : { ...t, name: defaultTileName(i, stem) })),
    }))
  },

  readCaptions: async () => {
    const token = ++ocrToken
    const stem = nameStem(get().source?.fileName)
    // What is already known applies at once; only the rest needs the engine.
    set((s) => ({
      tiles: s.tiles.map((t, i) => (t.renamed ? t : { ...t, name: autoName(t, i, stem, true) })),
    }))
    const pending = get().tiles.filter((t) => t.caption && t.caption.text === null)
    if (pending.length === 0) {
      set((s) => ({ ocr: { ...IDLE_OCR, status: s.tiles.some((t) => t.caption) ? 'done' : 'idle' } }))
      return
    }
    if (!captionOcrSupported()) {
      set({
        ocr: {
          ...IDLE_OCR,
          status: 'error',
          error: 'Reading captions needs Web Workers and WebAssembly, which this browser does not offer.',
        },
      })
      return
    }

    set({ ocr: { status: 'loading', progress: 0, done: 0, total: pending.length, error: null } })
    let reader: Awaited<ReturnType<typeof loadCaptionReader>>
    try {
      reader = await loadCaptionReader((progress) => {
        if (token === ocrToken) set((s) => ({ ocr: { ...s.ocr, progress } }))
      })
    } catch (err) {
      if (token === ocrToken) {
        set((s) => ({
          ocr: {
            ...s.ocr,
            status: 'error',
            error: err instanceof Error ? err.message : 'Could not load the OCR engine',
          },
        }))
      }
      return
    }
    if (token !== ocrToken) return
    set((s) => ({ ocr: { ...s.ocr, status: 'reading', progress: 1 } }))

    let done = 0
    for (const tile of pending) {
      const { image, background } = get()
      if (token !== ocrToken || !image || !background || !tile.caption) return
      const ink = tile.caption.ink
      let read: CaptionRead
      try {
        read = await reader.read(prepareCaption(image, ink, background))
      } catch (err) {
        if (token === ocrToken) {
          set((s) => ({
            ocr: { ...s.ocr, status: 'error', error: err instanceof Error ? err.message : 'Reading a caption failed' },
          }))
        }
        return
      }
      if (token !== ocrToken) return
      captionCache.set(captionKey(ink), read)
      done++
      set((s) => ({
        ocr: { ...s.ocr, done },
        tiles: s.tiles.map((t, i) => {
          if (t.id !== tile.id || !t.caption) return t
          const next = { ...t, caption: { ...t.caption, text: read.text, confidence: read.confidence } }
          return t.renamed ? next : { ...next, name: autoName(next, i, stem, true) }
        }),
      }))
    }
    if (token === ocrToken) set((s) => ({ ocr: { ...s.ocr, status: 'done' } }))
  },

  setTraceOptions: (patch) =>
    set((s) => ({
      traceOptions: { ...s.traceOptions, ...patch },
      // Mark shown traces stale instead of re-tracing N icons automatically;
      // a batch re-trace is the user's call.
      tiles: s.tiles.map((t) => (t.doc && !t.opts ? { ...t, stale: true } : t)),
    })),

  updateTile: (id, patch) => set((s) => ({ tiles: s.tiles.map((t) => (t.id === id ? { ...t, ...patch } : t)) })),

  setTileRect: (id, rect) =>
    set((s) => ({
      tiles: s.tiles.map((t) =>
        t.id === id
          ? // A moved box invalidates its trace: keep the doc but mark it stale.
            { ...t, rect, manual: true, stale: Boolean(t.doc) }
          : t,
      ),
    })),

  addTile: (rect) => {
    const id = `manual-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const stem = nameStem(get().source?.fileName)
    set((s) => ({
      tiles: [...s.tiles, { ...blankTile(id, defaultTileName(s.tiles.length, stem), rect, 'icon'), manual: true }],
      selectedId: id,
    }))
    return id
  },

  removeTile: (id) => {
    controllers.get(id)?.abort()
    controllers.delete(id)
    set((s) => ({
      tiles: s.tiles.filter((t) => t.id !== id),
      selectedId: s.selectedId === id ? null : s.selectedId,
    }))
  },

  select: (id) => set({ selectedId: id }),

  setAllIncluded: (included) => set((s) => ({ tiles: s.tiles.map((t) => ({ ...t, included })) })),

  crop: (id) => {
    const { image, tiles, background } = get()
    const tile = tiles.find((t) => t.id === id)
    if (!image || !tile) return null
    const fill =
      background && !background.transparent ? { r: background.r, g: background.g, b: background.b, a: 255 } : null
    return cropTile(image, tile.rect, fill)
  },

  traceAll: async (ids) => {
    const token = ++runToken
    const state = get()
    if (!state.image) return
    const queue = (ids ?? state.tiles.filter((t) => t.included).map((t) => t.id)).filter((id) =>
      state.tiles.some((t) => t.id === id),
    )
    if (queue.length === 0) return

    set((s) => ({
      running: true,
      tiles: s.tiles.map((t) => (queue.includes(t.id) ? { ...t, status: 'queued', progress: 0, error: null } : t)),
    }))

    let cursor = 0
    const next = async (): Promise<void> => {
      while (cursor < queue.length) {
        if (token !== runToken) return
        const id = queue[cursor++]
        const tile = get().tiles.find((t) => t.id === id)
        const pixels = get().crop(id)
        if (!tile || !pixels) continue
        const controller = new AbortController()
        controllers.set(id, controller)
        get().updateTile(id, { status: 'tracing', progress: 0 })
        try {
          const state = get()
          const plan = planTileTrace(pixels, tile.opts ?? state.traceOptions, {
            colorMode: tile.opts ? tile.opts.mode : state.colorMode,
            gradientMode: tile.opts ? 'flat' : state.gradientMode,
            background: state.background,
            hiRes: state.hiRes,
          })
          const opts = tile.opts
            ? // A hand-tuned tile keeps its own options; only the resolution and
              // the size-scaled smoothing still come from the planner.
              { ...tile.opts, smoothing: plan.opts.smoothing }
            : plan.opts
          const result = await traceTile(
            tileTraceInput(pixels, plan.scale),
            opts,
            controller.signal,
            (p) => {
              if (token === runToken) get().updateTile(id, { progress: p.fraction })
            },
            tile.opts ? null : plan.recolor,
          )
          if (token !== runToken) return
          set((s) => ({
            tiles: s.tiles.map((t) =>
              t.id === id
                ? {
                    ...t,
                    status: 'done',
                    progress: 1,
                    doc: result.doc,
                    svg: result.svg,
                    stats: result.stats,
                    error: null,
                    stale: false,
                    // `opts` stays null for a tile following the sheet defaults
                    // (so a defaults change marks it stale); `resolved` is what
                    // this run used and what the studio opens with.
                    opts: t.opts,
                    resolved: opts,
                  }
                : t,
            ),
          }))
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') return
          // Logged even if this run was superseded, so a later issue report
          // still sees the failure.
          logError('sheet-tile', err)
          if (token === runToken) {
            get().updateTile(id, {
              status: 'error',
              error: err instanceof Error ? err.message : 'Trace failed',
            })
            // raiseFailure keys on what+message, so many tiles failing the
            // same way ask only once.
            raiseFailure('the icon sheet', 'An icon in the sheet could not be traced.', err)
          }
        } finally {
          controllers.delete(id)
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency(), queue.length) }, next))
    if (token === runToken) set({ running: false })
  },

  stopAll: () => {
    runToken++
    for (const c of controllers.values()) c.abort()
    controllers.clear()
    set((s) => ({
      running: false,
      tiles: s.tiles.map((t) =>
        t.status === 'queued' || t.status === 'tracing' ? { ...t, status: t.doc ? 'done' : 'idle', progress: 0 } : t,
      ),
    }))
  },

  setTileDoc: (id, doc, svg, stats) =>
    set((s) => ({
      tiles: s.tiles.map((t) =>
        t.id === id ? { ...t, doc, svg, stats, status: 'done', error: null, stale: false } : t,
      ),
    })),
}))

export const useSheetTiles = () => useSheetStore((s) => s.tiles)
export const useSheetSource = () => useSheetStore((s) => s.source)

/* ------------------------------------------------------------- persistence */

/**
 * The source bytes, cached by object URL: reading a blob URL back is a full
 * copy, and the rest of the sheet state changes far more often than the source.
 */
let sourceBytes: { src: string; blob: Blob } | null = null

async function persistSheet(): Promise<void> {
  const s = useSheetStore.getState()
  const src = s.source?.src
  if (!src || !s.image) {
    sourceBytes = null
    saveSlot(SLOTS.sheet, null)
    return
  }
  if (sourceBytes?.src !== src) {
    const blob = await srcToBlob(src)
    if (!blob) return
    sourceBytes = { src, blob }
  }
  // Re-read: the sheet may have been replaced while those bytes were copied.
  const now = useSheetStore.getState()
  if (now.source?.src !== src) return
  saveSlot(
    SLOTS.sheet,
    {
      source: sourceBytes.blob,
      fileName: now.source.fileName,
      width: now.source.width,
      height: now.source.height,
      svgText: now.source.svgText,
      tiles: now.tiles,
      selectedId: now.selectedId,
      background: now.background,
      grid: now.grid,
      warnings: now.warnings,
      detect: now.detect,
      traceOptions: now.traceOptions,
      colorMode: now.colorMode,
      gradientMode: now.gradientMode,
      hiRes: now.hiRes,
      naming: now.naming,
    } satisfies Omit<StoredSheet, 'v'>,
    1200,
  )
}

useSheetStore.subscribe((s, prev) => {
  const changed =
    s.source !== prev.source ||
    s.image !== prev.image ||
    s.tiles !== prev.tiles ||
    s.selectedId !== prev.selectedId ||
    s.background !== prev.background ||
    s.grid !== prev.grid ||
    s.warnings !== prev.warnings ||
    s.detect !== prev.detect ||
    s.traceOptions !== prev.traceOptions ||
    s.colorMode !== prev.colorMode ||
    s.gradientMode !== prev.gradientMode ||
    s.hiRes !== prev.hiRes ||
    s.naming !== prev.naming ||
    s.running !== prev.running
  if (!changed) return
  // Skip saves during a batch: every progress tick rewrites `tiles`, and each
  // save structured-clones every traced document. The run's end flips
  // `running` off, which saves the whole result once.
  if (s.running) return
  void persistSheet()
})
