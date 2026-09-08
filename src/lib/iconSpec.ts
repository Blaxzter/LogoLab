// Icon geometry + web-asset spec — the part of the export pipeline that is PURE.
//
// Two renderers draw the same icon: the browser's canvas one (pwaExport.ts) and
// the MCP server's headless SVG/resvg one (src/mcp/render.ts). If each carried
// its own copy of the layout math they would drift, and a maskable icon exported
// by an agent would clip where the one exported from the UI does not. So the math
// — safe zone, contain-fit, corner radius — and the text assets (manifest, <head>
// snippet, .ico container) live HERE, with no DOM, no canvas and no zip, so Node
// can import the module directly. pwaExport.ts re-exports what the UI already used.

import type { ExportTarget, IconShape, RenderIconOptions } from '../types'

/**
 * RenderIconOptions plus the per-target `maskable` flag. Kept out of the shared
 * types: maskable is a property of the *output target*, not of the base
 * appearance the user configures.
 */
export type RenderIconOpts = RenderIconOptions & { maskable?: boolean }

/* ----------------------------------------------------------- default targets */

/**
 * The full catalogue of export targets the UI offers. `enabled` here is the
 * sensible default; the panel lets the user toggle individual entries and apply
 * presets on top of this list.
 */
export const DEFAULT_TARGETS: ExportTarget[] = [
  // Favicon — classic multi-size .ico is assembled from these PNGs.
  { id: 'favicon-16', label: 'Favicon 16', size: 16, fileName: 'favicon-16.png', maskable: false, group: 'favicon', enabled: true },
  { id: 'favicon-32', label: 'Favicon 32', size: 32, fileName: 'favicon-32.png', maskable: false, group: 'favicon', enabled: true },
  { id: 'favicon-48', label: 'Favicon 48', size: 48, fileName: 'favicon-48.png', maskable: false, group: 'favicon', enabled: true },

  // Apple touch icons.
  { id: 'apple-180', label: 'Apple touch 180', size: 180, fileName: 'apple-touch-icon.png', maskable: false, group: 'apple', enabled: true },
  { id: 'apple-167', label: 'Apple touch 167', size: 167, fileName: 'apple-touch-icon-167.png', maskable: false, group: 'apple', enabled: false },
  { id: 'apple-152', label: 'Apple touch 152', size: 152, fileName: 'apple-touch-icon-152.png', maskable: false, group: 'apple', enabled: false },
  { id: 'apple-120', label: 'Apple touch 120', size: 120, fileName: 'apple-touch-icon-120.png', maskable: false, group: 'apple', enabled: false },

  // Android / PWA (purpose "any").
  { id: 'android-192', label: 'Android 192', size: 192, fileName: 'icon-192.png', maskable: false, group: 'android', enabled: true },
  { id: 'android-512', label: 'Android 512', size: 512, fileName: 'icon-512.png', maskable: false, group: 'android', enabled: true },
  { id: 'android-96', label: 'Android 96', size: 96, fileName: 'icon-96.png', maskable: false, group: 'android', enabled: false },
  { id: 'android-144', label: 'Android 144', size: 144, fileName: 'icon-144.png', maskable: false, group: 'android', enabled: false },
  { id: 'android-256', label: 'Android 256', size: 256, fileName: 'icon-256.png', maskable: false, group: 'android', enabled: false },
  { id: 'android-384', label: 'Android 384', size: 384, fileName: 'icon-384.png', maskable: false, group: 'android', enabled: false },

  // Maskable (purpose "maskable") — full-bleed, opaque, extra safe-zone.
  { id: 'maskable-192', label: 'Maskable 192', size: 192, fileName: 'maskable-192.png', maskable: true, group: 'maskable', enabled: true },
  { id: 'maskable-512', label: 'Maskable 512', size: 512, fileName: 'maskable-512.png', maskable: true, group: 'maskable', enabled: true },

  // Windows tiles.
  { id: 'windows-150', label: 'Windows tile 150', size: 150, fileName: 'mstile-150.png', maskable: false, group: 'windows', enabled: false },
  { id: 'windows-310', label: 'Windows tile 310', size: 310, fileName: 'mstile-310.png', maskable: false, group: 'windows', enabled: false },
]

/* ------------------------------------------------------- maskable safe zone */

