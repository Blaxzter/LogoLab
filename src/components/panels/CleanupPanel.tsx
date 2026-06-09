import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Check,
  Download,
  Droplet,
  Eraser,
  RotateCcw,
  Sparkles,
  Undo2,
  Wand2,
} from 'lucide-react'
import { useLogo, useStore } from '../../store'
import { canvasToBlob, getImageData } from '../../lib/image'
import {
  autoRemove,
  cloneImageData,
  colorAt,
  defringe,
  floodRemove,
  removeColor,
  sampleCornerColor,
  type RemoveOptions,
} from '../../lib/bgRemove'
import { downloadBlob } from '../../lib/download'
import { Button } from '../ui/Button'
import { Field, Segmented, Slider, Toggle } from '../ui/controls'

const MAX_DIM = 1024
type Mode = 'magic' | 'color'

export default function CleanupPanel() {
  const logo = useLogo()
  const setProcessedLogo = useStore((s) => s.setProcessedLogo)
  const restoreOriginal = useStore((s) => s.restoreOriginal)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const workingRef = useRef<ImageData | null>(null)
  const pristineRef = useRef<ImageData | null>(null)
  const historyRef = useRef<ImageData[]>([])
  const lastKeyRef = useRef<{ r: number; g: number; b: number } | null>(null)
  // The data URL we last Applied. When logo.src equals it, the reload effect
  // skips the redundant re-decode and preserves the "Applied" state. Matching on
  // the value (not a boolean) is idempotent — a re-upload never collides.
  const appliedSrcRef = useRef<string | null>(null)

  const [mode, setMode] = useState<Mode>('magic')
  const [tolerance, setTolerance] = useState(36)
  const [softness, setSoftness] = useState(0.25)
  const [doDefringe, setDoDefringe] = useState(true)
  const [ready, setReady] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [historyLen, setHistoryLen] = useState(0)
  const [status, setStatus] = useState<string>('')
  const [applied, setApplied] = useState(false)

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

  // (Re)load the working pixels whenever the source image changes.
  useEffect(() => {
    // The src change came from our own Apply — workingRef already holds those
    // pixels. Skip the re-decode and keep the "Applied" UI state intact.
    if (logo.src && logo.src === appliedSrcRef.current) return
    let cancelled = false
    setReady(false)
    setDirty(false)
    setApplied(false)
    historyRef.current = []
    setHistoryLen(0)
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
  }, [logo.src, logo.isSvg, logo.svgText, redraw])

  // Draw once the canvas is mounted/ready (runs after commit, so canvasRef
  // points at the live element — robust across unmount/remount on reload).
  useEffect(() => {
    if (ready) redraw()
  }, [ready, redraw])

  const pushHistory = useCallback(() => {
    const working = workingRef.current
    if (!working) return
    const hist = historyRef.current
    hist.push(cloneImageData(working))
    if (hist.length > 25) hist.shift()
    setHistoryLen(hist.length)
  }, [])

  const opts: RemoveOptions = { tolerance, softness }

  const handleCanvasClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current
      const working = workingRef.current
      if (!canvas || !working) return
      const rect = canvas.getBoundingClientRect()
      const x = Math.floor(((e.clientX - rect.left) / rect.width) * working.width)
      const y = Math.floor(((e.clientY - rect.top) / rect.height) * working.height)
      if (x < 0 || y < 0 || x >= working.width || y >= working.height) return

      pushHistory()
      const key = colorAt(working, x, y)
      lastKeyRef.current = key
      const affected =
        mode === 'magic' ? floodRemove(working, x, y, opts) : removeColor(working, key, opts)
      if (doDefringe && affected > 0) defringe(working, key, 0.9)
      redraw()
      setDirty(true)
      setApplied(false)
      setStatus(
        affected > 0
          ? `Removed ${affected.toLocaleString()} px (${mode === 'magic' ? 'contiguous' : 'by color'})`
          : 'Nothing within tolerance there — try raising tolerance.',
      )
    },
    [mode, opts, doDefringe, pushHistory, redraw],
  )

  const handleAuto = useCallback(() => {
    const working = workingRef.current
    if (!working) return
    pushHistory()
    const { color, affected } = autoRemove(working, opts)
    lastKeyRef.current = color
    if (doDefringe && affected > 0) defringe(working, color, 0.9)
    redraw()
    setDirty(true)
    setApplied(false)
    setStatus(`Auto-removed corner background — ${affected.toLocaleString()} px`)
  }, [opts, doDefringe, pushHistory, redraw])

  const handleUndo = useCallback(() => {
    const hist = historyRef.current
    const prev = hist.pop()
    if (!prev) return
    workingRef.current = prev
    setHistoryLen(hist.length)
    redraw()
    setDirty(hist.length > 0)
    setApplied(false)
    setStatus('Undid last removal')
  }, [redraw])

  const handleReset = useCallback(() => {
    historyRef.current = []
    setHistoryLen(0)
    // Restore the working pixels directly from the pristine snapshot — don't
    // rely on logo.src changing identity (it won't if nothing was Applied).
    if (pristineRef.current) {
      workingRef.current = cloneImageData(pristineRef.current)
      redraw()
    }
    setDirty(false)
    setApplied(false)
    // Also revert the store (undoes a prior Apply for previews/export).
    restoreOriginal()
    setStatus('Reset to original')
  }, [restoreOriginal, redraw])

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
    setDirty(false)
    historyRef.current = []
    setHistoryLen(0)
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
        <EmptyState />
      </div>
    )
  }

  return (
    <div className="mx-auto grid max-w-6xl gap-6 p-6 lg:grid-cols-[300px_1fr]">
      {/* Controls */}
      <div className="flex flex-col gap-5">
        <div className="panel flex flex-col gap-5 p-4">
          <div>
            <h2 className="text-base font-semibold text-ink">Remove background</h2>
            <p className="mt-1 text-xs leading-snug text-muted">
              Click the background to erase it. Great for cleaning AI-generated icons before
              tracing or export.
            </p>
          </div>

          <Button variant="primary" icon={<Sparkles size={15} />} onClick={handleAuto} block>
            Auto-remove background
          </Button>

          <Field label="Tool" hint={mode === 'magic' ? 'Erases the connected region you click.' : 'Erases every pixel of that color in the image.'}>
            <Segmented<Mode>
              value={mode}
              onChange={setMode}
              options={[
                { value: 'magic', label: <span className="flex items-center gap-1.5"><Wand2 size={14} /> Magic</span> },
                { value: 'color', label: <span className="flex items-center gap-1.5"><Droplet size={14} /> By color</span> },
              ]}
            />
          </Field>

          <Field label="Tolerance" hint="How close a color must be to count as background.">
            <Slider value={tolerance} min={1} max={160} onChange={setTolerance} />
          </Field>

          <Field label="Edge softness" hint="Feathers the cut edge to avoid jaggies.">
            <Slider
              value={Math.round(softness * 100)}
              min={0}
              max={100}
              unit="%"
              onChange={(v) => setSoftness(v / 100)}
            />
          </Field>

          <Toggle checked={doDefringe} onChange={setDoDefringe} label="Defringe edges" />

          <div className="flex gap-2">
            <Button variant="secondary" icon={<Undo2 size={15} />} onClick={handleUndo} disabled={historyLen === 0} className="flex-1">
              Undo
            </Button>
            <Button variant="ghost" icon={<RotateCcw size={15} />} onClick={handleReset} className="flex-1">
              Reset
            </Button>
          </div>
        </div>

        <div className="panel flex flex-col gap-2 p-4">
          <Button variant="primary" icon={<Check size={15} />} onClick={handleApply} disabled={!dirty && !applied} block>
            {applied ? 'Applied ✓' : 'Apply to logo'}
          </Button>
          <Button variant="secondary" icon={<Download size={15} />} onClick={handleDownload} block>
            Download PNG
          </Button>
          <p className="text-center text-xs text-muted">
            “Apply” feeds the cleaned PNG into previews, vectorize and export.
          </p>
        </div>
      </div>

      {/* Canvas stage */}
      <div className="flex flex-col gap-3">
        <div className="checkerboard flex min-h-[320px] items-center justify-center overflow-hidden rounded-xl border border-line p-4">
          {ready ? (
            <canvas
              ref={canvasRef}
              onClick={handleCanvasClick}
              className="max-h-[64vh] max-w-full cursor-crosshair rounded-md"
              style={{ width: 'auto', height: 'auto', imageRendering: 'auto' }}
            />
          ) : (
            <div className="flex items-center gap-2 text-sm text-muted">
              <Eraser size={16} /> Loading image…
            </div>
          )}
        </div>
        <div className="flex items-center justify-between text-xs text-muted">
          <span>{status || 'Tip: start with Auto, then fine-tune by clicking leftover areas.'}</span>
          {workingRef.current && (
            <span className="font-mono">
              {workingRef.current.width}×{workingRef.current.height}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-line-strong bg-surface-2 px-6 py-16 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-3 text-muted">
        <Eraser size={20} />
      </div>
      <div>
        <p className="text-sm font-medium text-ink">No image to clean up</p>
        <p className="text-sm text-muted">Drop a PNG/JPG logo to remove its background.</p>
      </div>
    </div>
  )
}
