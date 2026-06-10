import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Bot,
  Check,
  Download,
  Droplet,
  Eraser,
  Loader2,
  Paintbrush,
  Redo2,
  RotateCcw,
  Sparkles,
  Undo2,
  Wand2,
} from 'lucide-react'
import { useCheckerClass, useLogo, useStore } from '../../store'
import { canvasToBlob, getImageData } from '../../lib/image'
import {
  autoRemove,
  brushStamp,
  brushStroke,
  cloneImageData,
  colorAt,
  defringe,
  floodRemove,
  removeColor,
  sampleCornerColor,
  type BrushMode,
  type RemoveOptions,
} from '../../lib/bgRemove'
import { aiRemoveBackground } from '../../lib/aiRemove'
import { downloadBlob } from '../../lib/download'
import { Button } from '../ui/Button'
import { Field, Slider, Toggle } from '../ui/controls'
import { CheckerToggle } from '../ui/CheckerToggle'
import { ZoomControls } from '../ui/ZoomControls'
import { usePanZoom } from '../../hooks/usePanZoom'
import { PanelEmptyState } from '../PanelEmptyState'

const MAX_DIM = 1024
const HISTORY_LIMIT = 30

type Mode = 'magic' | 'color' | 'erase' | 'restore'

const TOOLS: { value: Mode; label: string; icon: typeof Wand2 }[] = [
  { value: 'magic', label: 'Magic', icon: Wand2 },
  { value: 'color', label: 'By color', icon: Droplet },
  { value: 'erase', label: 'Erase', icon: Eraser },
  { value: 'restore', label: 'Restore', icon: Paintbrush },
]

function toolHint(mode: Mode): string {
  switch (mode) {
    case 'magic':
      return 'Click the background: erases the connected blob of similar color you click. Bump Tolerance if it stops too soon, lower it if it eats into the logo.'
    case 'color':
      return 'Click a color: erases that color everywhere at once — including enclosed gaps a single flood can’t reach.'
    case 'erase':
      return 'Drag to rub out pixels by hand. Best for stray specks and the holes auto-remove misses.'
    case 'restore':
      return 'Drag to paint the original image back — fix any spot you erased too much.'
  }
}

