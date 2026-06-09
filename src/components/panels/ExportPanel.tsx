import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Download, ImageOff, Package, Sparkles, Layers } from 'lucide-react'
import { useAppearance, useEnv, useLogo } from '../../store'
import type { ExportTarget, RenderIconOptions } from '../../types'
import { Toggle } from '../ui/controls'
import { Button } from '../ui/Button'
import { downloadBlob } from '../../lib/download'
import { loadRenderSource } from '../../lib/image'
import type { RenderSource } from '../../lib/image'
import { DEFAULT_TARGETS, buildExportZip, renderIcon } from '../../lib/pwaExport'

/* ----------------------------------------------------------------- constants */

const GROUP_ORDER = ['favicon', 'apple', 'android', 'maskable', 'windows'] as const
type Group = (typeof GROUP_ORDER)[number]

const GROUP_META: Record<Group, { title: string; blurb: string }> = {
  favicon: { title: 'Favicon', blurb: 'Browser tab & bookmark icons (bundled into favicon.ico).' },
  apple: { title: 'Apple touch', blurb: 'Home-screen icons for iOS / iPadOS Safari.' },
  android: { title: 'Android / PWA', blurb: 'Standard install icons (purpose "any").' },
  maskable: { title: 'Maskable', blurb: 'Full-bleed adaptive icons Android can mask to any shape.' },
  windows: { title: 'Windows tiles', blurb: 'Pinned Start-menu tiles for legacy Windows / Edge.' },
}

/** Representative sizes shown in the live preview grid. */
const PREVIEW_TILES: { size: number; maskable: boolean; cap: number }[] = [
  { size: 16, maskable: false, cap: 32 },
  { size: 32, maskable: false, cap: 40 },
  { size: 48, maskable: false, cap: 48 },
  { size: 180, maskable: false, cap: 96 },
  { size: 192, maskable: false, cap: 96 },
  { size: 512, maskable: false, cap: 112 },
  { size: 512, maskable: true, cap: 112 },
]

/* --------------------------------------------------------------- preset logic */

type PresetKey = 'web' | 'pwa' | 'all'

/** Returns the set of target ids that a preset should enable. */
function presetIds(preset: PresetKey): Set<string> {
  if (preset === 'all') return new Set(DEFAULT_TARGETS.map((t) => t.id))
  if (preset === 'web') {
    return new Set([
      'favicon-16',
      'favicon-32',
      'favicon-48',
      'apple-180',
      'android-192',
      'android-512',
      'maskable-192',
      'maskable-512',
    ])
  }
  // Full PWA: all android + maskable + apple + favicon (no windows).
  return new Set(
    DEFAULT_TARGETS.filter(
      (t) => t.group === 'android' || t.group === 'maskable' || t.group === 'apple' || t.group === 'favicon',
    ).map((t) => t.id),
  )
}

/* ----------------------------------------------------------------- component */

