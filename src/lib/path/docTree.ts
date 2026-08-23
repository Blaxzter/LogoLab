// Group-aware traversal and structural editing of an EditableDoc.
//
// `doc.items` is a TREE once groups exist, but almost every consumer in this
// codebase (the tracer's metrics, the labs, rasterization, docStats) only wants
// the paintable leaves in paint order and has no interest in the folder
// structure. So the split here is deliberate:
//
//   leafItems()  — what renders, flattened, in paint order. The old meaning of
//                  `doc.items` for code written before groups existed.
//   walkItems()  — the tree, groups included, for the layers panel and anything
//                  doing structural work.
//
// Everything is immutable: a structural edit returns a new spine (only the
// groups on the path to the change are rebuilt) so React identity checks and
// the undo history keep working. Untouched subtrees are shared by reference.

import type { DocItem, EditableDoc, GroupItem, PathItem, RawItem } from './types.ts'

/** A paintable item — anything that isn't a container. */
export type Leaf = PathItem | RawItem

/** True for the container kind — narrows so callers can reach `.children`. */
export function isGroup(item: DocItem): item is GroupItem {
  return item.kind === 'group'
}

/**
 * Every paintable leaf (path / raw) in paint order, groups flattened away.
 * Hidden groups prune their whole subtree — a hidden folder hides what's in it.
 */
export function leafItems(items: readonly DocItem[]): Leaf[] {
  const out: Leaf[] = []
  const walk = (list: readonly DocItem[], visible: boolean) => {
    for (const it of list) {
      const vis = visible && it.visible
      if (isGroup(it)) walk(it.children, vis)
      else if (vis) out.push(it)
    }
  }
  walk(items, true)
  return out
}

/** Every leaf regardless of visibility — for hit-testing an editor's own list. */
export function allLeaves(items: readonly DocItem[]): Leaf[] {
  const out: Leaf[] = []
  for (const it of items) {
    if (isGroup(it)) out.push(...allLeaves(it.children))
    else out.push(it)
  }
  return out
}

/** Every PathItem in the tree, visible or not, in paint order. */
export function allPaths(items: readonly DocItem[]): PathItem[] {
  return allLeaves(items).filter((it): it is PathItem => it.kind === 'path')
}

/** Depth-first visit of the whole tree, groups included. Depth starts at 0. */
export function walkItems(
  items: readonly DocItem[],
  visit: (item: DocItem, depth: number, parent: GroupItem | null) => void,
  depth = 0,
  parent: GroupItem | null = null,
): void {
  for (const it of items) {
    visit(it, depth, parent)
    if (isGroup(it)) walkItems(it.children, visit, depth + 1, it)
  }
}

/** The item with this id, anywhere in the tree. */
export function findItem(items: readonly DocItem[], id: string): DocItem | null {
  for (const it of items) {
    if (it.id === id) return it
    if (isGroup(it)) {
      const hit = findItem(it.children, id)
      if (hit) return hit
    }
  }
  return null
}

/** The group containing `id` (null = top level), and the index within it. */
export function findParent(
  items: readonly DocItem[],
  id: string,
  parent: GroupItem | null = null,
): { parent: GroupItem | null; index: number } | null {
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    if (it.id === id) return { parent, index: i }
    if (isGroup(it)) {
      const hit = findParent(it.children, id, it)
      if (hit) return hit
    }
  }
  return null
}

/** Groups enclosing `id`, outermost first. Empty when it sits at top level. */
export function ancestorsOf(items: readonly DocItem[], id: string): GroupItem[] {
  const chain: GroupItem[] = []
  const walk = (list: readonly DocItem[], acc: GroupItem[]): boolean => {
    for (const it of list) {
      if (it.id === id) {
        chain.push(...acc)
        return true
      }
      if (isGroup(it) && walk(it.children, [...acc, it])) return true
    }
    return false
  }
  walk(items, [])
  return chain
}

/**
 * Whether the item paints: it and every enclosing group must be visible. The
 * layers panel shows a hidden-by-ancestor row differently from one the user
 * hid directly, so this is separate from reading `item.visible`.
 */
export function isEffectivelyVisible(items: readonly DocItem[], id: string): boolean {
  const item = findItem(items, id)
  if (!item || !item.visible) return false
  return ancestorsOf(items, id).every((g) => g.visible)
}

/** Product of the opacities of every group enclosing `id` (1 when none set). */
export function inheritedOpacity(items: readonly DocItem[], id: string): number {
  return ancestorsOf(items, id).reduce((acc, g) => acc * (g.opacity ?? 1), 1)
}

