// The Cleanup canvas: pixel buffer, tools, history and actions behind
// CleanupStudio/CleanupControls. Everything mutable mid-gesture lives in refs (no
// re-render); the returned state is the reactive slice the UI binds to.
//
// History is its own capped stack of full ImageData snapshots rather than
// useHistory, because each entry is a whole buffer and needs the cap.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useLogo, useStore } from '../state/store'
import { canvasToBlob, getImageData } from '../lib/image'
import {
  alphaBounds,
  autoRemove,
  brushStamp,
  brushStroke,
  cloneImageData,
  closeSeams,
  colorAt,
  despeckle,
  compositeOver,
  cropPad,
  defringe,
  featherAlpha,
  floodRemove,
  floodRestore,
  growMatte,
  recolor,
  removeColor,
  sampleCornerColor,
  shrinkMatte,
  type BrushMode,
  type RemoveOptions,
} from '../lib/cleanup/bgRemove'
import { aiRemoveBackground } from '../lib/cleanup/aiRemove'
import { downloadBlob } from '../lib/export/download'
import type { PanZoom } from './usePanZoom'
import { usePinchZoom } from './usePinchZoom'

// Longest-side cap for the working buffer. AI logo generators commonly emit ~2K,
// so a lower cap would discard source resolution before any edit. The AI alpha
// mask is computed at the model's 1024 and upscaled to fit (see aiRemove.ts).
const MAX_DIM = 2048
const HISTORY_LIMIT = 30

/**
 * The active painting/marker tool.
 * - 'magic'   — contiguous flood-remove from the clicked pixel.
 * - 'color'   — global color-key remove of the clicked color.
 * - 'erase'   — soft brush that rubs out alpha (drag).
 * - 'restore' — soft brush that paints the pristine pixels back (drag).
 * - 'keep'    — guided marker: flood-restore the clicked region (one history step).
 * - 'remove'  — guided marker: flood-remove the clicked region (one history step).
 */
export type CleanupTool = 'magic' | 'color' | 'erase' | 'restore' | 'keep' | 'remove'

/**
 * A guided keep/remove pin, stored normalized (0–1) to the image so it survives
 * a crop. The pin list is studio state (not persisted, not in undo); the type
 * lives here because it is the hook's vocabulary.
 */
export type KeepRemoveMarker = { x: number; y: number; kind: 'keep' | 'remove' }

export interface UseCleanupCanvasParams {
  pz: PanZoom
  /** Active tool (see CleanupTool). */
  tool: CleanupTool
  /** Color distance still counted as background (flood/color/keep/remove tools). */
  tolerance: number
  /** Edge softness 0–1 (feathers the cut/brush edge). */
  softness: number
  /** Brush diameter in image px (erase/restore). */
  brushSize: number
  /** Fringe-cleanup strength (0–1) applied after each flood/color/auto remove; 0 = off. */
  defringeStrength: number
  /** Matte preview is on — bakes a solid background into Apply/Download. */
  matteOn: boolean
  /** Matte color (hex) baked under the cutout when `matteOn`. */
  matteColor: string
  /**
   * Called after a guided keep/remove click actually changed pixels, with the
   * click position normalized (0–1) to the image — the studio adds a pin here.
   */
  onMarkerPlaced?: (nx: number, ny: number, kind: 'keep' | 'remove') => void
  /**
   * Un-applied pixels from a previous session, resolved once after the source
   * decodes. The pristine snapshot still comes from the source — Reset has to
   * mean "back to the upload", not "back to where I was before the reload" — so
   * this replaces only the working buffer, and `modified` is re-derived from it.
   * Returning null (nothing stored, or stored for a different image) is a no-op.
   */
  seedWorking?: (() => Promise<ImageData | null>) | null
}

