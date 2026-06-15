// The Cleanup canvas hot path, extracted from CleanupPanel verbatim and given a
// crisp, typed surface for the workspace shell (CleanupStudio/CleanupControls)
// to build against. Everything mutable mid-gesture lives in refs (no re-render);
// the returned state is the reactive slice the UI binds to.
//
// Keeps the bespoke 30-snapshot history (full-ImageData snapshots need the cap —
// we deliberately do NOT migrate to useHistory) and `equalsPristine` divergence
// check. New vs. the old panel: a wider tool union (guided keep/remove markers),
// one-shot edge-refine / trim actions, a baked matte for Apply/Download, and a
// real-device AI status with a real error message on failure.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useLogo, useStore } from '../store'
import { canvasToBlob, getImageData } from '../lib/image'
import {
  alphaBounds,
  autoRemove,
  brushStamp,
  brushStroke,
  cloneImageData,
  colorAt,
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
} from '../lib/bgRemove'
import { aiRemoveBackground } from '../lib/aiRemove'
import { downloadBlob } from '../lib/download'
import type { PanZoom } from './usePanZoom'

// Longest-side cap for the editable working buffer. 2048 because AI logo tools
// (e.g. Gemini Pro) emit ~2K by default — clamping lower would throw away half
// the source resolution before any edit. Manual tools (flood/brush/color/defringe)
// and the RGB pixels run at full buffer res; the AI alpha mask is still computed
// at the model's 1024 and upscaled to fit (see aiRemove.ts).
const MAX_DIM = 2048
const HISTORY_LIMIT = 30

/**
 * The active painting/marker tool.
 * - 'magic'   — contiguous flood-remove from the clicked pixel.
 * - 'color'   — global color-key remove of the clicked color.
 * - 'erase'   — soft brush that rubs out alpha (drag).
 * - 'restore' — soft brush that paints the pristine pixels back (drag).
 * - 'keep'    — guided marker: flood-RESTORE the clicked region (one history step).
 * - 'remove'  — guided marker: flood-REMOVE the clicked region (one history step).
 */
export type CleanupTool = 'magic' | 'color' | 'erase' | 'restore' | 'keep' | 'remove'