/* -------------------------------------------------------------- structural */

/** Replace one item by id, sharing every untouched subtree. */
export function replaceItem(items: readonly DocItem[], id: string, next: DocItem): DocItem[] {
  return items.map((it) => {
    if (it.id === id) return next
    if (isGroup(it)) {
      const kids = replaceItem(it.children, id, next)
      return kids === it.children ? it : { ...it, children: kids }
    }
    return it
  })
}

/** Map over every leaf, leaving group structure intact. Identity-stable. */
export function mapLeaves(
  items: readonly DocItem[],
  fn: (item: DocItem) => DocItem,
): DocItem[] {
  let changed = false
  const out = items.map((it) => {
    if (isGroup(it)) {
      const kids = mapLeaves(it.children, fn)
      if (kids === it.children) return it
      changed = true
      return { ...it, children: kids }
    }
    const next = fn(it)
    if (next !== it) changed = true
    return next
  })
  return changed ? out : (items as DocItem[])
}

/** Remove every listed id from the tree. */
export function removeItems(items: readonly DocItem[], ids: ReadonlySet<string>): DocItem[] {
  const out: DocItem[] = []
  for (const it of items) {
    if (ids.has(it.id)) continue
    if (isGroup(it)) {
      const kids = removeItems(it.children, ids)
      out.push(kids === it.children ? it : { ...it, children: kids })
    } else out.push(it)
  }
  return out
}

/** Insert items into a parent group (null = top level) at `index`. */
export function insertItems(
  items: readonly DocItem[],
  parentId: string | null,
  index: number,
  added: readonly DocItem[],
): DocItem[] {
  if (parentId === null) {
    const out = [...items]
    out.splice(clampIndex(index, out.length), 0, ...added)
    return out
  }
  return items.map((it) => {
    if (it.id === parentId && isGroup(it)) {
      const kids = [...it.children]
      kids.splice(clampIndex(index, kids.length), 0, ...added)
      return { ...it, children: kids }
    }
    if (isGroup(it)) {
      const kids = insertItems(it.children, parentId, index, added)
      return kids === it.children ? it : { ...it, children: kids }
    }
    return it
  })
}

function clampIndex(i: number, len: number): number {
  return Math.max(0, Math.min(len, i))
}

/**
 * Collect `ids` into a new group.
 *
 * The group lands where the FRONTMOST member was, in that member's parent —
 * which is the only placement that preserves what the user sees: grouping must
 * never change paint order, and the frontmost member is the one whose depth the
 * whole group inherits. Members are stacked in their original relative order.
 * Ids nested inside another selected id are skipped (the ancestor takes them).
 */
export function groupItems(
  items: readonly DocItem[],
  ids: ReadonlySet<string>,
  groupId: string,
  name?: string,
): { items: DocItem[]; groupId: string } | null {
  const top = topLevelSelection(items, ids)
  if (top.length < 2) return null

  // Paint order of the survivors, so the group's children keep their stacking.
  const order = new Map<string, number>()
  let n = 0
  walkItems(items, (it) => {
    if (top.includes(it.id)) order.set(it.id, n++)
  })
  const members = top
    .slice()
    .sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
    .map((id) => findItem(items, id))
    .filter((it): it is DocItem => it !== null)
  if (members.length < 2) return null

  const frontId = members[members.length - 1].id
  const anchor = findParent(items, frontId)
  if (!anchor) return null

  // Remove first, then insert at the anchor's index recomputed post-removal:
  // pulling members out from below the anchor shifts it down by that many.
  const removedBefore = anchor.parent
    ? anchor.parent.children.filter((c, i) => i < anchor.index && ids.has(c.id)).length
    : items.filter((c, i) => i < anchor.index && ids.has(c.id)).length
  const stripped = removeItems(items, new Set(top))
  const group: GroupItem = {
    kind: 'group',
    id: groupId,
    name,
    children: members,
    visible: true,
    expanded: true,
  }
  return {
    items: insertItems(stripped, anchor.parent?.id ?? null, anchor.index - removedBefore, [group]),
    groupId,
  }
}

/** Splice a group's children back into its parent, in place. */
export function ungroup(items: readonly DocItem[], groupId: string): DocItem[] | null {
  const group = findItem(items, groupId)
  if (!group || !isGroup(group)) return null
  const at = findParent(items, groupId)
  if (!at) return null
  // A hidden group hid its children; ungrouping must not silently reveal them.
  const kids = group.visible
    ? group.children
    : group.children.map((c) => ({ ...c, visible: false }))
  const stripped = removeItems(items, new Set([groupId]))
  return insertItems(stripped, at.parent?.id ?? null, at.index, kids)
}