export default function CleanupPanel() {
  const logo = useLogo()
  const setProcessedLogo = useStore((s) => s.setProcessedLogo)
  const restoreOriginal = useStore((s) => s.restoreOriginal)
  const checkerClass = useCheckerClass()

  const pz = usePanZoom({ maxScale: 16 })

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

  const [mode, setMode] = useState<Mode>('magic')
  const [tolerance, setTolerance] = useState(36)
  const [softness, setSoftness] = useState(0.25)
  const [brushSize, setBrushSize] = useState(40)
  const [doDefringe, setDoDefringe] = useState(true)
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
  const [brushCursor, setBrushCursor] = useState<{ x: number; y: number } | null>(null)
  // Mirror of spaceHeldRef for cursor feedback (the ref drives the hot path).
  const [spacePan, setSpacePan] = useState(false)

  const isBrush = mode === 'erase' || mode === 'restore'
  const opts: RemoveOptions = { tolerance, softness }

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
      return
    }
    getImageData(logo.src, MAX_DIM, logo.isSvg ? logo.svgText : null)
      .then((data) => {
        if (cancelled) return
        workingRef.current = data
        pristineRef.current = cloneImageData(data)
        lastKeyRef.current = sampleCornerColor(data)
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
      pz.zoomAround(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015), el.getBoundingClientRect())
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
    workingRef.current = undoRef.current.pop()!
    setUndoLen(undoRef.current.length)
    setRedoLen(redoRef.current.length)
    redraw()
    setApplied(false)
    setModified(!equalsPristine())
    setStatus('Undid last change')
  }, [redraw, equalsPristine])

  const handleRedo = useCallback(() => {
    if (!redoRef.current.length) return
    const working = workingRef.current
    if (working) undoRef.current.push(working)
    workingRef.current = redoRef.current.pop()!
    setUndoLen(undoRef.current.length)
    setRedoLen(redoRef.current.length)
    redraw()
    setApplied(false)
    setModified(!equalsPristine())
    setStatus('Redid change')
  }, [redraw, equalsPristine])

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

      if (mode === 'magic' || mode === 'color') {
        const ix = Math.floor(p.x)
        const iy = Math.floor(p.y)
        if (ix < 0 || iy < 0 || ix >= working.width || iy >= working.height) return
        // Snapshot first, mutate, then commit only if it actually changed pixels.
        const pre = cloneImageData(working)
        const key = colorAt(working, ix, iy)
        lastKeyRef.current = key
        const affected =
          mode === 'magic' ? floodRemove(working, ix, iy, opts) : removeColor(working, key, opts)
        if (affected > 0) {
          if (doDefringe) defringe(working, key, 0.9)
          commit(pre)
          redraw()
          setStatus(
            `Removed ${affected.toLocaleString()} px (${mode === 'magic' ? 'contiguous' : 'by color'})`,
          )
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
      const src = mode === 'restore' ? pristineRef.current : undefined
      strokeAffectedRef.current += brushStamp(
        working,
        p.x,
        p.y,
        brushSize / 2,
        1 - softness,
        mode as BrushMode,
        src,
      )
      scheduleRedraw()
    },
    [aiBusy, mode, opts, doDefringe, brushSize, softness, imgCoords, commit, redraw, scheduleRedraw],
  )

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      // Drag-to-pan the view (Space/middle-button) — runs before any brush logic.
      if (panningViewRef.current) {
        if (stageRef.current) {
          pz.panBy(e.clientX - lastPanRef.current.x, e.clientY - lastPanRef.current.y, stageRef.current.getBoundingClientRect())
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
      const src = mode === 'restore' ? pristineRef.current : undefined
      strokeAffectedRef.current += brushStroke(
        working,
        last.x,
        last.y,
        p.x,
        p.y,
        brushSize / 2,
        1 - softness,
        mode as BrushMode,
        src,
      )
      lastPtRef.current = p
      scheduleRedraw()
    },
    [isBrush, aiBusy, mode, brushSize, softness, imgCoords, scheduleRedraw, pz.panBy],
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
        setStatus(mode === 'erase' ? 'Erased with brush' : 'Restored with brush')
      }
      strokePreRef.current = null
      strokeAffectedRef.current = 0
    },
    [mode, redraw, commit],
  )

  const handleAuto = useCallback(() => {
    const working = workingRef.current
    if (!working || aiBusy) return
    const pre = cloneImageData(working)
    const { color, affected } = autoRemove(working, opts)
    lastKeyRef.current = color
    if (affected > 0) {
      if (doDefringe) defringe(working, color, 0.9)
      commit(pre)
      redraw()
      setStatus(`Auto-removed corner background — ${affected.toLocaleString()} px`)
    } else {
      setStatus('Nothing to auto-remove — the corners are already clear.')
    }
  }, [aiBusy, opts, doDefringe, commit, redraw])

  const handleAi = useCallback(async () => {
    const pristine = pristineRef.current
    if (!pristine || aiBusy) return
    setAiBusy(true)
    setAiStatus('Loading AI model…')
    setStatus('')
    try {
      const result = await aiRemoveBackground(cloneImageData(pristine), (p) => {
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
      workingRef.current = result
      redraw()
      setStatus('AI removed the background — touch up with the Erase / Restore brushes if needed.')
    } catch (err) {
      console.error('[cleanup] AI background removal failed', err)
      setStatus('AI background removal failed. Check your connection and try again.')
    } finally {
      setAiBusy(false)
      setAiStatus('')
    }
  }, [aiBusy, commit, redraw])

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
  }, [aiBusy, restoreOriginal, redraw, logo.originalSrc])

  const handleApply = useCallback(() => {
    const working = workingRef.current
    if (!working) return
    const canvas = document.createElement('canvas')
    canvas.width = working.width
    canvas.height = working.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.putImageData(working, 0, 0)
    // Guard the reload effect: keep these pixels & the Applied state.
    const dataUrl = canvas.toDataURL('image/png')
    appliedSrcRef.current = dataUrl
    setProcessedLogo(dataUrl, working.width, working.height)
    setApplied(true)
    // Keep the undo/redo history so edits made before Apply remain reversible
    // (an undo afterwards flips `applied` off, signalling the store is stale).
    setStatus('Applied — used everywhere (previews, vectorize, export)')
  }, [setProcessedLogo])

  const handleDownload = useCallback(async () => {
    const working = workingRef.current
    if (!working) return
    const canvas = document.createElement('canvas')
    canvas.width = working.width
    canvas.height = working.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.putImageData(working, 0, 0)
    const blob = await canvasToBlob(canvas, 'image/png')
    const base = (logo.fileName ?? 'logo').replace(/\.[^.]+$/, '')
    downloadBlob(blob, `${base}-nobg.png`)
  }, [logo.fileName])

  if (!logo.src) {
    return (
      <div className="mx-auto max-w-5xl p-6">
        <PanelEmptyState
          icon={<Eraser size={26} />}
          title="No image to clean up"
          subtitle="Drop a PNG/JPG logo (or load an example) to remove its background."
        />
      </div>
    )
  }

  const ringDiameter = brushSize * scaleRef.current

  return (
    <div className="mx-auto grid max-w-6xl gap-6 p-6 lg:grid-cols-[300px_1fr]">
      {/* Controls */}
      <div className="flex flex-col gap-5">
        <div className="panel flex flex-col gap-5 p-4">
          <div>
            <h2 className="text-base font-semibold text-ink">Remove background</h2>
            <p className="mt-1 text-xs leading-snug text-muted">
              Knock out the background so your logo sits on transparency. Start with one of the
              one-click removers, then fine-tune by hand.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <Button variant="secondary" icon={<Sparkles size={15} />} onClick={handleAuto} disabled={aiBusy || !ready} block>
              Auto-remove (corners)
            </Button>
            <Button variant="primary" icon={aiBusy ? <Loader2 size={15} className="animate-spin" /> : <Bot size={15} />} onClick={handleAi} disabled={aiBusy || !ready} block>
              {aiBusy ? aiStatus || 'Working…' : 'AI auto-remove'}
            </Button>
            <p className="text-center text-[0.7rem] leading-snug text-faint">
              AI handles tricky backgrounds & holes the flood misses. First run downloads a model
              (~few sec), then it’s cached & offline.
            </p>
          </div>

          <div className="border-t border-line pt-4">
            <span className="field-label">Manual tools</span>
            <div className="mt-1.5 grid grid-cols-2 gap-0.5 rounded-lg bg-surface-3 p-0.5">
              {TOOLS.map((t) => {
                const Icon = t.icon
                const active = t.value === mode
                return (
                  <button
                    key={t.value}
                    type="button"
                    onClick={() => setMode(t.value)}
                    className={`flex h-9 items-center justify-center gap-1.5 rounded-[7px] px-2 text-xs font-medium transition-all ${
                      active ? 'bg-surface text-ink shadow-xs' : 'text-muted hover:text-ink-2'
                    }`}
                  >
                    <Icon size={14} /> {t.label}
                  </button>
                )
              })}
            </div>
            <p className="mt-1.5 text-xs leading-snug text-muted">{toolHint(mode)}</p>
          </div>

          {isBrush ? (
            <Field label="Brush size" hint="Brush diameter, in image pixels.">
              <Slider value={brushSize} min={4} max={200} unit="px" onChange={setBrushSize} />
            </Field>
          ) : (
            <Field label="Tolerance" hint="How close a color must be to count as background.">
              <Slider value={tolerance} min={1} max={160} onChange={setTolerance} />
            </Field>
          )}

          <Field label="Edge softness" hint={isBrush ? 'Feathers the brush edge.' : 'Feathers the cut edge to avoid jaggies.'}>
            <Slider
              value={Math.round(softness * 100)}
              min={0}
              max={100}
              unit="%"
              onChange={(v) => setSoftness(v / 100)}
            />
          </Field>

          {!isBrush && <Toggle checked={doDefringe} onChange={setDoDefringe} label="Defringe edges" />}

          <div className="flex gap-2">
            <Button variant="secondary" icon={<Undo2 size={15} />} onClick={handleUndo} disabled={undoLen === 0 || aiBusy} className="flex-1">
              Undo
            </Button>
            <Button variant="secondary" icon={<Redo2 size={15} />} onClick={handleRedo} disabled={redoLen === 0 || aiBusy} className="flex-1">
              Redo
            </Button>
            <Button variant="ghost" icon={<RotateCcw size={15} />} onClick={handleReset} disabled={aiBusy} className="flex-1">
              Reset
            </Button>
          </div>
        </div>

        <div className="panel flex flex-col gap-2 p-4">
          <Button variant="primary" icon={<Check size={15} />} onClick={handleApply} disabled={(!modified && !applied) || aiBusy || !ready} block>
            {applied ? 'Applied ✓' : 'Apply to logo'}
          </Button>
          <Button variant="secondary" icon={<Download size={15} />} onClick={handleDownload} disabled={aiBusy || !ready} block>
            Download PNG
          </Button>
          <p className="text-center text-xs text-muted">
            “Apply” feeds the cleaned PNG into previews, vectorize and export.
          </p>
        </div>
      </div>

      {/* Canvas stage */}
      <div className="flex flex-col gap-3">
        <div
          ref={setStage}
          className={`relative h-[64vh] min-h-[320px] overflow-hidden rounded-xl border border-line ${checkerClass}`}
        >
          {/* Zoom pill (top-left) + backdrop flip (top-right). */}
          <ZoomControls pz={pz} className="absolute left-3 top-3 z-10" />
          <CheckerToggle className="absolute right-3 top-3 z-10" />

          {ready ? (
            <div className="absolute inset-0 flex items-center justify-center p-4" style={pz.contentStyle}>
              <canvas
                ref={canvasRef}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={endStroke}
                onPointerCancel={endStroke}
                onMouseDown={(e) => {
                  if (e.button === 1) e.preventDefault() // suppress middle-click autoscroll while panning
                }}
                onPointerLeave={() => {
                  if (!paintingRef.current) setBrushCursor(null)
                }}
                className={`max-h-full max-w-full rounded-md ${
                  aiBusy
                    ? 'pointer-events-none opacity-60'
                    : spacePan
                      ? 'cursor-grab'
                      : isBrush
                        ? 'cursor-none'
                        : 'cursor-crosshair'
                }`}
                style={{
                  width: 'auto',
                  height: 'auto',
                  // Crisp, blocky pixels when magnified past fit (so you can nudge
                  // individual edge pixels); smooth interpolation when fit/zoomed out.
                  imageRendering: pz.scale > 1 ? 'pixelated' : 'auto',
                  touchAction: 'none',
                }}
              />
            </div>
          ) : (
            <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-muted">
              <Eraser size={16} /> Loading image…
            </div>
          )}

          {aiBusy && (
            <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-surface/70 backdrop-blur-sm">
              <Loader2 size={28} className="animate-spin text-accent" />
              <span className="text-sm font-medium text-ink">{aiStatus || 'Working…'}</span>
            </div>
          )}
        </div>
        <div className="flex items-center justify-between text-xs text-muted">
          <span>
            {status || 'Scroll to zoom · Space- or middle-drag to pan · try AI or Auto first, then Erase/Restore.'}
          </span>
          {workingRef.current && (
            <span className="font-mono">
              {workingRef.current.width}×{workingRef.current.height}
            </span>
          )}
        </div>
      </div>

      {/* Brush-size cursor ring (follows the pointer over the canvas). */}
      {isBrush && brushCursor && ready && !aiBusy && !spacePan && ringDiameter > 0 && (
        <div
          aria-hidden
          className="pointer-events-none fixed z-50 rounded-full border border-white shadow-[0_0_0_1px_rgba(0,0,0,0.55)]"
          style={{
            left: brushCursor.x,
            top: brushCursor.y,
            width: ringDiameter,
            height: ringDiameter,
            transform: 'translate(-50%, -50%)',
          }}
        />
      )}
    </div>
  )
}