/**
 * A guided keep/remove pin, stored normalized (0–1) to the image so it survives
 * a crop. Lives in the STUDIO (not persisted, not in undo) — the union is exported
 * here because it is the hook's vocabulary; the pin list is the studio's state.
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
}

export function useCleanupCanvas(params: UseCleanupCanvasParams) {
  const { pz, tool, tolerance, softness, brushSize, defringeStrength, matteOn, matteColor, onMarkerPlaced } = params

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
  // Bidirectional history: undoRef holds snapshots taken *before* each change
  // (oldest→newest); redoRef holds states we undid past. Any new change clears
  // redo. Works uniformly for flood, color-key, brush strokes and AI.
  const undoRef = useRef<ImageData[]>([])
  const redoRef = useRef<ImageData[]>([])
  const lastKeyRef = useRef<{ r: number; g: number; b: number } | null>(null)
  // The data URL we last Applied. When logo.src equals it, the reload effect
  // skips the redundant re-decode and preserves the "Applied" state. Matching on
  // the value (not a boolean) is idempotent — a re-upload never collides.
  const appliedSrcRef = useRef<string | null>(null)

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
    // Rasterize an SVG at its own intrinsic size (capped to MAX_DIM), never
    // upscaled — so a 512px SVG cleans up at 512px instead of being blown up to
    // MAX_DIM. Matches how raster sources are handled; export/vectorize still upscale.
    getImageData(logo.src, MAX_DIM, logo.isSvg ? logo.svgText : null, { upscale: false })
      .then((data) => {
        if (cancelled) return
        workingRef.current = data
        pristineRef.current = cloneImageData(data)
        lastKeyRef.current = sampleCornerColor(data)
        setDims({ w: data.width, h: data.height })
        setReady(true)
        // Actual draw happens in the [ready] effect below, after React commits
        // the (re)mounted <canvas> — avoids drawing to a detached canvas.
      })
      .catch(() => {
        if (!cancelled) setStatus('Could not load this image for editing.')
      })
    return () => {
      cancelled = true
    }
  }, [logo.src, logo.isSvg, logo.svgText])

  // Draw once the canvas is mounted/ready (runs after commit, so canvasRef
  // points at the live element — robust across unmount/remount on reload).
  useEffect(() => {
    if (ready) redraw()
  }, [ready, redraw])

  // Cancel any pending animation frame on unmount.
  useEffect(() => () => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
  }, [])

  // Register the stage as the pan/zoom viewport and keep our own ref to it.
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
      // Zoom around the box of the pane the cursor is in. In split view each half
      // is its own [data-zoom-pane] whose rect matches its transformed content;
      // usePanZoom requires box == transformed element, so passing the full stage
      // here would drift the right pane and over-permit the pan clamp. Single-pane
      // modes use a full-width pane, so closest() still resolves correctly.
      const pane = e.target instanceof Element ? e.target.closest('[data-zoom-pane]') : null
      const box = (pane ?? el).getBoundingClientRect()
      pz.zoomAround(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015), box)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [pz.zoomAround, logo.src])

  // Hold Space to pan (Photoshop-style). We only arm the flag here; the actual
  // drag is handled in the canvas pointer handlers so it composes with painting.
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
   * Commit a completed change to history. `pre` is the working snapshot taken
   * *before* the mutation. Only call this when pixels actually changed — dead
   * clicks must not push phantom undo steps or flip the modified state.
   */
  const commit = useCallback((pre: ImageData) => {
    undoRef.current.push(pre)
    if (undoRef.current.length > HISTORY_LIMIT) undoRef.current.shift()
    redoRef.current = []
    setUndoLen(undoRef.current.length)
    setRedoLen(0)
    setModified(true)
    setApplied(false)
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
        // Snapshot first, mutate, then commit only if it actually changed pixels.
        const pre = cloneImageData(working)

        if (tool === 'keep') {
          // Guided keep: flood-restore the clicked region from the pristine source.
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
    [aiBusy, tool, opts, defringeStrength, brushSize, softness, imgCoords, commit, redraw, scheduleRedraw, onMarkerPlaced],
  )

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      // Drag-to-pan the view (Space/middle-button) — runs before any brush logic.
      if (panningViewRef.current) {
        // Pan within the canvas's own pane box (the right half in split), not the
        // whole stage, so the shared transform stays geometrically correct per pane.
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
    [isBrush, aiBusy, tool, brushSize, softness, imgCoords, scheduleRedraw, pz.panBy],
  )

  const endStroke = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      // End a view-pan drag without committing any brush history.
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
      // Commit the whole stroke as one undo step — but only if it changed pixels
      // (a tap on already-transparent area or a no-op restore leaves no history).
      if (strokeAffectedRef.current > 0 && strokePreRef.current) {
        commit(strokePreRef.current)
        setStatus(tool === 'erase' ? 'Erased with brush' : 'Restored with brush')
      }
      strokePreRef.current = null
      strokeAffectedRef.current = 0
    },
    [tool, redraw, commit],
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
      // The image was swapped/reset while we were running — drop this result
      // rather than splatting it onto the wrong picture. (The reload effect
      // installs a fresh pristine snapshot whenever the source changes.)
      if (pristineRef.current !== pristine || !workingRef.current) return
      // Commit the pre-AI state only now that we have a result (a failed run
      // leaves history untouched), then swap in the AI output.
      commit(cloneImageData(workingRef.current))
      // RMBG leaves the original background color tinting its soft matte (e.g. a
      // purple halo) — bleed it out, keyed off the original corner color for any
      // isolated specks. Gated by the same Defringe strength as manual removes.
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
      // A prior auto-trim crop leaves the view fitted to the smaller buffer; the
      // pristine restore changes dims back, so re-fit (like the resized undo path)
      // to avoid the stage clamping against stale dimensions.
      pz.reset()
      syncDims()
    }
    setApplied(false)
    setModified(false)
    // Pre-arm the reload-effect guard with the original src so restoreOriginal's
    // src change short-circuits its re-decode (the in-memory pristine is already
    // correct) — keeps the post-Apply Reset path flicker-free like the no-Apply one.
    if (logo.originalSrc) appliedSrcRef.current = logo.originalSrc
    // Also revert the store (undoes a prior Apply for previews/export).
    restoreOriginal()
    setStatus('Reset to original')
  }, [aiBusy, restoreOriginal, redraw, pz.reset, syncDims, logo.originalSrc])

  /**
   * Bake the working buffer to a canvas for export. When the matte preview is on
   * we flatten the cutout onto `matteColor` via a THROWAWAY copy — workingRef is
   * never mutated, so toggling the matte off restores transparency intact.
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
    // Guard the reload effect: keep these pixels & the Applied state.
    const dataUrl = canvas.toDataURL('image/png')
    appliedSrcRef.current = dataUrl
    setProcessedLogo(dataUrl, working.width, working.height)
    setApplied(true)
    // Keep the undo/redo history so edits made before Apply remain reversible
    // (an undo afterwards flips `applied` off, signalling the store is stale).
    setStatus('Applied — used everywhere (previews, vectorize, export)')
  }, [bakeCanvas, setProcessedLogo])

  const handleDownload = useCallback(async () => {
    const canvas = bakeCanvas()
    if (!canvas) return
    const blob = await canvasToBlob(canvas, 'image/png')
    const base = (logo.fileName ?? 'logo').replace(/\.[^.]+$/, '')
    downloadBlob(blob, `${base}-nobg.png`)
  }, [bakeCanvas, logo.fileName])

  /**
   * Run a one-shot in-place pixel op as a single history step: snapshot → mutate
   * → commit (iff it changed anything) → redraw, exactly like handleAuto. `run`
   * returns the affected-pixel count; `label`/`empty` are the status messages.
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
   * working buffer to a NEW, smaller ImageData, so it re-fits the view (pz.reset)
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
      // Already tight with no padding requested: skip the no-op history step.
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