/**
 * Move `ids` to a paint-order insertion point — what a layers-panel drag does.
 *
 * Returns null when the move is impossible or pointless: dropping a group into
 * its own subtree, or landing exactly where the items already are (which would
 * otherwise cost an undo step that visibly does nothing).
 *
 * The subtlety is the index. It is quoted against the ORIGINAL tree, but the
 * insert happens after the movers have been pulled out — so every mover that
 * sat before the target inside the same parent has shifted it down by one.
 */
export function moveItems(
  items: readonly DocItem[],
  ids: ReadonlySet<string>,
  to: { parentId: string | null; index: number },
): DocItem[] | null {
  const top = topLevelSelection(items, ids)
  if (top.length === 0) return null
  const moving = new Set(top)

  if (to.parentId !== null) {
    const dest = findItem(items, to.parentId)
    if (!dest || !isGroup(dest)) return null
    // A group cannot be dropped inside itself, or inside anything it contains.
    if (moving.has(to.parentId)) return null
    if (ancestorsOf(items, to.parentId).some((g) => moving.has(g.id))) return null
  }

  // Movers keep their relative stacking, whatever order the selection is in.
  const order = new Map<string, number>()
  let n = 0
  walkItems(items, (it) => order.set(it.id, n++))
  const picked = top
    .slice()
    .sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
    .map((id) => findItem(items, id))
    .filter((it): it is DocItem => it !== null)
  if (picked.length === 0) return null

  const siblings =
    to.parentId === null ? items : (findItem(items, to.parentId) as GroupItem).children
  const shift = siblings.filter((c, i) => i < to.index && moving.has(c.id)).length
  const next = insertItems(removeItems(items, moving), to.parentId, to.index - shift, picked)
  return treeSig(next) === treeSig(items) ? null : next
}

/** Ids in tree order with their depth — enough to tell "nothing moved". */
function treeSig(items: readonly DocItem[]): string {
  const parts: string[] = []
  walkItems(items, (it, depth) => parts.push(`${depth}:${it.id}`))
  return parts.join('|')
}

/** Selected ids with any that are nested inside another selected id dropped. */
export function topLevelSelection(
  items: readonly DocItem[],
  ids: ReadonlySet<string>,
): string[] {
  return [...ids].filter((id) => !ancestorsOf(items, id).some((g) => ids.has(g.id)))
}

/**
 * Move the selection one step through paint order within its own parent, or all
 * the way to an end. Each id moves inside the group it already lives in — a
 * raise must not teleport an item out of its folder.
 */
export function reorderItems(
  items: readonly DocItem[],
  ids: ReadonlySet<string>,
  how: 'front' | 'back' | 'forward' | 'backward',
): DocItem[] {
  const reorderList = (list: readonly DocItem[]): DocItem[] => {
    const sel = list.map((it, i) => (ids.has(it.id) ? i : -1)).filter((i) => i >= 0)
    let out = list.map((it) =>
      isGroup(it) ? withChildren(it, reorderList(it.children)) : it,
    )
    if (sel.length === 0) return sameOrShared(list, out)

    const picked = sel.map((i) => out[i])
    const rest = out.filter((_, i) => !sel.includes(i))
    if (how === 'front') out = [...rest, ...picked]
    else if (how === 'back') out = [...picked, ...rest]
    else {
      // One step, processed from the edge the items are travelling toward so a
      // contiguous run slides as a block instead of collapsing onto itself.
      out = [...out]
      const step = how === 'forward' ? 1 : -1
      const order = how === 'forward' ? [...sel].reverse() : sel
      for (const i of order) {
        const j = i + step
        if (j < 0 || j >= out.length || ids.has(out[j].id)) continue
        ;[out[i], out[j]] = [out[j], out[i]]
      }
    }
    return out
  }
  return reorderList(items)
}

function withChildren(g: GroupItem, children: DocItem[]): GroupItem {
  return children === g.children ? g : { ...g, children }
}

function sameOrShared(orig: readonly DocItem[], next: DocItem[]): DocItem[] {
  return next.every((it, i) => it === orig[i]) ? (orig as DocItem[]) : next
}

/** Convenience: the doc with a new item list. */
export function withItems(doc: EditableDoc, items: DocItem[]): EditableDoc {
  return items === doc.items ? doc : { ...doc, items }
}
