// Walk a set of presets, render every icon in them, and write the collection to
// disk — the half of the pipeline that turns one logo into a folder an agent can
// drop into a project.
//
// Rendering is per size, not per file: each distinct (size, maskable, shape,
// background) combination is rendered once and reused, since e.g. a Tauri export
// needs 32px for several files and containers.

import { existsSync, writeFileSync } from 'node:fs'
import { join, posix, relative } from 'node:path'
import { encodeIcoBytes, type RenderIconOpts, type WebAppColors } from '../lib/export/iconSpec.ts'
import type { IconShape } from '../types'
import { encodeIcns } from './icns.ts'
import { customPreset, mergeWebPresets, presetById, type IconFileSpec, type Preset } from './presets.ts'
import { pickOpaqueBackground, seeThroughAreas, seeThroughNote, type OpaquePick } from './logoProbe.ts'
import { renderIconPixels, renderIconPng, type PreparedLogo } from './render.ts'
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
  /**
   * The files a platform will not take transparent: apple-touch, maskable, iOS,
   * the Play icon, the adaptive foreground. Each key falls back to the plain
   * appearance; a transparent `background` falls back to a colour picked from
   * the logo (and reported), never to transparency.
   */
  opaque?: OpaqueAppearance
}

export interface OpaqueAppearance {
  background?: string
  paddingPct?: number
}

/**
 * Full-bleed passthrough: by default an image model's icon is used as is, not
 * re-cropped, re-carded or re-padded. Ask for a background + padding to get the
 * studio's card look instead.
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
  /** Manifest / <head> snippet colours and start URL. The colours default to the opaque fill. */
  web?: WebAppColors
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
  /** What the opaque files were filled with, and where that colour came from. */
  opaqueBackground: OpaquePick
  /** The colours written into the manifest and <head> snippet (web presets only). */
  web?: ResolvedWebColors
  /** Things about the logo the caller should know (see-through holes …). */
  warnings: string[]
}

type ResolvedWebColors = Required<WebAppColors>

const isOpaque = (spec: IconFileSpec): boolean => spec.opaque === true || spec.maskable === true

/** The background and padding one file is drawn with. */
function cardFor(spec: IconFileSpec, app: Appearance, opaque: OpaquePick): { background: string; paddingPct: number } {
  if (!isOpaque(spec)) return { background: app.background, paddingPct: app.paddingPct }
  return { background: opaque.color, paddingPct: app.opaque?.paddingPct ?? app.paddingPct }
}

/** Cache key for one rendered PNG. */
function iconKey(spec: IconFileSpec, app: Appearance, opaque: OpaquePick): string {
  const card = cardFor(spec, app, opaque)
  return [spec.size, spec.maskable ? 'm' : '', spec.shape ?? app.shape, card.background, card.paddingPct].join('|')
}

function optsFor(spec: IconFileSpec, app: Appearance, opaque: OpaquePick): RenderIconOpts {
  return {
    size: spec.size,
    ...cardFor(spec, app, opaque),
    shape: spec.shape ?? app.shape,
    radiusPct: app.radiusPct,
    scale: app.scale,
    tintColor: app.tintColor ?? null,
    invert: app.invert === true,
    maskable: spec.maskable === true,
  }
}

type Probe = ReturnType<typeof renderIconPixels>

/** The logo alone, transparent and unpadded, with the tint/invert the icons get. */
function probeLogo(logo: PreparedLogo, app: Appearance): Probe {
  return renderIconPixels(logo, {
    size: 256,
    background: 'transparent',
    shape: 'square',
    radiusPct: 0,
    paddingPct: 0,
    scale: 1,
    tintColor: app.tintColor ?? null,
    invert: app.invert === true,
  })
}

/**
 * The opaque files' fill: `opaque.background`, else a non-transparent `background`,
 * else a colour read off the logo. Never transparency, never a silent white.
 */
export function resolveOpaque(app: Appearance, probe: () => Probe): OpaquePick {
  const chosen = app.opaque?.background
  if (chosen && chosen !== 'transparent') return { color: chosen, source: 'chosen' }
  if (app.background !== 'transparent') return { color: app.background, source: 'background' }
  return pickOpaqueBackground(probe())
}

/** One line on the opaque fill; the tool summary and the notes say the same thing. */
export function opaqueLine(pick: OpaquePick): string {
  const why = {
    chosen: 'as asked',
    background: 'the card background',
    logo: "the logo's own background",
    contrast: 'picked for contrast with the logo; pass appearance.opaque.background for a brand colour',
  }[pick.source]
  return `Opaque icons (apple-touch, maskable, iOS, adaptive) filled ${pick.color} (${why}).`
}

/**
 * The notes written at the export root. Not README.md: the presets lay files out
 * from a PROJECT root (public/, src-tauri/icons/, …), so that is the outDir an
 * agent passes, and a README.md there is the project's own.
 */
