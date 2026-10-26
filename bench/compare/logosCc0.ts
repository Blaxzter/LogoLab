// The logos-cc0 corpus's rules, pure: what is screened out, which stratum a logo is in, and
// which ones the frozen sample takes. bench/compare/fetchLogos.ts applies them to the pinned
// gilbarbara/logos commit and writes manifests/logos-cc0.json; corpus.ts only reads that.
//
// Why these rules and not others:
//   • EXCLUDED is a reason, never a silent drop: an embedded raster (`<image>`), live
//     `<text>` / `<foreignObject>` (the render depends on the fonts installed — not a
//     deterministic answer sheet), an external reference (the picture is not in the file),
//     an SVG resvg cannot render, one that renders blank on white (a white wordmark has no
//     visible answer), and a brand that is in LogoLab's in-sample gallery corpus
//     (examples/logos/manifest.json — the A/B gallery lane traces those marks, so they are
//     not held out even as a different file of the same artwork).
//   • A ground truth svgGround REFUSES (strokes, clips, masks) is KEPT and only flagged —
//     corpus.ts's policy: dropping it would quietly select the corpus by scorability.
//   • Strata are read off the FILE, not a render, so they cannot move with the rasterizer:
//       colours   distinct paints a shape is painted with — solid fill and stroke colours,
//                 each referenced gradient counted as one paint (a gradient-only mark is 1),
//                 clipPath / mask contents not counted (they paint nothing). Bucketed
//                 1 / 2–3 / 4–8 / 9+.
//       gradients any <linearGradient> / <radialGradient> in the file.
//       kind      `-icon` files are symbols (gilbarbara's own naming for the mark alone);
//                 otherwise a rendered aspect w/h ≥ 2 is a wordmark (a lockup is wide),
//                 else a symbol. Crude and documented, which is the point: no peeking.
//   • The sample is deterministic: within each stratum, rank by sha1(filename) (svg-emoji's
//     v0 rule) and take the stratum's allocation — proportional to its size by largest
//     remainder, after a floor of min(size, FLOOR) so a rare stratum (gradient wordmarks) is
//     present at all. Allocation and order use nothing but the file names and the strata.

import { createHash } from 'node:crypto'

export const LOGOS_REPO = 'gilbarbara/logos'
/** Pinned 2026-10-26 (HEAD of main). LICENSE.txt at this commit is CC0 1.0 Universal. */
export const LOGOS_COMMIT = 'd6960edc1b7309d392c76e40d3a320df7f9ff85c'
export const LOGOS_TARBALL = `https://codeload.github.com/${LOGOS_REPO}/tar.gz/${LOGOS_COMMIT}`
export const logoUrl = (file: string, commit = LOGOS_COMMIT): string =>
  `https://github.com/${LOGOS_REPO}/blob/${commit}/logos/${file}`
export const SAMPLE_SIZE = 300
export const FLOOR = 4

export type ColourBucket = '1' | '2-3' | '4-8' | '9+'
export type LogoKind = 'symbol' | 'wordmark'
export interface Strata {
  colours: number
  bucket: ColourBucket
  gradients: boolean
  kind: LogoKind
}

export const sha1 = (s: string): string => createHash('sha1').update(s).digest('hex')

const stripComments = (svg: string): string => svg.replace(/<!--[\s\S]*?-->/g, '')

