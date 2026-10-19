// "Select same fill / stroke / appearance": which shapes paint like the selection does. Pure.
//
// The model to match is the selection's LEAD — the first selected path, walking
// into groups, which is the path the Inspector's swatches show. Matching what the
// swatch shows is the point: you look at a colour, ask for "everything this
// colour", and get it.
//
// What a match selects. The canvas selects a group whole at the top level, but
// "same fill" is asked so you can then recolour exactly those shapes, and a whole
// group would carry along every sibling that does NOT match. So it selects the
// matching LEAVES, the way the layers list selects a row inside a folder. A live
// text is the exception: its paths are a cache of its layout, rebuilt on every
// keystroke, so a match on one selects the text — when ANY of its paint runs
// matches, since one text can be several colours. Inside an entered group the
// search stays in that group, as every other selection there does — as long
// as the lead is in it: a shape picked outside the group is asked about where
// it is, and the answer must include it.
//
// Hidden items (or items in a hidden group) are never selected: a selection you
// cannot see is one you edit by accident. The model has no lock yet; when it
// gets one, a locked item belongs with the hidden ones here.

import type { DocItem, EditableDoc, GradientFill, PathItem } from '../path/types.ts'
import { allPaths, findItem, isGroup } from '../path/docTree.ts'
import { normalizeHex } from '../colorUtils.ts'

/** Which part of the look has to match. */
export type SameWhat = 'fill' | 'stroke' | 'fillStroke' | 'appearance'

/** The path whose paint the selection shows: the first selected path, walking into groups. */
export function leadPath(doc: EditableDoc, selection: ReadonlySet<string>): PathItem | null {
  for (const id of selection) {
    const item = findItem(doc.items, id)
    if (!item) continue
    if (isGroup(item)) {
      const first = allPaths(item.children)[0]
      if (first) return first
    } else if (item.kind === 'path') return item
  }
  return null
}

/** A colour as one comparable string: `#ABC`, `#aabbcc` and ` #AABBCC ` are the same colour. */
export function colorKey(c: string): string {
  const t = c.trim().toLowerCase()
  if (t === 'none') return 'none'
  return normalizeHex(t) ?? t
}

/**
 * Two gradients are the same PAINT when their kind and stops agree. Where they
 * sit is not compared: a gradient is placed in absolute coordinates, so every
 * copy of a shape carries a differently placed copy of the same gradient, and
 * "same fill" would otherwise only ever find the shape you started from.
 */
export function sameGradient(a: GradientFill, b: GradientFill): boolean {
  if (a.type !== b.type || a.stops.length !== b.stops.length) return false
  return a.stops.every((s, i) => {
    const t = b.stops[i]
    return near(s.offset, t.offset) && colorKey(s.color) === colorKey(t.color) && near(s.opacity ?? 1, t.opacity ?? 1)
  })
}

function near(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-4
}

/** Same fill paint: a solid matches a solid of the same colour, a gradient an equal gradient, none none. */
export function sameFill(a: PathItem, b: PathItem): boolean {
  if (a.gradient || b.gradient) return !!a.gradient && !!b.gradient && sameGradient(a.gradient, b.gradient)
  return colorKey(a.fill) === colorKey(b.fill)
}

/** A stroke that paints nothing (none, zero width) is the same as no stroke. */
function strokeColor(p: PathItem): string {
  const s = p.stroke
  if (!s || s.width <= 0) return 'none'
  return colorKey(s.color)
}

/** Same stroke colour; two unstroked shapes match each other. */
export function sameStroke(a: PathItem, b: PathItem): boolean {
  return strokeColor(a) === strokeColor(b)
}

/** Fill, stroke, stroke width and both opacities. */
export function sameAppearance(a: PathItem, b: PathItem): boolean {
  if (!sameFill(a, b) || !sameStroke(a, b)) return false
  if (!near(a.fillOpacity ?? 1, b.fillOpacity ?? 1)) return false
  if (strokeColor(a) === 'none') return true
  const sa = a.stroke!
  const sb = b.stroke!
  return near(sa.width, sb.width) && near(sa.opacity ?? 1, sb.opacity ?? 1)
}

/** Whether `p` paints like `model` in the given respect. */
export function paintMatches(model: PathItem, p: PathItem, what: SameWhat): boolean {
  switch (what) {
    case 'fill':
      return sameFill(model, p)
    case 'stroke':
      return sameStroke(model, p)
    case 'fillStroke':
      return sameFill(model, p) && sameStroke(model, p)
    case 'appearance':
      return sameAppearance(model, p)
  }
}

/**
 * The ids "select same" selects, or null when the selection has no path to
 * take the paint from. See the header for what a match selects.
 */
export function selectSame(
  doc: EditableDoc,
  selection: ReadonlySet<string>,
  what: SameWhat,
  enteredGroupId: string | null = null,
): Set<string> | null {
  const model = leadPath(doc, selection)
  if (!model) return null
  let scope: readonly DocItem[] = doc.items
  if (enteredGroupId) {
    const g = findItem(doc.items, enteredGroupId)
    if (g && isGroup(g) && findItem(g.children, model.id)) scope = g.children
  }
  const out = new Set<string>()
  const walk = (list: readonly DocItem[]) => {
    for (const it of list) {
      if (!it.visible) continue
      if (isGroup(it)) {
        if (it.text) {
          if (allPaths(it.children).some((glyph) => paintMatches(model, glyph, what))) out.add(it.id)
        } else walk(it.children)
      } else if (it.kind === 'path' && paintMatches(model, it, what)) out.add(it.id)
    }
  }
  walk(scope)
  return out
}