/**
 * Android's adaptive-icon mask keeps only the centre **72dp of 108dp** — a
 * circle of 66.7% diameter. The web maskable spec talks about an "~80% safe
 * zone", but 66.7% is what actually survives once Chrome installs the PNG as a
 * WebAPK, so that is the number we design to.
 */
export const MASKABLE_SAFE_DIAMETER = 72 / 108

/**
 * Smallest padding that keeps a *square* content box inside that *circle*. The
 * logo is drawn `contain` inside a square inset box, so art that reaches its
 * bounding-box corners sits at the box's half-DIAGONAL, not its half-width:
 *
 *     S·√2 / 2 ≤ R    ⇒    padding = (1 − D·√½) / 2
 *
 * 26.4% at D = 66.7% (and still 21.7% against the spec's 80%, so the old 18%
 * floor was short even against the number it was aiming at).
 */
export const MASKABLE_MIN_PADDING_PCT = ((1 - MASKABLE_SAFE_DIAMETER * Math.SQRT1_2) / 2) * 100

/**
 * The floor actually applied to maskable targets: the geometric minimum rounded
 * up, so the mark clears the mask with a visible margin instead of sitting
 * flush against it.
 */
export const MASKABLE_PADDING_FLOOR_PCT = 28

/* ---------------------------------------------------------------- geometry */

/** Compute the corner radius (px) for a shape at a given canvas size. */
export function radiusForShape(shape: IconShape, size: number, radiusPct: number): number {
  if (shape === 'circle') return size / 2
  if (shape === 'square') return 0
  return (size * radiusPct) / 100
}

/** Where everything lands in one icon — the single answer both renderers draw. */
export interface IconLayout {
  size: number
  /** Resolved background: as requested, or white when a maskable target asked for transparency. */
  background: string
  shape: IconShape
  /** Corner radius in px (size/2 for a circle, 0 for a square). */
  radius: number
  /**
   * Maskable: paint the whole square and do NOT clip to the shape, so the
   * platform's own mask never reveals transparent corners.
   */
  fullBleed: boolean
  /** The logo's destination rect, contain-fitted and safe-zone clamped. Null when nothing fits. */
  content: { x: number; y: number; width: number; height: number } | null
}

/**
 * Resolve one icon's geometry from the appearance options and the logo's
 * intrinsic size. Mirrors <LogoMark>: an (optional) coloured card backplate
 * clipped to the shape, with the logo drawn `contain` inside a safe-zone inset.
 */
export function iconLayout(opts: RenderIconOpts, srcW: number, srcH: number): IconLayout {
  const { size, shape, radiusPct, scale } = opts
  const maskable = opts.maskable === true

  // Maskable icons must be opaque & full-bleed, so when the user chose
  // "transparent" we substitute white.
  let background = opts.background
  if (maskable && background === 'transparent') background = '#ffffff'

  // Safe-zone inset. Maskable needs a larger margin so content stays within
  // Android's centre safe CIRCLE (see MASKABLE_PADDING_FLOOR_PCT).
  const effPaddingPct = maskable ? Math.max(opts.paddingPct, MASKABLE_PADDING_FLOOR_PCT) : opts.paddingPct
  const inset = (size * effPaddingPct) / 100
  const box = Math.max(0, (size - inset * 2) * scale)

  let content: IconLayout['content'] = null
  if (box > 0 && srcW > 0 && srcH > 0) {
    // Contain: preserve aspect ratio inside the box.
    const ar = srcW / srcH
    let cw = box
    let ch = box
    if (ar >= 1) ch = box / ar
    else cw = box * ar
    if (maskable) {
      // The padding floor sets the default, but `scale` (up to 120%) multiplies
      // into the box and can push the corners back out of the mask — so enforce
      // the safe circle on the FITTED rect: its half-diagonal has to fit inside.
      // Fitted, not the square box, so wide/tall art is not over-shrunk.
      const limit = (MASKABLE_SAFE_DIAMETER * size) / 2
      const half = Math.hypot(cw, ch) / 2
      if (half > limit) {
        cw *= limit / half
        ch *= limit / half
      }
    }
    content = { x: (size - cw) / 2, y: (size - ch) / 2, width: cw, height: ch }
  }

  return {
    size,
    background,
    shape,
    radius: radiusForShape(shape, size, radiusPct),
    fullBleed: maskable,
    content,
  }
}

/* ------------------------------------------------------------ manifest/html */

export const THEME_COLOR = '#5b5bd6'
export const BACKGROUND_COLOR = '#ffffff'

