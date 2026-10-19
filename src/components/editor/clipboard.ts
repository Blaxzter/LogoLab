// Copy / Cut / Paste for the SVG editor: what goes on the clipboard, and where a paste lands. Pure.
//
// A copy is written twice. The system clipboard gets standalone SVG markup (the
// selection in a document framed on its own bounds), so it pastes into any other
// tool; the editor keeps the items themselves, because markup is lossy here — a
// live text comes back as outlines, a name as nothing. A paste whose text is the
// markup this editor last wrote takes the items; any other SVG is parsed and
// dropped in, which is how one drawing goes into another.
//
// Ids: every pasted item gets a fresh one (`duplicateItems`), and that is enough
// for everything the model writes — a path's paint server id is derived from its
// item id. Raw markup is the exception: it carries its own `id="…"` and
// `url(#…)`, and two pasted SVGs exported by the same tool both say `id="a"`.
// Ids in the DOM are document-global, so the second one's references would
// resolve to the first one's gradient. A pasted id that is already taken is
// renamed, along with every reference to it inside the paste.

import type { Affine, DocItem, EditableDoc, GroupItem, RawItem } from '../../lib/path/types.ts'
import { findItem, isGroup, topLevelSelection, walkItems } from '../../lib/path/docTree.ts'
import { parseSvg, serializeDoc } from '../../lib/path/model.ts'
import { itemBox, transformItems, translation, unionBoxes, type Box } from '../../lib/editor/transform.ts'
import { duplicateItems } from './editorDoc.ts'

/** What the editor remembers about its last copy. */
export interface EditorClip {
  /** Deep copies of what was copied, in paint order, at their original coordinates. */
  items: DocItem[]
  /** The markup that went on the system clipboard; a paste of exactly this text is "ours". */
  svg: string
  /** Ids of the originals, so a paste can tell whether they are still on the board. */
  sourceIds: string[]
  /** Pastes made from this copy so far. */
  pastes: number
  /** Steps the first paste was offset by: 1 next to its originals, 0 in place of them. */
  base?: number
}

/* ---------------------------------------------------------------- copy */

/** Top-level selected items in paint order (the selection set has no order). */
function selectedInPaintOrder(doc: EditableDoc, selection: ReadonlySet<string>): DocItem[] {
  const top = new Set(topLevelSelection(doc.items, selection))
  const out: DocItem[] = []
  walkItems(doc.items, (it) => {
    if (top.has(it.id)) out.push(it)
  })
  return out
}

/** A raw element that draws nothing by itself: defs, a stylesheet, a paint server… */
const NON_RENDERING = /^\s*<(defs|style|linearGradient|radialGradient|symbol|pattern|clipPath|mask|filter|marker)\b/i

/**
 * Copy the selection. Raw markup that references a `<defs>` elsewhere in the
 * drawing takes that defs item along, or the copy would paint black (or not at
 * all) once it is pasted anywhere the defs aren't.
 */
export function copySelection(doc: EditableDoc, selection: ReadonlySet<string>): EditorClip | null {
  const picked = selectedInPaintOrder(doc, selection)
  if (picked.length === 0) return null

  const taken = new Set<string>()
  walkItems(picked, (it) => taken.add(it.id))
  // Follow references to a fixpoint: a gradient that `href`s another gradient
  // for its stops needs that one too, and they may sit in separate raw items.
  const defined = new Set<string>()
  const unresolved = (from: readonly RawItem[]) => {
    for (const raw of from) for (const id of rawDefinedIds(raw)) defined.add(id)
    const out = new Set<string>()
    for (const raw of from) for (const id of rawRefs(raw)) if (!defined.has(id)) out.add(id)
    return out
  }
  const all = rawItems(doc.items)
  const defIds = new Set<string>()
  let wanted = unresolved(rawItems(picked))
  while (wanted.size > 0) {
    const added = all.filter((raw) => !taken.has(raw.id) && rawDefinedIds(raw).some((id) => wanted.has(id)))
    if (added.length === 0) break
    for (const raw of added) {
      taken.add(raw.id)
      defIds.add(raw.id)
    }
    wanted = unresolved(added)
  }
  // In the drawing's own order, so a referenced definition stays before its user.
  const defs: DocItem[] = all.filter((raw) => defIds.has(raw.id))

  const items = structuredClone([...defs, ...picked])
  return { items, svg: clipMarkup(items, doc.viewBox), sourceIds: picked.map((it) => it.id), pastes: 0 }
}

