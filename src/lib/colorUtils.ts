// Color helpers: parsing, contrast, and curated presets.

export interface RGB {
  r: number
  g: number
  b: number
}

const HEX_RE = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/

export function isValidHex(value: string): boolean {
  return HEX_RE.test(value.trim())
}

/** Normalize any accepted hex form to #rrggbb (drops alpha). */
export function normalizeHex(value: string): string | null {
  const v = value.trim()
  if (!HEX_RE.test(v)) return null
  let h = v.replace('#', '')
  if (h.length === 3 || h.length === 4) {
    h = h
      .slice(0, 3)
      .split('')
      .map((c) => c + c)
      .join('')
  } else {
    h = h.slice(0, 6)
  }
  return '#' + h.toLowerCase()
}

export function hexToRgb(hex: string): RGB | null {
  const norm = normalizeHex(hex)
  if (!norm) return null
  const h = norm.slice(1)
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  }
}

export function rgbToHex({ r, g, b }: RGB): string {
  const to = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
  return '#' + to(r) + to(g) + to(b)
}

function channelLuminance(c: number): number {
  const s = c / 255
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}

export function relativeLuminance(hex: string): number {
  const rgb = hexToRgb(hex)
  if (!rgb) return 0
  return 0.2126 * channelLuminance(rgb.r) + 0.7152 * channelLuminance(rgb.g) + 0.0722 * channelLuminance(rgb.b)
}

/** WCAG contrast ratio between two colors (1–21). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const lighter = Math.max(la, lb)
  const darker = Math.min(la, lb)
  return (lighter + 0.05) / (darker + 0.05)
}

/** Pick black or white text for best legibility on a given background. */
export function bestTextColor(bg: string): '#000000' | '#ffffff' {
  return relativeLuminance(bg) > 0.5 ? '#000000' : '#ffffff'
}

export function isDark(hex: string): boolean {
  return relativeLuminance(hex) < 0.4
}

/** Lighten (amount > 0) or darken (amount < 0) a hex color by a 0–1 fraction. */
export function shade(hex: string, amount: number): string {
  const rgb = hexToRgb(hex)
  if (!rgb) return hex
  const t = amount < 0 ? 0 : 255
  const p = Math.abs(amount)
  return rgbToHex({
    r: rgb.r + (t - rgb.r) * p,
    g: rgb.g + (t - rgb.g) * p,
    b: rgb.b + (t - rgb.b) * p,
  })
}

/** Curated swatches shown under color fields. */
export const SWATCHES: string[] = [
  '#ffffff',
  '#f4f5f7',
  '#e6e8ec',
  '#9aa3b2',
  '#4b5462',
  '#14161c',
  '#000000',
  '#5b5bd6',
  '#6366f1',
  '#3b82f6',
  '#0ea5e9',
  '#06b6d4',
  '#10b981',
  '#22c55e',
  '#eab308',
  '#f59e0b',
  '#f97316',
  '#ef4444',
  '#ec4899',
  '#a855f7',
]