export function useCleanupCanvas(params: UseCleanupCanvasParams) {
  const { pz, tool, tolerance, softness, brushSize, defringeStrength, matteOn, matteColor, onMarkerPlaced, seedWorking } = params

  const logo = useLogo()
  const setProcessedLogo = useStore((s) => s.setProcessedLogo)
  const restoreOriginal = useStore((s) => s.restoreOriginal)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const workingRef = useRef<ImageData | null>(null)
  const pristineRef = useRef<ImageData | null>(null)
  // View-pan state (Space-held or middle-button drag moves the stage, not pixels).
  const panningViewRef = useRef(false)
  const lastPanRef = useRef({ x: 0, y: 0 })
  const spaceHeldRef = useRef(false)
  // undoRef holds snapshots taken before each change (oldest→newest); redoRef
  // holds states undone past. Any new change clears redo.
  const undoRef = useRef<ImageData[]>([])
  const redoRef = useRef<ImageData[]>([])
  const lastKeyRef = useRef<{ r: number; g: number; b: number } | null>(null)
  // The data URL we last Applied. When logo.src equals it, the reload effect
  // skips the redundant re-decode and preserves the "Applied" state. Matching on
  // the value (not a boolean) is idempotent — a re-upload never collides.
  const appliedSrcRef = useRef<string | null>(null)
  // The restore seed, held in a ref so consuming it can't be undone by a
  // re-render and so the decode effect doesn't re-run when the caller's closure
  // changes identity.
  const seedWorkingRef = useRef(seedWorking ?? null)

  // Brush stroke state (refs: mutated mid-drag without re-rendering).
  const paintingRef = useRef(false)
  const lastPtRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 })
  const scaleRef = useRef(1) // displayed px per image px (for the cursor ring)
  const rafRef = useRef<number | null>(null)
  // A stroke spans pointerdown→up; snapshot the pre-stroke pixels and tally how
  // many the stroke actually changed, so a dead tap/drag commits no history.
  const strokePreRef = useRef<ImageData | null>(null)
  const strokeAffectedRef = useRef(0)

  const [ready, setReady] = useState(false)
  // Bumped by every change to the working pixels. `undoLen` can't stand in for
  // it: past HISTORY_LIMIT the stack length stops moving while the pixels keep
  // changing, so a studio persisting on undoLen would quietly stop saving.
  const [revision, setRevision] = useState(0)
  const [undoLen, setUndoLen] = useState(0)
  const [redoLen, setRedoLen] = useState(0)
  // True when the working pixels differ from the pristine upload. Drives the
  // Apply button — derived from real pixel divergence (not undo depth), so the
  // 30-step cap can never make an edited image read as "unmodified".
  const [modified, setModified] = useState(false)
  const [status, setStatus] = useState<string>('')
  const [applied, setApplied] = useState(false)
  const [aiBusy, setAiBusy] = useState(false)
  const [aiStatus, setAiStatus] = useState('')
  // The backend the last AI run actually used (set once a device produced a
  // result), surfaced as a small "AI ready (wasm)" status line.
  const [aiDevice, setAiDevice] = useState<'webgpu' | 'wasm' | null>(null)
  const [brushCursor, setBrushCursor] = useState<{ x: number; y: number } | null>(null)
  // Mirror of spaceHeldRef for cursor feedback (the ref drives the hot path).
  const [spacePan, setSpacePan] = useState(false)
  // Working-buffer dimensions, kept reactive so the footer/markers can scale.
  // null until the first decode; updated whenever the buffer is resized (crop or
  // a differently-sized undo/redo snapshot).
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null)

  const isBrush = tool === 'erase' || tool === 'restore'
  const opts: RemoveOptions = { tolerance, softness }

  // Two-finger pinch-zoom + pan on touch. One finger always drives the active
  // tool (paint/flood/marker); a second finger turns the gesture into navigation.
  // Zoom is measured around the canvas's own pane box, like the wheel handler.
  const pinch = usePinchZoom(pz, () => {
    const pane = canvasRef.current?.closest('[data-zoom-pane]') as HTMLElement | null
    return (pane ?? stageRef.current)?.getBoundingClientRect() ?? null
  })

  /** Sync reactive `dims` to the current working buffer (call after any resize). */
  const syncDims = useCallback(() => {
    const w = workingRef.current
    setDims(w ? { w: w.width, h: w.height } : null)
  }, [])

  const redraw = useCallback(() => {
    const canvas = canvasRef.current
    const working = workingRef.current
    if (!canvas || !working) return
    canvas.width = working.width
    canvas.height = working.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, working.width, working.height)
    ctx.putImageData(working, 0, 0)
  }, [])

  const scheduleRedraw = useCallback(() => {
    if (rafRef.current != null) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      redraw()
    })
  }, [redraw])

  // (Re)load the working pixels whenever the source image changes.
  useEffect(() => {
    // The src change came from our own Apply — workingRef already holds those
    // pixels. Skip the re-decode and keep the "Applied" UI state intact.
    if (logo.src && logo.src === appliedSrcRef.current) return
    let cancelled = false
    setReady(false)
    setApplied(false)
    setModified(false)
    undoRef.current = []
    redoRef.current = []
    setUndoLen(0)
    setRedoLen(0)
    if (!logo.src) {
      workingRef.current = null
      pristineRef.current = null
      setDims(null)
      return
    }
    // Rasterize an SVG at its intrinsic size (capped to MAX_DIM), never upscaled,
    // the same as raster sources.
    getImageData(logo.src, MAX_DIM, logo.isSvg ? logo.svgText : null, { upscale: false })
      .then(async (data) => {
        if (cancelled) return
        pristineRef.current = cloneImageData(data)
        lastKeyRef.current = sampleCornerColor(data)
        // A restored session's un-applied pixels replace the working buffer (see
        // `seedWorking`). Consumed once — a later source change is a new image
        // and must start from that image's own pixels.
        let working = data
        const seedOnce = seedWorkingRef.current
        seedWorkingRef.current = null
        if (seedOnce) {
          const seeded = await seedOnce().catch(() => null)
          if (cancelled) return
          if (seeded && seeded.width === data.width && seeded.height === data.height) {
            working = seeded
            setModified(true)
          }
        }
        workingRef.current = working
        setDims({ w: working.width, h: working.height })
        setReady(true)
        // Drawing happens in the [ready] effect, after React commits the
        // (re)mounted <canvas>, so it never targets a detached element.
      })
      .catch(() => {
        if (!cancelled) setStatus('Could not load this image for editing.')
      })
    return () => {
      cancelled = true
    }
  }, [logo.src, logo.isSvg, logo.svgText])

  useEffect(() => {
    if (ready) redraw()
  }, [ready, redraw])

  useEffect(() => () => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
  }, [])

  const setStage = useCallback(
    (el: HTMLDivElement | null) => {
      stageRef.current = el
      pz.setViewport(el)
    },
    [pz.setViewport],
  )

  // Wheel over the stage zooms toward the cursor (native listener so we can
  // preventDefault the page scroll — React's onWheel is passive).
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      // Zoom around the pane under the cursor, not the whole stage: usePanZoom
      // needs the box to be the transformed element, and in split view each half
      // is its own [data-zoom-pane]. Passing the stage drifts the right pane.
      const pane = e.target instanceof Element ? e.target.closest('[data-zoom-pane]') : null
      const box = (pane ?? el).getBoundingClientRect()
      pz.zoomAround(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015), box)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [pz.zoomAround, logo.src])

  // Hold Space to pan. Only the flag is armed here; the drag itself runs in the
  // canvas pointer handlers so it composes with painting.
  useEffect(() => {
    const formish = (t: EventTarget | null) =>
      t instanceof HTMLElement &&
      (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || formish(e.target)) return
      spaceHeldRef.current = true
      setSpacePan(true)
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag !== 'BUTTON' && tag !== 'A') e.preventDefault() // stop page scroll
    }
    const up = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return
      spaceHeldRef.current = false
      setSpacePan(false)
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [])

  /** True when the working pixels are byte-identical to the pristine upload. */
  const equalsPristine = useCallback(() => {
    const w = workingRef.current
    const p = pristineRef.current
    if (!w || !p) return true
    if (w.width !== p.width || w.height !== p.height) return false
    const a = w.data
    const b = p.data
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
    return true
  }, [])

  /**
   * Commit a completed change to history. `pre` is the snapshot taken before the
   * mutation. Call only when pixels changed, so dead clicks leave no undo step.
   */
  const commit = useCallback((pre: ImageData) => {
    undoRef.current.push(pre)
    if (undoRef.current.length > HISTORY_LIMIT) undoRef.current.shift()
    redoRef.current = []
    setUndoLen(undoRef.current.length)
    setRedoLen(0)
    setModified(true)
    setApplied(false)
    setRevision((n) => n + 1)
  }, [])

  const handleUndo = useCallback(() => {
    if (!undoRef.current.length) return
    const working = workingRef.current
    if (working) redoRef.current.push(working)
    const next = undoRef.current.pop()!
    // A differently-sized snapshot means a crop is being undone — re-fit the view
    // and refresh `dims` so the stage doesn't clamp against stale dimensions.
    const resized = !working || working.width !== next.width || working.height !== next.height
    workingRef.current = next
    setUndoLen(undoRef.current.length)
    setRedoLen(redoRef.current.length)
    redraw()
    if (resized) {
      pz.reset()
      syncDims()
    }
    setApplied(false)
    setModified(!equalsPristine())
    setRevision((n) => n + 1)
    setStatus('Undid last change')
  }, [redraw, equalsPristine, pz.reset, syncDims])

  const handleRedo = useCallback(() => {
    if (!redoRef.current.length) return
    const working = workingRef.current
    if (working) undoRef.current.push(working)
    const next = redoRef.current.pop()!
    const resized = !working || working.width !== next.width || working.height !== next.height
    workingRef.current = next
    setUndoLen(undoRef.current.length)
    setRedoLen(redoRef.current.length)
    redraw()
    if (resized) {
      pz.reset()
      syncDims()
    }
    setApplied(false)
    setModified(!equalsPristine())
    setRevision((n) => n + 1)
    setStatus('Redid change')
  }, [redraw, equalsPristine, pz.reset, syncDims])

  // Ctrl/Cmd+Z to undo, Ctrl/Cmd+Shift+Z or Ctrl+Y to redo (panel only).
  useEffect(() => {
    if (!ready) return
    const onKey = (e: KeyboardEvent) => {
      if (aiBusy || !(e.ctrlKey || e.metaKey)) return
      // Don't hijack the browser's native undo while the user is typing in a
      // text field (the always-mounted Sidebar has hex / brand-name inputs).
      const t = e.target
      if (
        t instanceof HTMLElement &&
        (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')
      )
        return
      const k = e.key.toLowerCase()
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault()
        handleUndo()
      } else if ((k === 'z' && e.shiftKey) || k === 'y') {
        e.preventDefault()
        handleRedo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ready, aiBusy, handleUndo, handleRedo])

  /** Map a pointer event to floating-point image coordinates (and refresh scale). */
  const imgCoords = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    const working = workingRef.current
    if (!canvas || !working) return null
    const rect = canvas.getBoundingClientRect()
    if (rect.width === 0) return null
    scaleRef.current = rect.width / working.width
    return {
      x: ((e.clientX - rect.left) / rect.width) * working.width,
      y: ((e.clientY - rect.top) / rect.height) * working.height,
    }
  }, [])

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      // A second touch finger turns the gesture into a pinch-zoom/pan. Abandon any
      // in-progress brush stroke, reverting its partial dab so it leaves no pixels.
      if (pinch.down(e)) {
        if (paintingRef.current && strokePreRef.current) {
          workingRef.current = strokePreRef.current
          redraw()
        }
        paintingRef.current = false
        panningViewRef.current = false
        strokePreRef.current = null
        strokeAffectedRef.current = 0
        setBrushCursor(null)
        return
      }
      // View-pan gesture: Space-held or middle-button drag moves the stage
      // instead of editing pixels. Takes precedence over every tool.
      if (spaceHeldRef.current || e.button === 1) {
        panningViewRef.current = true
        lastPanRef.current = { x: e.clientX, y: e.clientY }
        setBrushCursor(null)
        try {
          e.currentTarget.setPointerCapture(e.pointerId)
        } catch {
          /* pointer capture not available */
        }
        return
      }
      if (aiBusy) return
      const working = workingRef.current
      const p = imgCoords(e)
      if (!working || !p) return
      try {
        e.currentTarget.setPointerCapture(e.pointerId)
      } catch {
        /* pointer capture not available (e.g. synthetic event) */
      }

      // Single-click tools: magic/color remove + guided keep/remove markers.
      // Each is exactly one history step — snapshot, mutate, commit iff affected.
      if (tool === 'magic' || tool === 'color' || tool === 'keep' || tool === 'remove') {
        const ix = Math.floor(p.x)
        const iy = Math.floor(p.y)
        if (ix < 0 || iy < 0 || ix >= working.width || iy >= working.height) return
        const pre = cloneImageData(working)

        if (tool === 'keep') {
          const pristine = pristineRef.current
          const affected = pristine ? floodRestore(working, pristine, ix, iy, opts) : 0
          if (affected > 0) {
            commit(pre)
            redraw()
            onMarkerPlaced?.(ix / working.width, iy / working.height, 'keep')
            setStatus(`Kept ${affected.toLocaleString()} px (restored region)`)
          } else {
            setStatus('Nothing to restore there — raise tolerance or pick a clearer spot.')
          }
          return
        }

        // magic / remove: contiguous flood-remove at the pixel; remove == magic
        // but seeded by a marker. color: global color key.
        const key = colorAt(working, ix, iy)
        lastKeyRef.current = key
        const affected =
          tool === 'color' ? removeColor(working, key, opts) : floodRemove(working, ix, iy, opts)
        if (affected > 0) {
          // Close the AA seam where this cut meets an already-removed region and
          // wipe specks the flood stranded. Both run before defringe so they
          // sample the raw background colors.
          closeSeams(working)
          despeckle(working)
          if (defringeStrength > 0) defringe(working, key, defringeStrength)
          commit(pre)
          redraw()
          if (tool === 'remove') {
            onMarkerPlaced?.(ix / working.width, iy / working.height, 'remove')
            setStatus(`Removed ${affected.toLocaleString()} px (marker region)`)
          } else {
            setStatus(
              `Removed ${affected.toLocaleString()} px (${tool === 'magic' ? 'contiguous' : 'by color'})`,
            )
          }
        } else {
          setStatus('Nothing within tolerance there — try raising tolerance.')
        }
        return
      }

      // Brush (erase / restore): snapshot the pre-stroke pixels, then dab once.
      // The stroke is committed on pointerup, only if it changed anything.
      strokePreRef.current = cloneImageData(working)
      strokeAffectedRef.current = 0
      paintingRef.current = true
      lastPtRef.current = p
      const src = tool === 'restore' ? pristineRef.current : undefined
      strokeAffectedRef.current += brushStamp(
        working,
        p.x,
        p.y,
        brushSize / 2,
        1 - softness,
        tool as BrushMode,
        src,
      )
      scheduleRedraw()
    },
    [aiBusy, tool, opts, defringeStrength, brushSize, softness, imgCoords, commit, redraw, scheduleRedraw, onMarkerPlaced, pinch],
  )

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      // Two-finger pinch consumes the move (zoom/pan); never paints.
      if (pinch.move(e)) return
      if (panningViewRef.current) {
        // Pan within the canvas's own pane box (see the wheel handler).
        const pane = canvasRef.current?.closest('[data-zoom-pane]') as HTMLElement | null
        const box = (pane ?? stageRef.current)?.getBoundingClientRect()
        if (box) {
          pz.panBy(e.clientX - lastPanRef.current.x, e.clientY - lastPanRef.current.y, box)
        }
        lastPanRef.current = { x: e.clientX, y: e.clientY }
        return
      }
      const p = imgCoords(e) // also refreshes scaleRef for the cursor ring
      if (isBrush && !aiBusy && !spaceHeldRef.current) setBrushCursor({ x: e.clientX, y: e.clientY })
      if (!paintingRef.current) return
      const working = workingRef.current
      if (!working || !p) return
      const last = lastPtRef.current
      const src = tool === 'restore' ? pristineRef.current : undefined
      strokeAffectedRef.current += brushStroke(
        working,
        last.x,
        last.y,
        p.x,
        p.y,
        brushSize / 2,
        1 - softness,
        tool as BrushMode,
        src,
      )
      lastPtRef.current = p
      scheduleRedraw()
    },
    [isBrush, aiBusy, tool, brushSize, softness, imgCoords, scheduleRedraw, pz.panBy, pinch],
  )

  const endStroke = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      pinch.up(e)
      // Release capture unconditionally: a second finger can turn a stroke into
      // a pinch and clear paintingRef before the first finger lifts.
      try {
        e.currentTarget.releasePointerCapture(e.pointerId)
      } catch {
        /* not captured */
      }
      if (panningViewRef.current) {
        panningViewRef.current = false
        try {
          e.currentTarget.releasePointerCapture(e.pointerId)
        } catch {
          /* already released */
        }
        return
      }
      if (!paintingRef.current) return
      paintingRef.current = false
      try {
        e.currentTarget.releasePointerCapture(e.pointerId)
      } catch {
        /* pointer already released */
      }
      redraw()
      // The whole stroke is one undo step, and only if it changed pixels.
      if (strokeAffectedRef.current > 0 && strokePreRef.current) {
        commit(strokePreRef.current)
        setStatus(tool === 'erase' ? 'Erased with brush' : 'Restored with brush')
      }
      strokePreRef.current = null
      strokeAffectedRef.current = 0
    },
    [tool, redraw, commit, pinch],
  )

  /** Drop the brush cursor ring when the pointer leaves the canvas (not mid-stroke). */
  const onCanvasPointerLeave = useCallback(() => {
    if (!paintingRef.current) setBrushCursor(null)
  }, [])

  const handleAuto = useCallback(() => {
    const working = workingRef.current
    if (!working || aiBusy) return
    const pre = cloneImageData(working)
    const { color, affected } = autoRemove(working, opts)
    lastKeyRef.current = color
    if (affected > 0) {
      closeSeams(working)
      despeckle(working)
      if (defringeStrength > 0) defringe(working, color, defringeStrength)
      commit(pre)
      redraw()
      setStatus(`Auto-removed corner background — ${affected.toLocaleString()} px`)
    } else {
      setStatus('Nothing to auto-remove — the corners are already clear.')
    }
  }, [aiBusy, opts, defringeStrength, commit, redraw])

  const handleAi = useCallback(async () => {
    const pristine = pristineRef.current
    if (!pristine || aiBusy) return
    setAiBusy(true)
    setAiStatus('Loading AI model…')
    setStatus('')
    let device: 'webgpu' | 'wasm' | null = null
    try {
      const result = await aiRemoveBackground(cloneImageData(pristine), (p) => {
        // The device is confirmed only once a backend produced a result; capture
        // it for the status line and the persisted `aiDevice`.
        if (p.device) device = p.device
        setAiStatus(
          p.phase === 'download'
            ? `Downloading model${p.percent != null ? ` — ${p.percent}%` : '…'}`
            : 'Removing background…',
        )
      })
      // The image was swapped or reset mid-run (the reload effect installs a new
      // pristine snapshot): drop the result rather than apply it to another image.
      if (pristineRef.current !== pristine || !workingRef.current) return
      // Commit the pre-AI state only now that we have a result (a failed run
      // leaves history untouched), then swap in the AI output.
      commit(cloneImageData(workingRef.current))
      // RMBG's soft matte keeps a tint of the old background (a coloured halo);
      // defringe it against the original corner color.
      if (defringeStrength > 0) defringe(result, sampleCornerColor(pristine), defringeStrength)
      workingRef.current = result
      redraw()
      setAiDevice(device)
      setStatus(
        `AI removed the background${device ? ` (${device})` : ''} — touch up with the Erase / Restore brushes if needed.`,
      )
    } catch (err) {
      console.error('[cleanup] AI background removal failed', err)
      setStatus(`AI background removal failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setAiBusy(false)
      setAiStatus('')
    }
  }, [aiBusy, defringeStrength, commit, redraw])

  const handleReset = useCallback(() => {
    if (aiBusy) return
    undoRef.current = []
    redoRef.current = []
    setUndoLen(0)
    setRedoLen(0)
    // Restore the working pixels directly from the pristine snapshot — don't
    // rely on logo.src changing identity (it won't if nothing was Applied).
    if (pristineRef.current) {
      workingRef.current = cloneImageData(pristineRef.current)
      redraw()
      // A prior trim may have changed dims; re-fit so the stage doesn't clamp
      // against stale dimensions.
      pz.reset()
      syncDims()
    }
    setApplied(false)
    setModified(false)
    setRevision((n) => n + 1)
    // Pre-arm the reload guard so restoreOriginal's src change skips a redundant
    // re-decode (the in-memory pristine is already correct) and doesn't flicker.
    if (logo.originalSrc) appliedSrcRef.current = logo.originalSrc
    restoreOriginal()
    setStatus('Reset to original')
  }, [aiBusy, restoreOriginal, redraw, pz.reset, syncDims, logo.originalSrc])

  /**
   * Bake the working buffer to a canvas for export. When the matte preview is on
   * the cutout is flattened onto `matteColor` in a copy; workingRef is never
   * mutated, so turning the matte off keeps the transparency.
   */
  const bakeCanvas = useCallback((): HTMLCanvasElement | null => {
    const working = workingRef.current
    if (!working) return null
    const out = matteOn ? compositeOver(working, matteColor) : working
    const canvas = document.createElement('canvas')
    canvas.width = out.width
    canvas.height = out.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.putImageData(out, 0, 0)
    return canvas
  }, [matteOn, matteColor])

  const handleApply = useCallback(() => {
    const working = workingRef.current
    const canvas = bakeCanvas()
    if (!working || !canvas) return
    // Lets the reload effect recognise this src as our own and skip it.
    const dataUrl = canvas.toDataURL('image/png')
    appliedSrcRef.current = dataUrl
    setProcessedLogo(dataUrl, working.width, working.height)
    setApplied(true)
    // Keep the undo/redo history so edits made before Apply remain reversible
    // (an undo afterwards flips `applied` off, signalling the store is stale).
    setStatus('Applied — used everywhere (previews, vectorize, export)')
  }, [bakeCanvas, setProcessedLogo])

  /**
   * The working pixels as PNG bytes — what the studio stores so an un-applied
   * cutout survives a reload. Not `bakeCanvas`: the matte is only a preview, and
   * baking it in would restore a flattened image instead of the cutout.
   */
  const snapshotWorking = useCallback(async (): Promise<Blob | null> => {
    const working = workingRef.current
    if (!working) return null
    const canvas = document.createElement('canvas')
    canvas.width = working.width
    canvas.height = working.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.putImageData(working, 0, 0)
    return canvasToBlob(canvas, 'image/png').catch(() => null)
  }, [])

  const handleDownload = useCallback(async () => {
    const canvas = bakeCanvas()
    if (!canvas) return
    const blob = await canvasToBlob(canvas, 'image/png')
    const base = (logo.fileName ?? 'logo').replace(/\.[^.]+$/, '')
    downloadBlob(blob, `${base}-nobg.png`)
  }, [bakeCanvas, logo.fileName])

  /**
   * Run an in-place pixel op as a single history step (committed only if it
   * changed anything). `run` returns the affected-pixel count.
   */
  const oneShot = useCallback(
    (run: (working: ImageData) => number, label: (affected: number) => string, empty: string) => {
      const working = workingRef.current
      if (!working || aiBusy) return
      const pre = cloneImageData(working)
      const affected = run(working)
      if (affected > 0) {
        commit(pre)
        redraw()
        setStatus(label(affected))
      } else {
        setStatus(empty)
      }
    },
    [aiBusy, commit, redraw],
  )

  const growEdge = useCallback(
    (radius: number) =>
      oneShot(
        (w) => growMatte(w, radius),
        (n) => `Grew the edge by ${radius}px — ${n.toLocaleString()} px`,
        'Edge already filled — nothing to grow.',
      ),
    [oneShot],
  )

  const shrinkEdge = useCallback(
    (radius: number) =>
      oneShot(
        (w) => shrinkMatte(w, radius),
        (n) => `Shrank the edge by ${radius}px — ${n.toLocaleString()} px`,
        'Nothing to shrink — the edge is already tight.',
      ),
    [oneShot],
  )

  const featherEdge = useCallback(
    (radius: number) =>
      oneShot(
        (w) => featherAlpha(w, radius),
        (n) => `Feathered the edge by ${radius}px — ${n.toLocaleString()} px`,
        'Nothing to feather.',
      ),
    [oneShot],
  )

  const defringeMore = useCallback(
    (amount: number) =>
      oneShot(
        (w) => {
          // defringe doesn't report a count; treat any semi-transparent edge as
          // a change so the step commits (the op is a near-no-op otherwise).
          defringe(w, lastKeyRef.current ?? undefined, amount)
          return alphaBounds(w) ? 1 : 0
        },
        () => `Defringed the edges (strength ${amount.toFixed(1)})`,
        'Nothing to defringe — no soft edges.',
      ),
    [oneShot],
  )

  const recolorAll = useCallback(
    (hex: string) =>
      oneShot(
        (w) => recolor(w, hex),
        (n) => `Recolored ${n.toLocaleString()} px to ${hex}`,
        'Nothing to recolor — the cutout is empty.',
      ),
    [oneShot],
  )

  /**
   * Auto-trim transparent margins to the alpha bbox, padded by `pad` px. Crops the
   * working buffer to a new, smaller ImageData, so it re-fits the view (pz.reset)
   * and refreshes `dims`. One history step (undo restores the original size).
   */
  const autoTrim = useCallback(
    (pad: number) => {
      const working = workingRef.current
      if (!working || aiBusy) return
      const bounds = alphaBounds(working)
      if (!bounds) {
        setStatus('Nothing to trim — the image is fully transparent.')
        return
      }
      if (
        pad === 0 &&
        bounds.x === 0 &&
        bounds.y === 0 &&
        bounds.w === working.width &&
        bounds.h === working.height
      ) {
        setStatus('Nothing to trim — already cropped tight.')
        return
      }
      const pre = cloneImageData(working)
      workingRef.current = cropPad(working, bounds, pad)
      commit(pre)
      redraw()
      pz.reset()
      syncDims()
      const next = workingRef.current
      setStatus(`Trimmed to ${next.width}×${next.height}${pad ? ` (+${pad}px pad)` : ''}`)
    },
    [aiBusy, commit, redraw, pz.reset, syncDims],
  )

  return {
    // Refs the studio wires onto the DOM.
    canvasRef,
    setStage,
    // Reactive state.
    ready,
    revision,
    snapshotWorking,
    undoLen,
    redoLen,
    modified,
    applied,
    aiBusy,
    aiStatus,
    aiDevice,
    status,
    brushCursor,
    spacePan,
    dims,
    scaleRef,
    // Pointer + lifecycle handlers for the <canvas>.
    handlePointerDown,
    handlePointerMove,
    endStroke,
    onCanvasPointerLeave,
    // Actions.
    handleUndo,
    handleRedo,
    handleReset,
    handleApply,
    handleDownload,
    handleAuto,
    handleAi,
    growEdge,
    shrinkEdge,
    featherEdge,
    defringeMore,
    recolorAll,
    autoTrim,
  }
}