export const NOTES_FILE = 'logolab-icons.md'

/**
 * Resolve the requested preset ids (plus a custom-size preset when asked). Web
 * presets asked for together become one, since they share a manifest and snippet.
 */
export function resolvePresets(req: ExportRequest): Preset[] {
  const ids = req.presets?.length ? req.presets : ['pwa']
  const out: Preset[] = []
  for (const id of ids) {
    const preset = presetById(id)
    if (!preset)
      throw new Error(
        `Unknown preset "${id}". Available: ${['pwa', 'favicon', 'web', 'tauri', 'electron', 'android', 'ios', 'extension'].join(', ')}`,
      )
    out.push(preset)
  }
  if (req.sizes?.length) out.push(customPreset(req.sizes))
  return mergeWebPresets(out)
}

/** Render and write one collection. Returns what landed on disk. */
export function exportCollection(logo: PreparedLogo, outDir: string, req: ExportRequest = {}): ExportReport {
  const presets = resolvePresets(req)
  const app: Appearance = { ...DEFAULT_APPEARANCE, ...req.appearance }
  const appName = req.appName?.trim() || 'App'
  const root = ensureDir(outDir)

  const probe = probeLogo(logo, app)
  const opaque = resolveOpaque(app, () => probe)
  const warnings: string[] = []
  const holes = seeThroughNote(seeThroughAreas(probe))
  if (holes) warnings.push(holes)

  const webColors: ResolvedWebColors = {
    themeColor: req.web?.themeColor ?? req.web?.backgroundColor ?? opaque.color,
    backgroundColor: req.web?.backgroundColor ?? opaque.color,
    startUrl: req.web?.startUrl ?? '/',
  }

  const rendered = new Map<string, Uint8Array>()
  const png = (spec: IconFileSpec): Uint8Array => {
    const key = iconKey(spec, app, opaque)
    const hit = rendered.get(key)
    if (hit) return hit
    const bytes = renderIconPng(logo, optsFor(spec, app, opaque))
    rendered.set(key, bytes)
    return bytes
  }

  const files: WrittenFile[] = []
  // Presets can share a path: a path written twice is reported once, with the
  // bytes of the last write, and is `replaced` only when it was on disk BEFORE
  // this export — never because of our own earlier write.
  const byPath = new Map<string, WrittenFile>()
  const write = (relPath: string, bytes: Uint8Array | string): void => {
    const path = posix.join(...relPath.split(/[\\/]/))
    const full = ensureParent(join(root, relPath))
    const earlier = byPath.get(path)
    const replaced = earlier ? earlier.replaced : existsSync(full)
    writeFileSync(full, bytes)
    const size = typeof bytes === 'string' ? Buffer.byteLength(bytes) : bytes.byteLength
    if (earlier) {
      earlier.bytes = size
      return
    }
    const entry: WrittenFile = { path, bytes: size, replaced }
    byPath.set(path, entry)
    files.push(entry)
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

    for (const text of preset.text?.({ appName, opaqueBackground: opaque.color, colors: webColors }) ?? []) {
      write(text.path, text.content)
    }

    if (req.svg && preset.svgPath) write(preset.svgPath, req.svg)
  }

  const web = presets.some((p) => p.web) ? webColors : undefined
  write(NOTES_FILE, readme(appName, presets, app, opaque, web, warnings, files, root))

  const totalBytes = files.reduce((n, f) => n + f.bytes, 0)
  return {
    outDir: root,
    presets: presets.map((p) => p.id),
    files,
    totalBytes,
    summary: `${files.length} files (${humanBytes(totalBytes)}) in ${root}`,
    opaqueBackground: opaque,
    ...(web ? { web } : {}),
    warnings,
  }
}

function readme(
  appName: string,
  presets: Preset[],
  app: Appearance,
  opaque: OpaquePick,
  web: ResolvedWebColors | undefined,
  warnings: string[],
  files: WrittenFile[],
  root: string,
): string {
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
  lines.push(
    `- card: ${app.background === 'transparent' ? 'transparent (the source art, full bleed)' : `${app.background}, ${app.shape}${app.shape === 'rounded' ? ` @ ${app.radiusPct}% radius` : ''}`}`,
  )
  lines.push(`- safe-zone padding ${app.paddingPct}%, logo scale ${app.scale}`)
  if (app.tintColor) lines.push(`- tinted ${app.tintColor}`)
  lines.push(`- ${opaqueLine(opaque)}`)
  if (app.opaque?.paddingPct !== undefined) lines.push(`- opaque icons padded ${app.opaque.paddingPct}%`)
  if (web) {
    lines.push(
      `- manifest: theme_color ${web.themeColor}, background_color ${web.backgroundColor}, start_url ${web.startUrl}`,
    )
  }
  for (const w of warnings) lines.push(`- note: ${w}`)
  lines.push('')
  lines.push('Maskable / adaptive icons raise that padding to their own floor:')
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