/** Why the FILE cannot be an answer sheet (render-independent half), else null. */
export function screen(svg: string): string | null {
  const s = stripComments(svg)
  if (/<image\b/i.test(s)) return 'embedded raster (<image>)'
  if (/<(text|tspan|textPath)\b/.test(s)) return 'live text (<text>)'
  if (/<foreignObject\b/.test(s)) return 'foreignObject'
  for (const m of s.matchAll(/(?:xlink:)?href\s*=\s*("([^"]*)"|'([^']*)')/g)) {
    const v = (m[2] ?? m[3] ?? '').trim()
    if (v && !v.startsWith('#')) return `external reference (href="${v.slice(0, 40)}")`
  }
  for (const m of s.matchAll(/url\(\s*['"]?([^'")]*)/g))
    if (!m[1].trim().startsWith('#')) return `external reference (url(${m[1].slice(0, 40)}))`
  if (/@import\b/.test(s)) return 'external reference (@import)'
  return null
}

const NAMED: Record<string, string> = {
  black: '#000000',
  white: '#ffffff',
  red: '#ff0000',
  green: '#008000',
  blue: '#0000ff',
  yellow: '#ffff00',
  orange: '#ffa500',
  purple: '#800080',
  gray: '#808080',
  grey: '#808080',
  silver: '#c0c0c0',
  navy: '#000080',
  teal: '#008080',
  maroon: '#800000',
  lime: '#00ff00',
  aqua: '#00ffff',
  cyan: '#00ffff',
  fuchsia: '#ff00ff',
  magenta: '#ff00ff',
  olive: '#808000',
}

/** A paint value → `#rrggbb`, `url(#id)`, or null for none / transparent. Unknown names stay as written. */
export function normPaint(v: string): string | null {
  const s = v
    .trim()
    .toLowerCase()
    .replace(/\s*!important$/, '')
  if (!s || s === 'none' || s === 'transparent') return null
  const url = /^url\(\s*['"]?#([^'")]+)/.exec(s)
  if (url) return `url(#${url[1]})`
  if (s === 'currentcolor') return '#000000'
  const hex = /^#([0-9a-f]{3,8})$/.exec(s)?.[1]
  if (hex) {
    const full = hex.length <= 4 ? [...hex.slice(0, 3)].map((c) => c + c).join('') : hex.slice(0, 6)
    return `#${full}`
  }
  const rgb = /^rgba?\(([^)]*)\)$/.exec(s)?.[1]
  if (rgb) {
    const ch = rgb
      .split(/[\s,/]+/)
      .filter(Boolean)
      .slice(0, 3)
      .map((c) => (c.endsWith('%') ? (Number.parseFloat(c) * 255) / 100 : Number.parseFloat(c)))
    if (ch.length === 3 && ch.every(Number.isFinite))
      return `#${ch
        .map((c) =>
          Math.round(Math.max(0, Math.min(255, c)))
            .toString(16)
            .padStart(2, '0'),
        )
        .join('')}`
  }
  return NAMED[s] ?? s
}

const decl = (style: string | undefined, name: string): string | undefined =>
  style === undefined ? undefined : new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`).exec(style)?.[1]

const attrsOf = (body: string): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const m of body.matchAll(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) out[m[1]] = m[3] ?? m[4] ?? ''
  return out
}

const SHAPES = new Set(['path', 'rect', 'circle', 'ellipse', 'polygon', 'polyline', 'line'])
const SILENT = new Set(['clipPath', 'mask'])
/** Contents are drawn only where a `<use>` places them, in the `<use>`'s inherited paint. */
const DEFERRED = new Set(['defs', 'symbol'])
/** "Not set inside this <defs>": the paint comes from whichever `<use>` draws it. */
const UNSET = '\0unset'

/**
 * Distinct paints the file's shapes are drawn with (see the header). Inheritance through
 * groups is followed; CSS is read for simple `.class` and `tag` selectors only — anything
 * else in a stylesheet is ignored (gilbarbara's files rarely carry one).
 *
 * `<use>` is followed one level, because Sketch exports (about 50 of the files) draw every
 * shape that way: a `<defs>` path with no fill, placed by `<use fill="#A4D43A">`. Reading the
 * defs path alone counted a black that is never drawn and missed the colour that is. So a
 * shape under `<defs>` / `<symbol>` counts only paint set INSIDE the defs, and a `<use>`
 * counts its own inherited paint wherever its target does not set one itself.
 */
export function paints(svg: string): { solid: string[]; gradients: string[] } {
  const s = stripComments(svg)
  const css = new Map<string, { fill?: string; stroke?: string }>()
  for (const block of s.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)) {
    const text = block[1].replace(/<!\[CDATA\[|\]\]>/g, '')
    for (const rule of text.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const d = rule[2]
      const fill = decl(d, 'fill')
      const stroke = decl(d, 'stroke')
      for (const sel of rule[1].split(',').map((x) => x.trim())) {
        if (!/^\.?[\w-]+$/.test(sel)) continue
        const prev = css.get(sel) ?? {}
        css.set(sel, { fill: fill ?? prev.fill, stroke: stroke ?? prev.stroke })
      }
    }
  }
  const solid = new Set<string>()
  const grads = new Set<string>()
  const count = (v: string): void => {
    if (v === UNSET) return
    const p = normPaint(v)
    if (!p) return
    if (p.startsWith('url(')) grads.add(p)
    else solid.add(p)
  }
  type Paint = 'fill' | 'stroke'
  const tagRe = /<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g
  const tags = [...s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, '').matchAll(tagRe)].map((m) => ({
    close: m[1] === '/',
    tag: m[2],
    a: attrsOf(m[3]),
    selfClose: m[4] === '/',
  }))
  const fromCss = (tag: string, a: Record<string, string>, k: Paint): string | undefined => {
    for (const c of (a.class ?? '').split(/\s+/).filter(Boolean).reverse()) {
      const v = css.get(`.${c}`)?.[k]
      if (v !== undefined) return v
    }
    return css.get(tag)?.[k]
  }
  // CSS precedence: inline style > stylesheet > presentation attribute (> inherited).
  const explicit = (tag: string, a: Record<string, string>, k: Paint): string | undefined => {
    const v = (decl(a.style, k) ?? fromCss(tag, a, k) ?? a[k])?.trim()
    return v === 'inherit' ? undefined : v
  }
  // What a `<use>` target sets itself (then the `<use>`'s paint does not reach it).
  const byId = new Map<string, { fill?: string; stroke?: string }>()
  for (const t of tags)
    if (!t.close && t.a.id)
      byId.set(t.a.id, { fill: explicit(t.tag, t.a, 'fill'), stroke: explicit(t.tag, t.a, 'stroke') })

  // Stack of inherited { fill, stroke, silent }.
  const stack: { tag: string; fill: string; stroke: string; silent: boolean }[] = [
    { tag: '', fill: 'black', stroke: 'none', silent: false },
  ]
  for (const { close, tag, a, selfClose } of tags) {
    if (close) {
      // Pop to the matching open tag (tolerates unbalanced markup).
      const i = stack.map((e) => e.tag).lastIndexOf(tag)
      if (i > 0) stack.length = i
      continue
    }
    const top = stack[stack.length - 1]
    const deferred = DEFERRED.has(tag)
    const own = (k: Paint): string => (deferred ? UNSET : (explicit(tag, a, k) ?? top[k]))
    const fill = own('fill')
    const stroke = own('stroke')
    const silent = top.silent || SILENT.has(tag)
    if (!silent && SHAPES.has(tag)) {
      count(fill)
      count(stroke)
    }
    if (!silent && tag === 'use') {
      const ref = /^#(.+)$/.exec((a.href ?? a['xlink:href'] ?? '').trim())?.[1]
      const target = ref === undefined ? undefined : byId.get(ref)
      if (target?.fill === undefined) count(fill)
      if (target?.stroke === undefined) count(stroke)
    }
    if (!selfClose) stack.push({ tag, fill, stroke, silent })
  }
  return { solid: [...solid].sort(), gradients: [...grads].sort() }
}

export const bucketOf = (n: number): ColourBucket => (n <= 1 ? '1' : n <= 3 ? '2-3' : n <= 8 ? '4-8' : '9+')

export function kindOf(file: string, width: number, height: number): LogoKind {
  if (/-icon\.svg$/.test(file)) return 'symbol'
  return width / Math.max(1, height) >= 2 ? 'wordmark' : 'symbol'
}

export function strataOf(file: string, svg: string, width: number, height: number): Strata {
  const p = paints(svg)
  const colours = Math.max(1, p.solid.length + p.gradients.length)
  return {
    colours,
    bucket: bucketOf(colours),
    gradients: /<(linear|radial)Gradient\b/.test(svg),
    kind: kindOf(file, width, height),
  }
}

export const stratumKey = (s: Strata): string => `${s.bucket}|${s.gradients ? 'gradient' : 'flat'}|${s.kind}`

/** Lowercase alphanumerics: "Coca-Cola" ≡ "coca_cola" ≡ "cocacola". */
export const brandKey = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/** Keys a gallery (examples/logos) entry is known by: its company and its file stem. */
export function galleryKeys(entries: { file: string; company: string }[]): Set<string> {
  const out = new Set<string>()
  for (const e of entries) {
    out.add(brandKey(e.company))
    out.add(brandKey(e.file.replace(/\.svg$/, '').replace(/-(wm|wordmark|icon|logo)$/, '')))
  }
  out.delete('')
  return out
}

/**
 * Per-stratum sample sizes: a floor of min(size, floor) each, the rest proportional to what
 * is left by largest remainder (ties by stratum key), never past a stratum's size.
 */
export function allocate(sizes: Map<string, number>, total: number, floor = FLOOR): Map<string, number> {
  const keys = [...sizes.keys()].sort()
  const n = keys.reduce((a, k) => a + (sizes.get(k) ?? 0), 0)
  const out = new Map<string, number>()
  if (total >= n) {
    for (const k of keys) out.set(k, sizes.get(k) ?? 0)
    return out
  }
  for (const k of keys) out.set(k, Math.min(sizes.get(k) ?? 0, floor))
  let left = total - keys.reduce((a, k) => a + (out.get(k) ?? 0), 0)
  if (left <= 0) return out
  const room = (k: string) => (sizes.get(k) ?? 0) - (out.get(k) ?? 0)
  const roomTotal = keys.reduce((a, k) => a + room(k), 0)
  const quota = keys.map((k) => ({ k, q: (left * room(k)) / roomTotal }))
  for (const { k, q } of quota) {
    const take = Math.min(room(k), Math.floor(q))
    out.set(k, (out.get(k) ?? 0) + take)
    left -= take
  }
  const byRemainder = quota.sort((a, b) => b.q - Math.floor(b.q) - (a.q - Math.floor(a.q)) || (a.k < b.k ? -1 : 1))
  for (const { k } of byRemainder) {
    if (left <= 0) break
    if (room(k) <= 0) continue
    out.set(k, (out.get(k) ?? 0) + 1)
    left--
  }
  return out
}

/** The frozen sample: per stratum, the first `allocation` files by sha1(file). */
export function stratifiedSample(
  rows: { file: string; stratum: string }[],
  total = SAMPLE_SIZE,
  floor = FLOOR,
): { sample: Set<string>; before: Map<string, number>; after: Map<string, number> } {
  const by = new Map<string, string[]>()
  for (const r of rows) by.set(r.stratum, [...(by.get(r.stratum) ?? []), r.file])
  const before = new Map([...by].map(([k, v]) => [k, v.length]))
  const after = allocate(before, total, floor)
  const sample = new Set<string>()
  for (const [k, files] of by) {
    const ranked = files.slice().sort((a, b) => (sha1(a) < sha1(b) ? -1 : sha1(a) > sha1(b) ? 1 : 0))
    for (const f of ranked.slice(0, after.get(k) ?? 0)) sample.add(f)
  }
  return { sample, before, after }
}

/** Fraction of pixels visibly off white (any channel more than 8 below 255). */
export function inkFraction(img: { width: number; height: number; data: Uint8ClampedArray }): number {
  let ink = 0
  const d = img.data
  for (let i = 0; i < d.length; i += 4) if (d[i] < 247 || d[i + 1] < 247 || d[i + 2] < 247) ink++
  return ink / Math.max(1, img.width * img.height)
}

/**
 * The regular files of a POSIX/ustar tarball (GitHub's archive format: a pax global header,
 * pax `x` records for long paths). Enough tar to read one archive without a dependency.
 */
export function untar(buf: Uint8Array): { path: string; data: Uint8Array }[] {
  const out: { path: string; data: Uint8Array }[] = []
  const dec = new TextDecoder()
  const str = (o: number, n: number): string => {
    const s = dec.decode(buf.subarray(o, o + n))
    const z = s.indexOf('\0')
    return z >= 0 ? s.slice(0, z) : s
  }
  let off = 0
  let longName: string | null = null
  while (off + 512 <= buf.length) {
    if (buf.subarray(off, off + 512).every((b) => b === 0)) break
    const name = str(off, 100)
    const size = Number.parseInt(str(off + 124, 12).trim() || '0', 8)
    const type = String.fromCharCode(buf[off + 156] || 48)
    const prefix = str(off + 345, 155)
    const body = buf.subarray(off + 512, off + 512 + size)
    off += 512 + Math.ceil(size / 512) * 512
    if (type === 'x' || type === 'L') {
      if (type === 'L') longName = dec.decode(body).replace(/\0+$/, '')
      else {
        const m = /\d+ path=([^\n]*)\n/.exec(dec.decode(body))
        if (m) longName = m[1]
      }
      continue
    }
    if (type === 'g') continue
    const path = longName ?? (prefix ? `${prefix}/${name}` : name)
    longName = null
    if (type === '0') out.push({ path, data: body })
  }
  return out
}