/**
 * Standalone SVG of the given items, framed on their bounds (strokes included,
 * by half the widest one). Raw markup has no measurable box, so a copy that is
 * nothing else keeps the drawing's frame.
 */
export function clipMarkup(items: DocItem[], fallback: EditableDoc['viewBox']): string {
  const box = unionBoxes(items.map(itemBox))
  let viewBox = fallback
  if (box) {
    let pad = 0
    walkItems(items, (it) => {
      if (it.kind === 'path' && it.stroke) pad = Math.max(pad, it.stroke.width / 2)
    })
    viewBox = [box.x - pad, box.y - pad, Math.max(box.w + 2 * pad, 1e-3), Math.max(box.h + 2 * pad, 1e-3)]
  }
  return serializeDoc({ viewBox, items })
}

/* --------------------------------------------------------------- paste */

/**
 * What a paste EVENT offers, read for `pasteText`: the text, or null when the
 * clipboard holds nothing at all — the one case where the editor's own last
 * copy stands in (its system-clipboard write may have been refused). A
 * clipboard holding something else (a screenshot arrives as types ['Files']
 * with empty text) gives '', which pastes nothing: the user last copied that,
 * not the editor's shapes.
 */
export function pasteEventText(types: readonly string[], getText: () => string): string | null {
  if (types.length === 0) return null
  return types.includes('text/plain') ? getText() : ''
}

/** One paste step: the same nudge Duplicate uses. */
export function pasteStep(doc: EditableDoc): number {
  return Math.max(doc.viewBox[2], doc.viewBox[3]) * 0.02
}

/**
 * How far this paste lands from the copied originals, in steps, and the clip
 * to keep afterwards. The first paste goes one step off the originals when
 * they are still there and onto their spot when they are gone (a cut, a
 * delete); every later paste steps on from there, so repeated pastes fan out
 * instead of piling up on one spot.
 */
export function nextPaste(clip: EditorClip, doc: EditableDoc): { steps: number; clip: EditorClip } {
  const base = clip.base ?? (clip.sourceIds.some((id) => findItem(doc.items, id)) ? 1 : 0)
  return { steps: base + clip.pastes, clip: { ...clip, base, pastes: clip.pastes + 1 } }
}

/**
 * Put copies of `items` on top of the drawing, moved by `m`: fresh ids for
 * everything, colliding raw-markup ids renamed. The copies are the result's
 * selection.
 */
export function insertPasted(
  doc: EditableDoc,
  items: readonly DocItem[],
  m: Affine,
): { doc: EditableDoc; ids: Set<string> } | null {
  if (items.length === 0) return null
  const copies = renameRawIds(duplicateItems(items), takenIds(doc.items))
  const ids = new Set(copies.map((c) => c.id))
  const moved = transformItems(copies, ids, m)
  return { doc: { ...doc, items: [...doc.items, ...moved] }, ids }
}

/** Paste the clip's own items, stepped by `steps` paste steps. */
export function pasteClip(doc: EditableDoc, clip: EditorClip, steps: number) {
  const d = steps * pasteStep(doc)
  return insertPasted(doc, clip.items, translation(d, d))
}

/** A foreign SVG, read for pasting: its items as one item, and the frame its art fills. */
export interface ForeignPaste {
  item: DocItem
  frame: Box
}

/**
 * Read clipboard text as an SVG to paste. Several top-level items arrive as
 * one group, so the pasted drawing moves, scales and deletes as one thing.
 * Null when the text is not SVG or draws nothing.
 */
export function readForeignSvg(text: string): ForeignPaste | null {
  if (!/<svg[\s>]/i.test(text)) return null
  const parsed = parseSvg(text.trim(), { preserveGroups: true })
  if (!parsed || parsed.items.length === 0) return null
  const [vx, vy, vw, vh] = parsed.viewBox
  // Raw markup that paints has no box we can measure; its extent is the
  // document's frame, so that is what the paste is fitted by.
  let paintsRaw = false
  walkItems(parsed.items, (it) => {
    if (it.kind === 'raw' && !it.inert && !NON_RENDERING.test(it.markup)) paintsRaw = true
  })
  const art = paintsRaw ? null : unionBoxes(parsed.items.map(itemBox))
  const frame = art ?? { x: vx, y: vy, w: vw, h: vh }
  const item: DocItem =
    parsed.items.length === 1
      ? parsed.items[0]
      : ({ kind: 'group', id: 'pasted', children: parsed.items, visible: true, expanded: true } satisfies GroupItem)
  return { item, frame }
}

