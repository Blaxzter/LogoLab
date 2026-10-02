// Editing a live text: its content, the style of a range, and the group that
// carries it in the document. Pure.
//
// Runs are kept NORMALISED — no empty runs (except a lone one for an empty
// text), no two neighbours with the same style — so "is this range all bold?"
// and the undo history both see one representation per drawing.

import type { GroupItem, PathItem, TextData, TextRun, TextStyle, Vec } from '../path/types.ts'
import { layoutText, plainText, resolveStyle, styleAt, type FaceLookup, type TextLayout } from './layout.ts'

export { plainText, styleAt }

export const DEFAULT_TEXT_STYLE: Omit<TextStyle, 'size'> = {
  font: 'inter',
  weight: 400,
  italic: false,
  fill: '#111827',
  tracking: 0,
}

/** A new, empty text with its first baseline starting at `at`. */
export function newTextData(at: Vec, size: number, style: Partial<TextStyle> = {}): TextData {
  return {
    runs: [{ text: '' }],
    style: { ...DEFAULT_TEXT_STYLE, size, ...style },
    align: 'left',
    lineHeight: 1.2,
    kerning: true,
    matrix: [1, 0, 0, 1, at.x, at.y],
  }
}

/* -------------------------------------------------------------- runs */

function sameStyle(a: Partial<TextStyle> | undefined, b: Partial<TextStyle> | undefined): boolean {
  return JSON.stringify(sortKeys(a ?? {})) === JSON.stringify(sortKeys(b ?? {}))
}

function sortKeys(o: object): object {
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(o).sort()) {
    const v = (o as Record<string, unknown>)[k]
    if (v === undefined) continue
    out[k] = v && typeof v === 'object' ? sortKeys(v) : v
  }
  return out
}

/** Drop overrides equal to the base, empty runs, and merge equal neighbours. */
export function normalizeRuns(runs: readonly TextRun[], base: TextStyle): TextRun[] {
  const out: TextRun[] = []
  for (const r of runs) {
    if (r.text.length === 0) continue
    const style: Partial<TextStyle> = {}
    for (const [k, v] of Object.entries(r.style ?? {}) as [keyof TextStyle, unknown][]) {
      if (v === undefined) continue
      if (JSON.stringify(v) === JSON.stringify(base[k])) continue
      ;(style as Record<string, unknown>)[k] = v
    }
    const run: TextRun = Object.keys(style).length > 0 ? { text: r.text, style } : { text: r.text }
    const prev = out[out.length - 1]
    if (prev && sameStyle(prev.style, run.style)) prev.text += run.text
    else out.push(run)
  }
  return out.length > 0 ? out : [{ text: '' }]
}

/** Split runs so offsets `a` and `b` fall on run boundaries. */
function splitAt(runs: readonly TextRun[], cuts: number[]): TextRun[] {
  const out: TextRun[] = []
  let at = 0
  for (const r of runs) {
    let piece = r.text
    let pieceStart = at
    for (const c of cuts) {
      if (c > pieceStart && c < pieceStart + piece.length) {
        out.push({ text: piece.slice(0, c - pieceStart), style: r.style })
        piece = piece.slice(c - pieceStart)
        pieceStart = c
      }
    }
    out.push({ text: piece, style: r.style })
    at += r.text.length
  }
  return out
}

/**
 * Replace `start…end` with `insert`. The inserted text takes `typing` when given
 * (a style picked with nothing selected), else the style of the character
 * before the caret — what every editor does when you keep typing.
 */
export function replaceText(
  data: TextData,
  start: number,
  end: number,
  insert: string,
  typing?: Partial<TextStyle>,
): TextData {
  const text = plainText(data)
  const a = Math.max(0, Math.min(start, text.length))
  const b = Math.max(a, Math.min(end, text.length))
  const inherit = typing ?? runStyleAt(data.runs, a > 0 ? a - 1 : a)
  const parts = splitAt(data.runs, [a, b])
  const out: TextRun[] = []
  let at = 0
  let placed = false
  for (const r of parts) {
    const rs = at
    const re = at + r.text.length
    at = re
    if (!placed && rs >= a) {
      if (insert) out.push({ text: insert, style: inherit })
      placed = true
    }
    if (rs >= a && re <= b && re > rs) continue // the replaced span
    out.push(r)
  }
  if (!placed && insert) out.push({ text: insert, style: inherit })
  return { ...data, runs: normalizeRuns(out, data.style) }
}