interface ManifestIcon {
  src: string
  sizes: string
  type: string
  purpose?: string
}

/**
 * Build a webmanifest JSON string. Includes every enabled android (purpose
 * "any") and maskable (purpose "maskable") icon.
 */
export function buildManifest(brandName: string, targets: ExportTarget[]): string {
  const name = brandName.trim() || 'App'
  const icons: ManifestIcon[] = targets
    .filter((t) => t.enabled && (t.group === 'android' || t.group === 'maskable'))
    .map((t) => ({
      src: `icons/${t.fileName}`,
      sizes: `${t.size}x${t.size}`,
      type: 'image/png',
      purpose: t.maskable ? 'maskable' : 'any',
    }))

  const manifest = {
    name,
    short_name: name.length > 12 ? name.slice(0, 12) : name,
    icons,
    theme_color: THEME_COLOR,
    background_color: BACKGROUND_COLOR,
    display: 'standalone',
    start_url: '/',
    scope: '/',
  }
  return JSON.stringify(manifest, null, 2)
}

/** Build a copy-paste-friendly <head> snippet wiring up the exported assets. */
export function buildHtmlSnippet(targets: ExportTarget[]): string {
  const lines: string[] = []
  lines.push('<!-- Generated by LogoLab — paste inside <head> -->')

  // Classic favicon (.ico) is always emitted alongside the PNG set.
  lines.push('<link rel="icon" href="/favicon.ico" sizes="any">')

  const favicons = targets.filter((t) => t.enabled && t.group === 'favicon')
  for (const t of favicons) {
    lines.push(`<link rel="icon" type="image/png" sizes="${t.size}x${t.size}" href="/icons/${t.fileName}">`)
  }

  const apple = targets.filter((t) => t.enabled && t.group === 'apple')
  for (const t of apple) {
    // The primary 180px icon uses no sizes attribute (the default).
    const sizesAttr = t.size === 180 ? '' : ` sizes="${t.size}x${t.size}"`
    lines.push(`<link rel="apple-touch-icon"${sizesAttr} href="/icons/${t.fileName}">`)
  }

  lines.push('<link rel="manifest" href="/manifest.webmanifest">')
  lines.push(`<meta name="theme-color" content="${THEME_COLOR}">`)

  const windows = targets.filter((t) => t.enabled && t.group === 'windows')
  for (const t of windows) {
    lines.push(`<meta name="msapplication-TileImage" content="/icons/${t.fileName}">`)
  }
  if (windows.length) {
    lines.push(`<meta name="msapplication-TileColor" content="${THEME_COLOR}">`)
  }

  return lines.join('\n')
}

/* --------------------------------------------------------------- favicon.ico */

/**
 * Assemble a real .ico file embedding PNG payloads (PNG-in-ICO is valid per the
 * Windows spec and supported by all modern browsers).
 *
 * Layout: ICONDIR (6 bytes) + n × ICONDIRENTRY (16 bytes) + PNG payloads.
 */
export function encodeIcoBytes(images: { size: number; png: Uint8Array }[]): Uint8Array<ArrayBuffer> {
  const count = images.length
  const headerSize = 6
  const entrySize = 16
  const offsetBase = headerSize + entrySize * count
  const total = offsetBase + images.reduce((n, img) => n + img.png.byteLength, 0)

  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)

  // ICONDIR
  view.setUint16(0, 0, true) // reserved
  view.setUint16(2, 1, true) // type: 1 = icon
  view.setUint16(4, count, true) // image count

  let offset = offsetBase
  images.forEach((img, i) => {
    const entryAt = headerSize + entrySize * i
    // ICONDIRENTRY. 256px is encoded as 0.
    const dim = img.size >= 256 ? 0 : img.size
    view.setUint8(entryAt + 0, dim) // width
    view.setUint8(entryAt + 1, dim) // height
    view.setUint8(entryAt + 2, 0) // palette count
    view.setUint8(entryAt + 3, 0) // reserved
    view.setUint16(entryAt + 4, 1, true) // color planes
    view.setUint16(entryAt + 6, 32, true) // bits per pixel
    view.setUint32(entryAt + 8, img.png.byteLength, true) // bytes in resource
    view.setUint32(entryAt + 12, offset, true) // offset of PNG data
    out.set(img.png, offset)
    offset += img.png.byteLength
  })

  return out
}