/** A paste larger than the view, on either axis, is shrunk to fill this much of it. */
const FIT_FILL = 0.8
/** Smaller than this share of the view on BOTH axes reads as a speck… */
const TINY = 0.1
/** …and is enlarged to fill this much of it. */
const TINY_FILL = 0.25

/**
 * Where a foreign SVG lands in the view: centred, and scaled only when keeping
 * its size would be useless — larger than the view (a 1024-unit export into a
 * 24-unit icon) or a speck in it (that icon into a 1024 board).
 */
export function placeForeign(frame: Box, view: Box): Affine {
  const r = Math.max(frame.w / view.w, frame.h / view.h)
  const k = !(r > 0) ? 1 : r > 1 ? FIT_FILL / r : r < TINY ? TINY_FILL / r : 1
  const cx = frame.x + frame.w / 2
  const cy = frame.y + frame.h / 2
  const tx = view.x + view.w / 2
  const ty = view.y + view.h / 2
  return [k, 0, 0, k, tx - cx * k, ty - cy * k]
}

/* ----------------------------------------------------------- raw ids */

function rawItems(items: readonly DocItem[]): RawItem[] {
  const out: RawItem[] = []
  walkItems(items, (it) => {
    if (it.kind === 'raw') out.push(it)
  })
  return out
}

const DEF_ID = /(\s)id\s*=\s*(["'])([^"']+)\2/g
const URL_REF = /url\(\s*(["']?)#([^)"'\s]+)\1\s*\)/g
const HREF_REF = /(\s(?:xlink:)?href\s*=\s*)(["'])#([^"']+)\2/g

/** Ids a raw item's markup defines. */
export function rawDefinedIds(raw: RawItem): string[] {
  return [...raw.markup.matchAll(DEF_ID)].map((m) => m[3])
}

/** Ids a raw item's markup (and the context it inherited) points at. */
function rawRefs(raw: RawItem): string[] {
  const text = raw.markup + ' ' + Object.values(raw.inherited ?? {}).join(' ')
  return [...[...text.matchAll(URL_REF)].map((m) => m[2]), ...[...text.matchAll(HREF_REF)].map((m) => m[3])]
}

/**
 * Every id the drawing already puts in the DOM: raw markup's own, and the
 * paint server each gradient path is serialized with.
 */
export function takenIds(items: readonly DocItem[]): Set<string> {
  const taken = new Set<string>()
  walkItems(items, (it) => {
    if (it.kind === 'raw') for (const id of rawDefinedIds(it)) taken.add(id)
    else if (it.kind === 'path' && it.gradient) taken.add(`grad-${it.id}`)
  })
  return taken
}

/**
 * Rename every id the pasted raw markup defines that `taken` already has, and
 * every reference to it within the paste (`url(#…)`, `href="#…"`, inherited
 * attributes). One map for the whole paste: a gradient in one raw item and the
 * shape that uses it in another must agree. References to ids the paste does
 * not define are left alone — they point at the drawing's own defs.
 */
export function renameRawIds(items: DocItem[], taken: ReadonlySet<string>): DocItem[] {
  const defined = new Set<string>()
  for (const raw of rawItems(items)) for (const id of rawDefinedIds(raw)) defined.add(id)
  const rename = new Map<string, string>()
  const used = new Set([...taken, ...defined])
  for (const id of defined) {
    if (!taken.has(id)) continue
    let k = 2
    while (used.has(`${id}-${k}`)) k++
    const fresh = `${id}-${k}`
    used.add(fresh)
    rename.set(id, fresh)
  }
  if (rename.size === 0) return items

  const swap = (s: string) =>
    s
      .replace(DEF_ID, (all, sp: string, q: string, id: string) =>
        rename.has(id) ? `${sp}id=${q}${rename.get(id)}${q}` : all,
      )
      .replace(URL_REF, (all, q: string, id: string) => (rename.has(id) ? `url(${q}#${rename.get(id)}${q})` : all))
      .replace(HREF_REF, (all, attr: string, q: string, id: string) =>
        rename.has(id) ? `${attr}${q}#${rename.get(id)}${q}` : all,
      )
  const visit = (it: DocItem): DocItem => {
    if (isGroup(it)) return { ...it, children: it.children.map(visit) }
    if (it.kind !== 'raw') return it
    const next: RawItem = { ...it, markup: swap(it.markup) }
    if (it.inherited) {
      next.inherited = Object.fromEntries(Object.entries(it.inherited).map(([k, v]) => [k, swap(v)]))
    }
    return next
  }
  return items.map(visit)
}
