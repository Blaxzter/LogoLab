// Walk a set of presets, render every icon in them, and write the collection to
// disk — the half of the pipeline that turns one logo into a folder an agent can
// drop into a project.
//
// Rendering is per SIZE, not per file: a Tauri export asks for 32px four times
// over (32x32.png, Square30x30 rounds up, the .ico, the .icns) and each distinct
// (size, maskable, shape, background) combination is rendered once and reused.

import { existsSync, writeFileSync } from 'node:fs'
import { join, posix, relative } from 'node:path'
import { encodeIcoBytes, type RenderIconOpts } from '../lib/iconSpec.ts'
import type { IconShape } from '../types'
import { encodeIcns } from './icns.ts'
import { customPreset, presetById, type IconFileSpec, type Preset } from './presets.ts'
import { renderIconPng, type PreparedLogo } from './render.ts'
import { ensureDir, ensureParent, humanBytes } from './runtime.ts'

/** How the logo sits in the icon. Defaults keep the source art full-bleed. */
export interface Appearance {
  /** Card colour behind the logo, or 'transparent' to keep the source's alpha. */
  background: string
  shape: IconShape
  /** Corner radius as a % of size (the 'rounded' shape only). */
  radiusPct: number
  /** Safe-zone inset as a % of size. Maskable targets raise this to their own floor. */
  paddingPct: number
  /** Logo scale inside the safe box. */
  scale: number
  /** Recolour the (monochrome) logo through its alpha. */
  tintColor?: string | null
  invert?: boolean
}

/**
 * Full-bleed passthrough: an image model's icon IS the icon, so by default it is
 * not re-cropped, re-carded or re-padded. Ask for a background + padding to get
 * the studio's card look instead (that is what the UI defaults to, for logos that
 * still need a plate behind them).
 */
export const DEFAULT_APPEARANCE: Appearance = {
  background: 'transparent',
  shape: 'square',
  radiusPct: 24,
  paddingPct: 0,
  scale: 1,
  tintColor: null,
  invert: false,
}

export interface ExportRequest {
  /** Preset ids (see presets.ts); unknown ids are an error, empty means 'pwa'. */
  presets?: string[]
  /** Extra arbitrary sizes, written to `icons/icon-<n>.png`. */
  sizes?: number[]
  appName?: string
  appearance?: Partial<Appearance>
  /** Write a copy of the SVG next to the PNGs where the layout has a place for it. */
  svg?: string | null
}

export interface WrittenFile {
  /** Path relative to the export root, POSIX-separated (stable across platforms). */
  path: string
  bytes: number
  /** True when a file was already there and got replaced. */
  replaced: boolean
}

export interface ExportReport {
  outDir: string
  presets: string[]
  files: WrittenFile[]
  totalBytes: number
  summary: string
}

/** The card colour for one file: the chosen one, or a platform's opaque floor. */
function backgroundFor(spec: IconFileSpec, app: Appearance): string {
  if (app.background !== 'transparent') return app.background
  return spec.opaqueBackground ?? app.background
}

/** Cache key for one rendered PNG. */
function iconKey(spec: IconFileSpec, app: Appearance): string {
  return [spec.size, spec.maskable ? 'm' : '', spec.shape ?? app.shape, backgroundFor(spec, app)].join('|')
}

function optsFor(spec: IconFileSpec, app: Appearance): RenderIconOpts {
  return {
    size: spec.size,
    background: backgroundFor(spec, app),
    shape: spec.shape ?? app.shape,
    radiusPct: app.radiusPct,
    paddingPct: app.paddingPct,
    scale: app.scale,
    tintColor: app.tintColor ?? null,
    invert: app.invert === true,
    maskable: spec.maskable === true,
  }
}

/** Resolve the requested preset ids (plus a custom-size preset when asked). */
export function resolvePresets(req: ExportRequest): Preset[] {
  const ids = req.presets?.length ? req.presets : ['pwa']
  const out: Preset[] = []
  for (const id of ids) {
    const preset = presetById(id)
    if (!preset) throw new Error(`Unknown preset "${id}". Available: ${['pwa', 'favicon', 'web', 'tauri', 'electron', 'android', 'ios', 'extension'].join(', ')}`)
    out.push(preset)
  }
  if (req.sizes?.length) out.push(customPreset(req.sizes))
  return out
}