function runStyleAt(runs: readonly TextRun[], i: number): Partial<TextStyle> | undefined {
  let at = 0
  for (const r of runs) {
    if (i >= at && i < at + r.text.length) return r.style
    at += r.text.length
  }
  return runs[runs.length - 1]?.style
}

/**
 * Apply a style patch to `start…end`. The whole text (or no range at all)
 * changes the BASE and clears that property's overrides, so styling a whole
 * text never leaves it as one big override run.
 */
export function styleRange(data: TextData, start: number, end: number, patch: Partial<TextStyle>): TextData {
  const len = plainText(data).length
  const whole = start <= 0 && end >= len
  if (whole || start === end) {
    const keys = Object.keys(patch) as (keyof TextStyle)[]
    const runs = data.runs.map((r) => {
      if (!r.style) return r
      const s = { ...r.style }
      for (const k of keys) delete s[k]
      return { text: r.text, style: s }
    })
    const style = mergeStyle(data.style, patch) as TextStyle
    return { ...data, style, runs: normalizeRuns(runs, style) }
  }
  const parts = splitAt(data.runs, [start, end])
  let at = 0
  const out = parts.map((r) => {
    const rs = at
    at += r.text.length
    if (rs >= start && at <= end) return { text: r.text, style: mergeStyle(r.style, patch) }
    return r
  })
  return { ...data, runs: normalizeRuns(out, data.style) }
}

function mergeStyle(a: Partial<TextStyle> | undefined, patch: Partial<TextStyle>): Partial<TextStyle> {
  const out: Partial<TextStyle> = { ...a, ...patch }
  // Feature and axis maps merge key by key: turning on small caps must not
  // turn off the stylistic set picked a moment ago.
  if (patch.features) out.features = { ...a?.features, ...patch.features }
  if (patch.variations) out.variations = { ...a?.variations, ...patch.variations }
  return out
}

/**
 * What `start…end` shows for each property: the value when every character
 * agrees, `undefined` (mixed) when they don't. An empty range reports the
 * style at the caret.
 */
export function rangeStyle(data: TextData, start: number, end: number): Partial<TextStyle> {
  if (start >= end) return styleAt(data, Math.max(0, start - 1))
  const out: Partial<TextStyle> = {}
  const seen = new Map<string, string>()
  const mixed = new Set<string>()
  for (let i = start; i < end; i++) {
    const s = styleAt(data, i)
    for (const [k, v] of Object.entries(s)) {
      const j = JSON.stringify(v)
      if (!seen.has(k)) {
        seen.set(k, j)
        ;(out as Record<string, unknown>)[k] = v
      } else if (seen.get(k) !== j) mixed.add(k)
    }
  }
  for (const k of mixed) delete (out as Record<string, unknown>)[k]
  return out
}

/** Every font/italic pair a text uses — what must be loaded to lay it out. */
export function facesUsed(data: TextData): { font: string; italic: boolean }[] {
  const list = [data.style, ...data.runs.map((r) => resolveStyle(data.style, r.style))]
  return list.map((s) => ({ font: s.font, italic: s.italic }))
}

/* ------------------------------------------------------------ the group */

/**
 * Re-lay a text group out. The paint the text model doesn't own — a gradient,
 * a stroke, a fill opacity set on the shape — is carried from the old outlines
 * onto the new ones, so editing the words doesn't strip the styling.
 */
export function layoutGroup(group: GroupItem, lookup: FaceLookup): { group: GroupItem; layout: TextLayout } {
  const data = group.text!
  const layout = layoutText(data, lookup, (i) => `${group.id}~${i}`)
  const was = group.children.find((c): c is PathItem => c.kind === 'path')
  const children = layout.children.map((c) => {
    const next: PathItem = { ...c }
    if (was?.gradient) next.gradient = was.gradient
    if (was?.stroke) next.stroke = was.stroke
    if (was?.fillOpacity !== undefined) next.fillOpacity = was.fillOpacity
    return next
  })
  return { group: { ...group, children, expanded: false }, layout }
}

/** A text group for `data`, laid out. */
export function makeTextGroup(id: string, data: TextData, lookup: FaceLookup): GroupItem {
  return layoutGroup({ kind: 'group', id, children: [], visible: true, text: data }, lookup).group
}

/** The layers list's label for a text: its first line, trimmed. */
export function textLabel(data: TextData): string {
  const first = plainText(data).split('\n')[0].trim()
  return first.length > 32 ? `${first.slice(0, 31)}…` : first || 'Empty text'
}
