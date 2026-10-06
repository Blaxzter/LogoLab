// CSS colour → RGBA, for paint read out of imported SVG. The document model and
// every pure renderer (rasterizeDoc, the PDF/DXF writers) speak `#rrggbb`, so a
// fill written `red`, `rgb(37 99 235)`, `hsl(…)` or `#rrggbbaa` has to be reduced
// at import — read as hex it was black, and `transparent` an opaque black box.

export interface Rgba {
  r: number
  g: number
  b: number
  /** 0–1. */
  a: number
}

/** The CSS named colours (CSS Color 4), `transparent` included. */
const NAMED: Record<string, string> = {
  aliceblue: 'f0f8ff',
  antiquewhite: 'faebd7',
  aqua: '00ffff',
  aquamarine: '7fffd4',
  azure: 'f0ffff',
  beige: 'f5f5dc',
  bisque: 'ffe4c4',
  black: '000000',
  blanchedalmond: 'ffebcd',
  blue: '0000ff',
  blueviolet: '8a2be2',
  brown: 'a52a2a',
  burlywood: 'deb887',
  cadetblue: '5f9ea0',
  chartreuse: '7fff00',
  chocolate: 'd2691e',
  coral: 'ff7f50',
  cornflowerblue: '6495ed',
  cornsilk: 'fff8dc',
  crimson: 'dc143c',
  cyan: '00ffff',
  darkblue: '00008b',
  darkcyan: '008b8b',
  darkgoldenrod: 'b8860b',
  darkgray: 'a9a9a9',
  darkgreen: '006400',
  darkgrey: 'a9a9a9',
  darkkhaki: 'bdb76b',
  darkmagenta: '8b008b',
  darkolivegreen: '556b2f',
  darkorange: 'ff8c00',
  darkorchid: '9932cc',
  darkred: '8b0000',
  darksalmon: 'e9967a',
  darkseagreen: '8fbc8f',
  darkslateblue: '483d8b',
  darkslategray: '2f4f4f',
  darkslategrey: '2f4f4f',
  darkturquoise: '00ced1',
  darkviolet: '9400d3',
  deeppink: 'ff1493',
  deepskyblue: '00bfff',
  dimgray: '696969',
  dimgrey: '696969',
  dodgerblue: '1e90ff',
  firebrick: 'b22222',
  floralwhite: 'fffaf0',
  forestgreen: '228b22',
  fuchsia: 'ff00ff',
  gainsboro: 'dcdcdc',
  ghostwhite: 'f8f8ff',
  gold: 'ffd700',
  goldenrod: 'daa520',
  gray: '808080',
  green: '008000',
  greenyellow: 'adff2f',
  grey: '808080',
  honeydew: 'f0fff0',
  hotpink: 'ff69b4',
  indianred: 'cd5c5c',
  indigo: '4b0082',
  ivory: 'fffff0',
  khaki: 'f0e68c',
  lavender: 'e6e6fa',
  lavenderblush: 'fff0f5',
  lawngreen: '7cfc00',
  lemonchiffon: 'fffacd',
  lightblue: 'add8e6',
  lightcoral: 'f08080',
  lightcyan: 'e0ffff',
  lightgoldenrodyellow: 'fafad2',
  lightgray: 'd3d3d3',
  lightgreen: '90ee90',
  lightgrey: 'd3d3d3',
  lightpink: 'ffb6c1',
  lightsalmon: 'ffa07a',
  lightseagreen: '20b2aa',
  lightskyblue: '87cefa',
  lightslategray: '778899',
  lightslategrey: '778899',
  lightsteelblue: 'b0c4de',
  lightyellow: 'ffffe0',
  lime: '00ff00',
  limegreen: '32cd32',
  linen: 'faf0e6',
  magenta: 'ff00ff',
  maroon: '800000',
  mediumaquamarine: '66cdaa',
  mediumblue: '0000cd',
  mediumorchid: 'ba55d3',
  mediumpurple: '9370db',
  mediumseagreen: '3cb371',
  mediumslateblue: '7b68ee',
  mediumspringgreen: '00fa9a',
  mediumturquoise: '48d1cc',
  mediumvioletred: 'c71585',
  midnightblue: '191970',
  mintcream: 'f5fffa',
  mistyrose: 'ffe4e1',
  moccasin: 'ffe4b5',
  navajowhite: 'ffdead',
  navy: '000080',
  oldlace: 'fdf5e6',
  olive: '808000',
  olivedrab: '6b8e23',
  orange: 'ffa500',
  orangered: 'ff4500',
  orchid: 'da70d6',
  palegoldenrod: 'eee8aa',
  palegreen: '98fb98',
  paleturquoise: 'afeeee',
  palevioletred: 'db7093',
  papayawhip: 'ffefd5',
  peachpuff: 'ffdab9',
  peru: 'cd853f',
  pink: 'ffc0cb',
  plum: 'dda0dd',
  powderblue: 'b0e0e6',
  purple: '800080',
  rebeccapurple: '663399',
  red: 'ff0000',
  rosybrown: 'bc8f8f',
  royalblue: '4169e1',
  saddlebrown: '8b4513',
  salmon: 'fa8072',
  sandybrown: 'f4a460',
  seagreen: '2e8b57',
  seashell: 'fff5ee',
  sienna: 'a0522d',
  silver: 'c0c0c0',
  skyblue: '87ceeb',
  slateblue: '6a5acd',
  slategray: '708090',
  slategrey: '708090',
  snow: 'fffafa',
  springgreen: '00ff7f',
  steelblue: '4682b4',
  tan: 'd2b48c',
  teal: '008080',
  thistle: 'd8bfd8',
  tomato: 'ff6347',
  turquoise: '40e0d0',
  violet: 'ee82ee',
  wheat: 'f5deb3',
  white: 'ffffff',
  whitesmoke: 'f5f5f5',
  yellow: 'ffff00',
  yellowgreen: '9acd32',
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

/** One rgb() channel: `0–255` or a percentage. */
function rgbChannel(s: string): number | null {
  const n = parseFloat(s)
  if (!Number.isFinite(n)) return null
  return clamp(s.endsWith('%') ? n * 2.55 : n, 0, 255)
}

/** An alpha component: `0–1` or a percentage. */
function alphaChannel(s: string | undefined): number | null {
  if (s === undefined) return 1
  const n = parseFloat(s)
  if (!Number.isFinite(n)) return null
  return clamp(s.endsWith('%') ? n / 100 : n, 0, 1)
}

/** A hue in degrees (`deg`, `turn`, `rad`, `grad` or bare). */
function hueDegrees(s: string): number | null {
  const n = parseFloat(s)
  if (!Number.isFinite(n)) return null
  const t = s.toLowerCase()
  if (t.endsWith('turn')) return n * 360
  if (t.endsWith('grad')) return n * 0.9
  if (t.endsWith('rad')) return (n * 180) / Math.PI
  return n
}

/**
 * Parse a CSS colour to straight RGBA (rgb 0–255, unrounded; a 0–1). Null for
 * anything this can't resolve on its own — `currentColor`, `var()`, `inherit`,
 * a paint server, garbage — so a caller can keep such paint raw instead of
 * guessing a colour.
 */
export function parseCssColor(input: string): Rgba | null {
  const t = input.trim().toLowerCase()
  if (t === '') return null
  if (t[0] === '#') {
    const h = t.slice(1)
    if (!/^[0-9a-f]+$/.test(h)) return null
    if (h.length === 3 || h.length === 4) {
      const v = [...h].map((c) => parseInt(c + c, 16))
      return { r: v[0], g: v[1], b: v[2], a: h.length === 4 ? v[3] / 255 : 1 }
    }
    if (h.length === 6 || h.length === 8) {
      const v = [0, 2, 4, 6].map((i) => parseInt(h.slice(i, i + 2), 16))
      return { r: v[0], g: v[1], b: v[2], a: h.length === 8 ? v[3] / 255 : 1 }
    }
    return null
  }
  if (t === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }
  const named = NAMED[t]
  if (named) return parseCssColor('#' + named)

  const fn = /^(rgba?|hsla?)\(\s*([^)]*)\)$/.exec(t)
  if (!fn) return null
  // Both the legacy comma list and the space list with a `/ alpha` tail.
  const body = fn[2].replace(/\s*\/\s*/, ' / ')
  const [main, alphaPart] = body.split(' / ')
  const parts = main.split(/\s*,\s*|\s+/).filter(Boolean)
  // Three channels, then the alpha either as a fourth list item or after `/`.
  if (alphaPart !== undefined ? parts.length !== 3 : parts.length !== 3 && parts.length !== 4) return null
  const a = alphaChannel(alphaPart !== undefined ? alphaPart.trim() : parts[3])
  if (a === null) return null
  if (fn[1].startsWith('rgb')) {
    const r = rgbChannel(parts[0])
    const g = rgbChannel(parts[1])
    const b = rgbChannel(parts[2])
    if (r === null || g === null || b === null) return null
    return { r, g, b, a }
  }
  const hue = hueDegrees(parts[0])
  const sat = parseFloat(parts[1])
  const lig = parseFloat(parts[2])
  if (hue === null || !Number.isFinite(sat) || !Number.isFinite(lig)) return null
  const s = clamp(sat, 0, 100) / 100
  const l = clamp(lig, 0, 100) / 100
  const h = ((hue % 360) + 360) % 360
  const k = (n: number) => (n + h / 30) % 12
  const f = (n: number) => l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))
  return { r: f(0) * 255, g: f(8) * 255, b: f(4) * 255, a }
}

/** `#rrggbb` (lower case) for RGB channels in 0–255. */
export function rgbaToHex({ r, g, b }: Rgba): string {
  const to = (n: number) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0')
  return '#' + to(r) + to(g) + to(b)
}