/** Render and write one collection. Returns what landed on disk. */
export function exportCollection(logo: PreparedLogo, outDir: string, req: ExportRequest = {}): ExportReport {
  const presets = resolvePresets(req)
  const app: Appearance = { ...DEFAULT_APPEARANCE, ...req.appearance }
  const appName = req.appName?.trim() || 'App'
  const root = ensureDir(outDir)

  const rendered = new Map<string, Uint8Array>()
  const png = (spec: IconFileSpec): Uint8Array => {
    const key = iconKey(spec, app)
    const hit = rendered.get(key)
    if (hit) return hit
    const bytes = renderIconPng(logo, optsFor(spec, app))
    rendered.set(key, bytes)
    return bytes
  }

  const files: WrittenFile[] = []
  const write = (relPath: string, bytes: Uint8Array | string): void => {
    const full = ensureParent(join(root, relPath))
    const replaced = existsSync(full)
    writeFileSync(full, bytes)
    const size = typeof bytes === 'string' ? Buffer.byteLength(bytes) : bytes.byteLength
    files.push({ path: posix.join(...relPath.split(/[\\/]/)), bytes: size, replaced })
  }

  for (const preset of presets) {
    for (const spec of preset.icons) write(spec.path, png(spec))

    for (const container of preset.containers ?? []) {
      // A container's member sizes are rendered with the collection's plain
      // appearance — never maskable, never re-shaped.
      const members = container.sizes.map((size) => ({ size, png: png({ path: container.path, size }) }))
      if (container.kind === 'ico') {
        write(container.path, encodeIcoBytes(members))
      } else {
        write(container.path, encodeIcns(new Map(members.map((m) => [m.size, m.png]))))
      }
    }

    for (const text of preset.text?.({ appName, background: app.background }) ?? []) {
      write(text.path, text.content)
    }

    if (req.svg && preset.svgPath) write(preset.svgPath, req.svg)
  }

  write('README.md', readme(appName, presets, app, files, root))

  const totalBytes = files.reduce((n, f) => n + f.bytes, 0)
  return {
    outDir: root,
    presets: presets.map((p) => p.id),
    files,
    totalBytes,
    summary: `${files.length} files (${humanBytes(totalBytes)}) in ${root}`,
  }
}

function readme(appName: string, presets: Preset[], app: Appearance, files: WrittenFile[], root: string): string {
  const lines: string[] = []
  lines.push(`# ${appName} — icons`)
  lines.push('')
  lines.push('Generated by [LogoLab](https://github.com/Blaxzter/LogoLab) through its MCP server.')
  lines.push('')
  lines.push('## What is here')
  lines.push('')
  for (const preset of presets) {
    lines.push(`- **${preset.label}** — ${preset.summary}`)
  }
  lines.push('')
  lines.push('## Appearance')
  lines.push('')
  lines.push(`- card: ${app.background === 'transparent' ? 'transparent (the source art, full bleed)' : `${app.background}, ${app.shape}${app.shape === 'rounded' ? ` @ ${app.radiusPct}% radius` : ''}`}`)
  lines.push(`- safe-zone padding ${app.paddingPct}%, logo scale ${app.scale}`)
  if (app.tintColor) lines.push(`- tinted ${app.tintColor}`)
  lines.push('')
  lines.push('Maskable / adaptive icons ignore that padding and use their own floor:')
  lines.push('Android keeps only the centre **72dp of 108dp**, a circle of ~66% diameter,')
  lines.push('so those files are full-bleed with the mark held inside that circle.')
  lines.push('')
  lines.push('## Files')
  lines.push('')
  for (const f of files) lines.push(`- \`${f.path}\` (${humanBytes(f.bytes)})`)
  lines.push('')
  lines.push(`Written to \`${relative(process.cwd(), root) || '.'}\`.`)
  lines.push('')
  return lines.join('\n')
}