export default function ExportPanel(): ReactNode {
  const logo = useLogo()
  const app = useAppearance()
  const env = useEnv()

  const [targets, setTargets] = useState<ExportTarget[]>(() => DEFAULT_TARGETS.map((t) => ({ ...t })))
  const [includeManifest, setIncludeManifest] = useState(true)
  const [includeHtml, setIncludeHtml] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const selectedCount = useMemo(() => targets.filter((t) => t.enabled).length, [targets])

  const baseOpts = useMemo<Omit<RenderIconOptions, 'size'>>(
    () => ({
      background: app.cardColor,
      shape: app.cardShape,
      radiusPct: app.cardRadius,
      paddingPct: app.padding,
      scale: app.scale,
      tintColor: app.tintEnabled ? app.tintColor : null,
      invert: app.invert,
    }),
    [app.cardColor, app.cardShape, app.cardRadius, app.padding, app.scale, app.tintEnabled, app.tintColor, app.invert],
  )

  const toggleTarget = useCallback((id: string) => {
    setTargets((prev) => prev.map((t) => (t.id === id ? { ...t, enabled: !t.enabled } : t)))
  }, [])

  const applyPreset = useCallback((preset: PresetKey) => {
    const ids = presetIds(preset)
    setTargets((prev) => prev.map((t) => ({ ...t, enabled: ids.has(t.id) })))
  }, [])

  const handleDownload = useCallback(async () => {
    if (!logo.src || selectedCount === 0) return
    setBusy(true)
    setError(null)
    try {
      const blob = await buildExportZip(logo.src, targets, baseOpts, {
        brandName: env.brandName,
        includeManifest,
        includeHtml,
        svgText: logo.isSvg ? logo.svgText : null,
      })
      const safeName = (env.brandName.trim() || 'app').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      downloadBlob(blob, `${safeName || 'app'}-icons.zip`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Export failed')
    } finally {
      setBusy(false)
    }
  }, [logo.src, logo.isSvg, logo.svgText, selectedCount, targets, baseOpts, env.brandName, includeManifest, includeHtml])

  /* -------------------------------------------------------------- empty state */

  if (!logo.src) {
    return (
      <div className="mx-auto max-w-5xl p-6">
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-line-strong bg-surface-2 px-6 py-20 text-center animate-in-fade">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-3 text-muted">
            <ImageOff size={22} />
          </div>
          <h2 className="text-base font-semibold text-ink">No logo yet</h2>
          <p className="max-w-sm text-sm text-muted">
            Drop a logo into LogoLab to generate a full favicon &amp; PWA icon set — every size, a real{' '}
            <span className="font-mono text-ink-2">favicon.ico</span>, and a webmanifest, all in one zip.
          </p>
        </div>
      </div>
    )
  }

  /* ----------------------------------------------------------------- content */

  return (
    <div className="mx-auto max-w-5xl p-6 animate-in-fade">
      <header className="mb-6">
        <h1 className="text-lg font-semibold text-ink">Export icons</h1>
        <p className="mt-1 text-sm text-muted">
          Generate a production-ready favicon &amp; PWA icon set. Icon look follows the sidebar appearance
          (card color, shape, radius, padding, scale &amp; tint).
        </p>
      </header>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]">
        {/* ------------------------------------------------------ left column */}
        <div className="flex flex-col gap-6">
          {/* Presets */}
          <section className="panel p-4">
            <div className="mb-3 flex items-center justify-between">
              <span className="field-label">Presets</span>
              <span className="text-xs text-muted">
                <span className="font-mono tabular-nums text-ink-2">{selectedCount}</span> selected
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" icon={<Sparkles size={15} />} onClick={() => applyPreset('web')}>
                Web essentials
              </Button>
              <Button variant="secondary" icon={<Package size={15} />} onClick={() => applyPreset('pwa')}>
                Full PWA
              </Button>
              <Button variant="secondary" icon={<Layers size={15} />} onClick={() => applyPreset('all')}>
                Everything
              </Button>
            </div>
          </section>

          {/* Target groups */}
          {GROUP_ORDER.map((group) => {
            const items = targets.filter((t) => t.group === group)
            if (items.length === 0) return null
            return (
              <section key={group} className="panel p-4">
                <div className="mb-3">
                  <h2 className="text-sm font-semibold text-ink">{GROUP_META[group].title}</h2>
                  <p className="mt-0.5 text-xs text-muted">{GROUP_META[group].blurb}</p>
                </div>
                <ul className="flex flex-col divide-y divide-line">
                  {items.map((t) => (
                    <li key={t.id} className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                      <div className="flex items-center gap-2.5">
                        <Toggle checked={t.enabled} onChange={() => toggleTarget(t.id)} />
                        <span className="text-sm text-ink">{t.label}</span>
                      </div>
                      <span className="rounded-md bg-surface-3 px-2 py-0.5 font-mono text-[11px] tabular-nums text-ink-2">
                        {t.size}px
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )
          })}

          {/* Options */}
          <section className="panel p-4">
            <h2 className="mb-3 text-sm font-semibold text-ink">Bundle options</h2>
            <div className="flex flex-col gap-3">
              <label className="flex items-center justify-between gap-3">
                <span className="text-sm text-ink-2">
                  Include <span className="font-mono text-ink">manifest.webmanifest</span>
                </span>
                <Toggle checked={includeManifest} onChange={setIncludeManifest} />
              </label>
              <label className="flex items-center justify-between gap-3">
                <span className="text-sm text-ink-2">
                  Include HTML <span className="font-mono text-ink">&lt;head&gt;</span> snippet
                </span>
                <Toggle checked={includeHtml} onChange={setIncludeHtml} />
              </label>
            </div>
            <p className="mt-3 rounded-md bg-surface-3 px-3 py-2 text-xs leading-snug text-muted">
              Maskable icons are drawn full-bleed and opaque with an enlarged safe-zone (dashed circle in the
              preview) so Android can crop them to any shape without clipping your mark.
            </p>
          </section>
        </div>

        {/* ----------------------------------------------------- right column */}
        <div className="lg:sticky lg:top-6 lg:self-start">
          <section className="panel flex flex-col gap-4 p-4">
            <div>
              <h2 className="text-sm font-semibold text-ink">Live preview</h2>
              <p className="mt-0.5 text-xs text-muted">Rendered with your current appearance.</p>
            </div>

            <PreviewGrid
              src={logo.src}
              svgText={logo.isSvg ? logo.svgText : null}
              baseOpts={baseOpts}
            />

            {error && (
              <p className="rounded-md bg-[color:var(--color-bad)]/8 px-3 py-2 text-xs text-bad">{error}</p>
            )}

            <Button
              variant="primary"
              block
              icon={<Download size={16} />}
              disabled={busy || selectedCount === 0}
              onClick={handleDownload}
            >
              {busy ? 'Packaging…' : selectedCount === 0 ? 'Select an icon' : `Download .zip (${selectedCount})`}
            </Button>
          </section>
        </div>
      </div>
    </div>
  )
}

/* --------------------------------------------------------------- PreviewGrid */

function PreviewGrid({
  src,
  svgText,
  baseOpts,
}: {
  src: string
  svgText: string | null
  baseOpts: Omit<RenderIconOptions, 'size'>
}): ReactNode {
  const [render, setRender] = useState<RenderSource | null>(null)

  useEffect(() => {
    let alive = true
    setRender(null)
    loadRenderSource(src, 1024, svgText)
      .then((rs) => {
        if (alive) setRender(rs)
      })
      .catch(() => {
        if (alive) setRender(null)
      })
    return () => {
      alive = false
    }
  }, [src, svgText])

  return (
    <div className="grid grid-cols-3 gap-3">
      {PREVIEW_TILES.map((tile, i) => (
        <PreviewTile
          key={`${tile.size}-${tile.maskable}-${i}`}
          render={render}
          size={tile.size}
          cap={tile.cap}
          maskable={tile.maskable}
          baseOpts={baseOpts}
        />
      ))}
    </div>
  )
}

function PreviewTile({
  render,
  size,
  cap,
  maskable,
  baseOpts,
}: {
  render: RenderSource | null
  size: number
  cap: number
  maskable: boolean
  baseOpts: Omit<RenderIconOptions, 'size'>
}): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const target = canvasRef.current
    if (!target || !render) return
    const rendered = renderIcon(render.source, render.width, render.height, { ...baseOpts, size, maskable })
    target.width = rendered.width
    target.height = rendered.height
    const ctx = target.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, target.width, target.height)
    ctx.drawImage(rendered, 0, 0)
  }, [render, size, maskable, baseOpts])

  const display = Math.min(cap, size)

  return (
    <div className="flex flex-col items-center gap-1.5">
      <div
        className="checkerboard relative flex items-center justify-center rounded-md border border-line"
        style={{ width: cap + 16, height: cap + 16 }}
      >
        <canvas
          ref={canvasRef}
          style={{
            width: display,
            height: display,
            imageRendering: size <= 48 ? 'pixelated' : 'auto',
          }}
        />
        {maskable && (
          // Dashed safe-zone circle (~80% of the tile) overlaid on the maskable preview.
          <span
            aria-hidden
            className="pointer-events-none absolute rounded-full border border-dashed border-accent/70"
            style={{ width: display * 0.8, height: display * 0.8 }}
          />
        )}
      </div>
      <span className="font-mono text-[10px] tabular-nums text-muted">
        {maskable ? 'mask ' : ''}
        {size}px
      </span>
    </div>
  )
}
