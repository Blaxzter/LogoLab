import { useCallback, useEffect, useRef, useState } from 'react'
import { ImageUp, Maximize2, RotateCcw, Smartphone } from 'lucide-react'
import { LogoMark } from '../LogoMark'
import { PopoverSlider } from '../ui/PopoverSlider'
import { Tooltip } from '../ui/Tooltip'
import { useStore } from '../../store'
import type { DeviceId } from '../../store'
import { useIsMobile } from '../../hooks/useIsMobile'
import { loadImageElement } from '../../lib/image'

interface DeviceConfig {
  frame: string
  shot: string
  shape: 'rounded' | 'circle'
  radiusPct?: number
  /** Screen corner radius as % of screen width (clips the screenshot). */
  cornerPct: number
  /** Synthetic notch / punch-hole drawn on top (sizes are fractions of screen width). */
  cutout: { kind: 'notch' | 'hole'; w: number; h?: number }
  label: string
}

const CONFIG: Record<DeviceId, DeviceConfig> = {
  ios: {
    frame: '/mockups/iphone_device.png',
    shot: '/mockups/iphone.png',
    shape: 'rounded',
    radiusPct: 22.3,
    cornerPct: 12,
    cutout: { kind: 'notch', w: 0.36, h: 0.07 },
    label: 'iPhone',
  },
  android: {
    frame: '/mockups/xiaomi_device.png',
    shot: '/mockups/android.png',
    shape: 'circle',
    cornerPct: 6,
    cutout: { kind: 'hole', w: 0.055 },
    label: 'Android',
  },
}

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

interface ProcessedFrame {
  /** Frame with its screen area knocked out (notch kept), as a data URL. */
  src: string
  screen: Rect
  aspect: number
}

const frameCache = new Map<string, ProcessedFrame>()

/**
 * Turn a device-frame PNG into an overlay: knock the screen out so a screenshot
 * placed behind shows through, while keeping the bezel + notch/punch-hole on top.
 * Works for both opaque-black-screen frames and already-transparent ones.
 */
async function processFrame(src: string): Promise<ProcessedFrame> {
  const cached = frameCache.get(src)
  if (cached) return cached

  const img = await loadImageElement(src)
  const aspect = img.naturalWidth / img.naturalHeight
  const scale = Math.min(1, 720 / img.naturalWidth)
  const W = Math.max(1, Math.round(img.naturalWidth * scale))
  const H = Math.max(1, Math.round(img.naturalHeight * scale))
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) {
    const fb = { src, screen: { x: 0.03, y: 0.015, w: 0.94, h: 0.97 }, aspect }
    frameCache.set(src, fb)
    return fb
  }
  ctx.drawImage(img, 0, 0, W, H)
  const imageData = ctx.getImageData(0, 0, W, H)
  const d = imageData.data
  const cx = Math.floor(W / 2)
  const cy = Math.floor(H / 2)
  const at = (x: number, y: number) => (y * W + x) * 4
  const centerOpaqueDark =
    d[at(cx, cy) + 3] > 180 &&
    d[at(cx, cy)] < 45 &&
    d[at(cx, cy) + 1] < 45 &&
    d[at(cx, cy) + 2] < 45

  // The screen is either the opaque-black region (typical) or a transparent hole.
  const isScreen = centerOpaqueDark
    ? (i: number) => d[i + 3] > 180 && d[i] < 45 && d[i + 1] < 45 && d[i + 2] < 45
    : (i: number) => d[i + 3] < 60

  // Flood-fill the connected screen region from the center.
  const visited = new Uint8Array(W * H)
  const stack = [cy * W + cx]
  let minX = W
  let minY = H
  let maxX = -1
  let maxY = -1
  const region: number[] = []
  if (isScreen(at(cx, cy))) {
    while (stack.length) {
      const idx = stack.pop()!
      if (visited[idx]) continue
      visited[idx] = 1
      if (!isScreen(idx * 4)) continue
      region.push(idx)
      const x = idx % W
      const y = (idx - x) / W
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      if (x > 0) stack.push(idx - 1)
      if (x < W - 1) stack.push(idx + 1)
      if (y > 0) stack.push(idx - W)
      if (y < H - 1) stack.push(idx + W)
    }
  }

  let screen: Rect
  let outSrc = src
  if (maxX < 0) {
    screen = { x: 0.03, y: 0.015, w: 0.94, h: 0.97 }
  } else {
    const bw = maxX - minX + 1
    const bh = maxY - minY + 1
    screen = { x: minX / W, y: minY / H, w: bw / W, h: bh / H }
    if (centerOpaqueDark) {
      // Knock the whole screen out (a synthetic notch is drawn separately, since
      // the real notch is the same black as the display and can't be isolated).
      for (const idx of region) d[idx * 4 + 3] = 0
      ctx.putImageData(imageData, 0, 0)
      outSrc = canvas.toDataURL('image/png')
    }
    // transparent-screen frames need no knockout (outSrc stays the original).
  }

  const result = { src: outSrc, screen, aspect }
  frameCache.set(src, result)
  return result
}

