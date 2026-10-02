// A live text written as an SVG `<text>` element, for the export that keeps
// text editable in other tools ("Text as: live text").
//
// The outlines are what the editor shows; this is the same text handed to a
// renderer that will shape it again with whatever font it finds, so it can
// only be as faithful as the viewer's fonts. Bundled families get a Google
// Fonts @import (they are Google Fonts), which a browser opening the file
// honours; anything else names the family and falls back to a generic.
// A gradient is not carried: it lives in document space, the text in its own.

import type { GroupItem, PathItem, TextData, TextStyle } from '../path/types.ts'
import { subPathsToD } from '../path/model.ts'
import { reverseSubPath } from '../editor/pathOps.ts'
import { plainText, resolveStyle } from './layout.ts'
import { fontEntry, type FontEntry } from './fonts.ts'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const GENERIC: Record<FontEntry['category'], string> = {
  sans: 'sans-serif',
  serif: 'serif',
  display: 'sans-serif',
  script: 'cursive',
  mono: 'monospace',
  yours: 'sans-serif',
}

function family(id: string): string {
  const e = fontEntry(id)
  return e ? `'${e.family.replace(/'/g, '')}', ${GENERIC[e.category]}` : 'sans-serif'
}

/** CSS-ish attributes for a style, only where it differs from `base` (null = all). */
function styleAttrs(s: TextStyle, base: TextStyle | null, fmt: (v: number) => string): string {
  const diff = <K extends keyof TextStyle>(k: K) => !base || JSON.stringify(s[k]) !== JSON.stringify(base[k])
  let out = ''
  if (diff('font')) out += ` font-family="${esc(family(s.font))}"`
  if (diff('size')) out += ` font-size="${fmt(s.size)}"`
  if (diff('weight')) out += ` font-weight="${Math.round(s.weight)}"`
  if (diff('italic')) out += ` font-style="${s.italic ? 'italic' : 'normal'}"`
  if (diff('fill')) out += ` fill="${esc(s.fill)}"`
  if (diff('tracking')) out += ` letter-spacing="${fmt((s.tracking / 1000) * s.size)}"`
  if (diff('baselineShift') && s.baselineShift) out += ` baseline-shift="${fmt(-s.baselineShift)}"`
  const css: string[] = []
  if (diff('features') && s.features && Object.keys(s.features).length > 0) {
    css.push(
      `font-feature-settings:${Object.entries(s.features)
        .map(([k, v]) => `'${k}' ${v}`)
        .join(',')}`,
    )
  }
  if (diff('variations') && s.variations && Object.keys(s.variations).length > 0) {
    css.push(
      `font-variation-settings:${Object.entries(s.variations)
        .map(([k, v]) => `'${k}' ${v}`)
        .join(',')}`,
    )
  }
  if (css.length) out += ` style="${esc(css.join(';'))}"`
  return out
}

/** The text's characters as tspans, one per style run, split into lines. */
function lines(data: TextData): { text: string; style: TextStyle }[][] {
  const out: { text: string; style: TextStyle }[][] = [[]]
  for (const r of data.runs) {
    const style = resolveStyle(data.style, r.style)
    r.text.split('\n').forEach((piece, i) => {
      if (i > 0) out.push([])
      if (piece) out[out.length - 1].push({ text: piece, style })
    })
  }
  return out
}

export function textToSvg(group: GroupItem, fmt: (v: number) => string): { markup: string; defs?: string[] } | null {
  const data = group.text
  if (!data || plainText(data).length === 0) return null
  const paint = group.children.find((c): c is PathItem => c.kind === 'path')
  const m = data.matrix.map((v) => String(Number(v.toFixed(6)))).join(' ')
  const anchor = data.align === 'center' ? 'middle' : data.align === 'right' ? 'end' : 'start'

  let attrs = ` transform="matrix(${m})" text-anchor="${anchor}" xml:space="preserve"`
  attrs += styleAttrs(data.style, null, fmt)
  if (!data.kerning) attrs += ' font-kerning="none"'
  if (paint?.fillOpacity !== undefined && paint.fillOpacity < 1) attrs += ` fill-opacity="${paint.fillOpacity}"`
  const s = paint?.stroke
  if (s && s.width > 0) attrs += ` stroke="${esc(s.color)}" stroke-width="${fmt(s.width)}" stroke-linejoin="${s.join}"`
  if (group.name) attrs += ` data-name="${esc(group.name)}"`

  const spans = (line: { text: string; style: TextStyle }[]) =>
    line.map((p) => {
      const a = styleAttrs(p.style, data.style, fmt)
      return a ? `<tspan${a}>${esc(p.text)}</tspan>` : esc(p.text)
    })

  let defs = ''
  let inner: string
  if (data.onPath) {
    const id = `tp-${group.id.replace(/[^A-Za-z0-9_-]/g, '')}`
    const path = data.onPath.flip ? reverseSubPath(data.onPath.path) : data.onPath.path
    defs = `<path id="${id}" d="${subPathsToD([path])}"/>`
    // A path can't break lines: everything goes on the one baseline.
    const all = lines(data).flatMap((l) => spans(l))
    inner = `<textPath href="#${id}" startOffset="${fmt(data.onPath.start * 100)}%">${all.join('')}</textPath>`
  } else {
    let y = 0
    inner = lines(data)
      .map((line, i) => {
        if (i > 0) {
          const prev = Math.max(...lines(data)[i - 1].map((p) => p.style.size), data.style.size)
          y += data.lineHeight * prev
        }
        return `<tspan x="0" y="${fmt(y)}">${spans(line).join('')}</tspan>`
      })
      .join('')
  }

  // One @import per family, deduplicated across texts by serializeDoc.
  const imports = fontsUsed(data).map(
    (css2) => `<style>@import url('https://fonts.googleapis.com/css2?family=${css2}&amp;display=swap');</style>`,
  )
  return { markup: `<text${attrs}>${inner}</text>`, defs: defs ? [defs, ...imports] : imports }
}

/** The bundled families a text uses, as Google Fonts css2 specs. */
function fontsUsed(data: TextData): string[] {
  const out = new Set<string>()
  for (const st of [data.style, ...data.runs.map((r) => resolveStyle(data.style, r.style))]) {
    const e = fontEntry(st.font)
    if (e?.css2) out.add(e.css2)
  }
  return [...out]
}
