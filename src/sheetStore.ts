// State for the icon-sheet splitter.
//
// Deliberately separate from `useStore` (which holds exactly ONE working logo and
// is what Preview/Cleanup/Vectorize/Export share): a sheet is N icons, each with
// its own trace, and pushing them through the single-logo slot one at a time is
// what this view exists to avoid. Like `useStore` it is session-only — nothing is
// persisted, and the pixels never leave the tab.

import { create } from 'zustand'
import { DEFAULT_VECTORIZE_OPTIONS } from './lib/trace'
import { cropTile, defaultTileName, detectSheetIcons, gridTiles, nameStem } from './lib/sheet'
import type { ImageDataLike, Rect, SheetBackground, SheetGrid, TileKind } from './lib/sheet'
import { traceTile, planTileTrace, tileTraceInput, type SheetColorMode } from './lib/sheet/traceTile'
import type { EditableDoc } from './lib/path/types'
import type { VectorizeOptions } from './types'

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
   * What the last run actually traced with, after the per-tile colour/mono and
   * gradient decisions. Opening the icon in the studio has to start from THIS,
   * not from the sheet defaults — otherwise the editor shows one set of controls
   * over a document traced with another, and the first tweak silently re-traces
   * the icon a different way.
   */
  resolved: VectorizeOptions | null
  /** The user renamed it — a re-detect must not overwrite that. */
  renamed: boolean
  /** The user drew or edited this box by hand. */
  manual: boolean
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

/**
 * Sheet tiles carry the paper colour around their icon, so the tracer's own
 * background drop is on by default — it removes the background LABEL during the
 * trace, which is cleaner than knocking pixels out first (no fringe to defringe).
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
   * Colour vs mono, decided per tile by default. Sheet icons are usually ONE ink
   * on paper, and the colour path splits that ink's shading into separate palette
   * entries — which carves the shapes. See planTileTrace.
   */
  colorMode: SheetColorMode
  /**
   * Trace small crops enlarged (~512px long side). Anti-aliasing carries
   * sub-pixel edge information a 170px lattice cannot use — measured over 54
   * tiles: ink-area drift 0.75pp → 0.13pp, SSIM 0.864 → 0.946, at ~2.5× the
   * trace time and +57% nodes. See `traceScale`.
   */
  hiRes: boolean
  /**
   * Gradient fitting is a per-IMAGE decision and a sheet's tiles differ, so the
   * default probes each crop. Forcing it is still worth offering: an icon set is
   * usually flat on purpose, and "flat" also picks the palette-first segmenter.
   */
  gradientMode: GradientMode
  tiles: SheetIcon[]
  selectedId: string | null
  /** A batch run is in flight. */
  running: boolean

  setSource: (source: SheetSource, image: ImageDataLike) => void
  clear: () => void
  setColorMode: (mode: SheetColorMode) => void
  setHiRes: (on: boolean) => void
  setGradientMode: (mode: GradientMode) => void
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
  }
}

/** How many tiles trace at once. Each one is a dedicated Worker holding a full
 *  copy of its pixels, so this is a real resource decision, not a formality. */
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

  setSource: (source, image) => {
    get().stopAll()
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
      // A fresh sheet gets fresh detection defaults; the previous sheet's tuned
      // threshold rarely transfers, and a stale one looks like a broken detector.
      detect: { ...DEFAULT_DETECT, mode: get().detect.mode },
    })
    get().redetect()
  },

  clear: () => {
    get().stopAll()
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
    })
  },

  setColorMode: (mode) =>
    set((s) => ({
      colorMode: mode,
      tiles: s.tiles.map((t) => (t.doc && !t.opts ? { ...t, stale: true } : t)),
    })),

  // Resolution changes every tile's trace, hand-tuned ones included.
  setHiRes: (on) =>
    set((s) => ({ hiRes: on, tiles: s.tiles.map((t) => (t.doc ? { ...t, stale: true } : t)) })),

  setGradientMode: (mode) =>
    set((s) => ({
      gradientMode: mode,
      traceOptions:
        mode === 'auto' ? s.traceOptions : { ...s.traceOptions, gradients: mode === 'rich' },
      tiles: s.tiles.map((t) => (t.doc && !t.opts ? { ...t, stale: true } : t)),
    })),

  // The control moves NOW and the sheet re-splits a beat later: detection is
  // ~70ms on a 4MP sheet, which is fine once and awful once per slider tick.
  patchDetect: (patch) => {
    set((s) => ({ detect: { ...s.detect, ...patch } }))
    if (redetectTimer !== null) clearTimeout(redetectTimer)
    redetectTimer = setTimeout(() => {
      redetectTimer = null
      get().redetect()
    }, REDETECT_DEBOUNCE_MS) as unknown as number
  },

  redetect: () => {
    const { image, detect, tiles: previous } = get()
    if (!image) return
    get().stopAll()

    // Renamed tiles keep their name by POSITION — the boxes themselves are
    // recomputed from scratch, so identity by id is meaningless across a re-run.
    const keptNames = new Map<number, string>()
    previous.forEach((t, i) => {
      if (t.renamed) keptNames.set(i, t.name)
    })
    const stem = nameStem(get().source?.fileName)

    if (detect.mode === 'grid') {
      const raw = gridTiles(image.width, image.height, detect)
      set({
        tiles: raw.map((t, i) => blankTile(t.id, keptNames.get(i) ?? defaultTileName(i, stem), t.box, 'icon')),
        grid: { rows: detect.rows, cols: detect.cols, pitchX: 0, pitchY: 0 },
        warnings: [],
        background: null,
        selectedId: null,
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
    set({
      tiles: visible.map((t, i) =>
        blankTile(t.id, keptNames.get(i) ?? defaultTileName(i, stem), t.box, t.kind),
      ),
      grid: result.grid,
      background: result.background,
      warnings: result.warnings,
      selectedId: null,
    })
  },

  setTraceOptions: (patch) =>
    set((s) => ({
      traceOptions: { ...s.traceOptions, ...patch },
      // Say the shown traces are out of date rather than silently re-tracing N
      // icons — a batch re-trace is seconds of work and the user's call.
      tiles: s.tiles.map((t) => (t.doc && !t.opts ? { ...t, stale: true } : t)),
    })),

  updateTile: (id, patch) =>
    set((s) => ({ tiles: s.tiles.map((t) => (t.id === id ? { ...t, ...patch } : t)) })),

  setTileRect: (id, rect) =>
    set((s) => ({
      tiles: s.tiles.map((t) =>
        t.id === id
          ? // A moved box invalidates its trace — keep the doc on screen but mark
            // it as no longer matching the crop.
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
    const fill = background && !background.transparent
      ? { r: background.r, g: background.g, b: background.b, a: 255 }
      : null
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
      tiles: s.tiles.map((t) =>
        queue.includes(t.id) ? { ...t, status: 'queued', progress: 0, error: null } : t,
      ),
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
                    // `opts` stays null for a tile that follows the sheet defaults
                    // (that is what makes a defaults change mark it stale);
                    // `resolved` records what this run actually used, which is what
                    // the single-icon editor has to open with.
                    opts: t.opts,
                    resolved: opts,
                  }
                : t,
            ),
          }))
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') return
          if (token === runToken) {
            get().updateTile(id, {
              status: 'error',
              error: err instanceof Error ? err.message : 'Trace failed',
            })
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