export function DeviceMock({ id }: { id: DeviceId }) {
  const cfg = CONFIG[id]
  const mock = useStore((s) => s.mockups[id])
  const setMock = useStore((s) => s.setMock)
  const resetMock = useStore((s) => s.resetMock)

  const isMobile = useIsMobile()
  const [useFrame, setUseFrame] = useState(true)
  const [frame, setFrame] = useState<ProcessedFrame | null>(null)
  const [screenW, setScreenW] = useState(0)
  const [screenH, setScreenH] = useState(0)

  const screenRef = useRef<HTMLDivElement | null>(null)
  const draggingRef = useRef(false)
  const fileRef = useRef<HTMLInputElement | null>(null)

  const shot = mock.shot ?? cfg.shot

  useEffect(() => {
    let alive = true
    processFrame(cfg.frame)
      .then((f) => alive && setFrame(f))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [cfg.frame])

  useEffect(() => {
    const el = screenRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      setScreenW(entries[0].contentRect.width)
      setScreenH(entries[0].contentRect.height)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [useFrame, frame])

  const rect: Rect = useFrame && frame ? frame.screen : { x: 0, y: 0, w: 1, h: 1 }
  const aspect = frame?.aspect ?? 0.49
  const iconPx = Math.max(8, Math.round(mock.size * screenW))
  const cornerRadius = (screenW * cfg.cornerPct) / 100

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!draggingRef.current || !screenRef.current) return
      const r = screenRef.current.getBoundingClientRect()
      const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
      const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))
      setMock(id, { x, y })
    },
    [id, setMock],
  )

  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault()
    draggingRef.current = true
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* best-effort */
    }
  }
  const endDrag = (e: React.PointerEvent) => {
    draggingRef.current = false
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
  }

  const onReplace = (file: File | undefined) => {
    if (!file) return
    setMock(id, { shot: URL.createObjectURL(file) })
  }

  return (
    <div className="flex h-full flex-col">
      <div
        className="flex flex-1 items-center justify-center overflow-hidden p-4"
        style={{ background: 'linear-gradient(160deg,#f3f4f7,#e8eaef)', minHeight: 360 }}
      >
        <div className="relative" style={{ height: 420, maxWidth: '100%', aspectRatio: String(aspect) }}>
          {/* Screenshot screen (BEHIND the frame) */}
          <div
            ref={screenRef}
            className="absolute select-none overflow-hidden"
            style={{
              left: `${rect.x * 100}%`,
              top: `${rect.y * 100}%`,
              width: `${rect.w * 100}%`,
              height: `${rect.h * 100}%`,
              borderRadius: cornerRadius,
              boxShadow: useFrame ? 'none' : '0 18px 50px -16px rgba(16,18,27,0.4)',
            }}
          >
            {/* object-fill maps the whole capture onto the screen (no crop), so the
                status bar stays aligned to the top. */}
            <img src={shot} alt="" draggable={false} className="h-full w-full object-fill" />

            <div
              role="button"
              aria-label="Drag to position the logo"
              onPointerDown={startDrag}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              className="absolute cursor-grab touch-none active:cursor-grabbing"
              style={{
                left: `${mock.x * 100}%`,
                top: `${mock.y * 100}%`,
                width: iconPx,
                height: iconPx,
                transform: 'translate(-50%,-50%)',
              }}
            >
              <LogoMark
                size={iconPx}
                showCard
                shape={cfg.shape}
                radiusPct={cfg.radiusPct}
                clip={cfg.shape === 'circle'}
              />
            </div>

            {/* Synthetic notch / punch-hole (the real one can't be isolated from the frame) */}
            {useFrame && screenW > 0 && cfg.cutout.kind === 'notch' && (
              <div
                className="pointer-events-none absolute left-1/2 top-0 -translate-x-1/2 bg-black"
                style={{
                  width: cfg.cutout.w * screenW,
                  height: (cfg.cutout.h ?? 0.07) * screenW,
                  borderBottomLeftRadius: (cfg.cutout.h ?? 0.07) * screenW,
                  borderBottomRightRadius: (cfg.cutout.h ?? 0.07) * screenW,
                }}
              />
            )}
            {useFrame && screenW > 0 && cfg.cutout.kind === 'hole' && (
              <div
                className="pointer-events-none absolute left-1/2 -translate-x-1/2 rounded-full bg-black ring-1 ring-white/10"
                style={{
                  width: cfg.cutout.w * screenW,
                  height: cfg.cutout.w * screenW,
                  top: Math.max(4, screenH * 0.014),
                }}
              />
            )}
          </div>

          {/* Device frame ON TOP (screen knocked out, notch/bezel kept) */}
          {useFrame && frame && (
            <img
              src={frame.src}
              alt=""
              draggable={false}
              className="pointer-events-none absolute inset-0 h-full w-full"
            />
          )}
        </div>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-2 border-t border-line bg-surface px-3 py-2">
        <span className="shrink-0 text-xs text-muted">Drag the icon{isMobile ? '' : ' ·'}</span>
        {/* Desktop has room for an inline slider; mobile collapses it into a
            popover button so the action buttons keep their breathing room. */}
        {isMobile ? (
          <PopoverSlider
            title="Icon size"
            value={Math.round(mock.size * 100)}
            min={6}
            max={40}
            onChange={(v) => setMock(id, { size: v / 100 })}
            valueText={`${Math.round(mock.size * 100)}`}
            className="ml-auto"
          >
            <Maximize2 size={14} />
          </PopoverSlider>
        ) : (
          <input
            type="range"
            min={6}
            max={40}
            value={Math.round(mock.size * 100)}
            onChange={(e) => setMock(id, { size: Number(e.target.value) / 100 })}
            className="h-2 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-line-strong"
            aria-label="Icon size"
          />
        )}
        <Tooltip label="Toggle device frame">
          <button
            type="button"
            onClick={() => setUseFrame((v) => !v)}
            aria-label="Toggle device frame"
            className={`btn h-8 px-2 ${useFrame ? 'btn-primary' : 'btn-secondary'}`}
          >
            <Smartphone size={14} />
          </button>
        </Tooltip>
        <Tooltip label="Replace screenshot">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            aria-label="Replace screenshot"
            className="btn btn-secondary h-8 px-2"
          >
            <ImageUp size={14} />
          </button>
        </Tooltip>
        <Tooltip label="Reset placement & screenshot">
          <button
            type="button"
            onClick={() => resetMock(id)}
            aria-label="Reset placement & screenshot"
            className="btn btn-ghost h-8 px-2"
          >
            <RotateCcw size={14} />
          </button>
        </Tooltip>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => onReplace(e.target.files?.[0])}
        />
      </div>
    </div>
  )
}
