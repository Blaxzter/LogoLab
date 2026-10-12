// The editor's context menu: where it opens, and what it offers.
//
//   node --test test/editor-menu.test.ts
//
// Placement: a menu opened near an edge flips to the other side of the
// pointer rather than being pushed back over it. Clamping is what a naive
// version does, and it parks the menu's first item under the cursor, so the
// release of a right-drag lands on a command.
//
// Content: a command that cannot apply to this kind of target is left out,
// one that applies but is blocked stays, disabled, with the toolbar's reason.
// The menu is a shortcut to commands that live elsewhere, and a disabled entry
// that says why is how you learn where.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { placeMenu } from '../src/components/ui/menuPlace.ts'
import { editorMenu, type EditorMenuContext, type EditorMenuItem } from '../src/components/editor/studio/editorMenu.ts'

test('a menu opens down-right of the pointer when it fits', () => {
  assert.deepEqual(placeMenu(100, 100, 240, 300, 1280, 800), { left: 100, top: 100 })
})

test('near the right and bottom edges it flips, so its corner stays on the pointer', () => {
  assert.deepEqual(placeMenu(1200, 700, 240, 300, 1280, 800), { left: 960, top: 400 })
})

test('a menu too tall for either side is clamped into the viewport', () => {
  const { top } = placeMenu(100, 300, 240, 700, 1280, 720)
  assert.ok(top >= 8 && top + 700 <= 720 - 8 + 1e-9, `top ${top}`)
})

const reasons = {
  undo: null,
  redo: 'Nothing to redo.',
  group: 'Select two or more items to group.',
  ungroup: 'Select a group.',
  selection: null,
  remove: null,
  reverse: null,
  split: 'Only one subpath.',
  combine: 'Select two or more paths.',
  breakNode: 'Select exactly one node.',
  join: 'Select the two end nodes.',
  add: null,
  boolean: 'Select two or more shapes.',
}

const ctx = (over: Partial<EditorMenuContext> = {}): EditorMenuContext => ({
  why: reasons,
  selectedCount: 1,
  single: 'path',
  hasText: false,
  allHidden: false,
  enteredGroup: false,
  nodeTool: false,
  showGrid: false,
  snapOn: true,
  nodeKinds: { smooth: 0, corner: 0 },
  ...over,
})

const actions = (entries: ReturnType<typeof editorMenu>) =>
  entries.filter((e): e is EditorMenuItem => e.kind === 'item').map((e) => e.action)

test('one path: node editing and path commands, no group or boolean commands', () => {
  const a = actions(editorMenu({ kind: 'items', from: 'canvas' }, ctx()))
  assert.ok(a.includes('editNodes'))
  assert.ok(a.includes('reverse'))
  for (const absent of ['group', 'ungroup', 'bool:add', 'bool:subtract', 'split', 'combine', 'rename']) {
    assert.ok(!a.includes(absent as never), `${absent} should not be offered on one path`)
  }
})

test('several shapes: booleans appear, with the toolbar reasons', () => {
  const entries = editorMenu(
    { kind: 'items', from: 'canvas' },
    ctx({ selectedCount: 3, single: null, why: { ...reasons, group: null, boolean: null } }),
  )
  const sub = entries.find((e) => e.kind === 'item' && e.action === 'bool:subtract') as EditorMenuItem
  assert.equal(sub.reason, null)
  assert.ok(actions(entries).includes('group'))
})

test('rename is a layers-list command', () => {
  assert.ok(actions(editorMenu({ kind: 'items', from: 'layers' }, ctx())).includes('rename'))
  assert.ok(!actions(editorMenu({ kind: 'items', from: 'canvas' }, ctx())).includes('rename'))
})

test('a blocked command stays in the menu, disabled with its reason', () => {
  const entries = editorMenu({ kind: 'canvas' }, ctx())
  const redo = entries.find((e) => e.kind === 'item' && e.action === 'redo') as EditorMenuItem
  assert.equal(redo.reason, reasons.redo)
})

test('nodes: the kind they all already are is disabled', () => {
  const entries = editorMenu({ kind: 'nodes' }, ctx({ nodeTool: true, nodeKinds: { smooth: 2, corner: 0 } }))
  const smooth = entries.find((e) => e.kind === 'item' && e.action === 'smooth') as EditorMenuItem
  const corner = entries.find((e) => e.kind === 'item' && e.action === 'corner') as EditorMenuItem
  assert.match(smooth.reason ?? '', /already smooth/)
  assert.equal(corner.reason, null)
})

test('no menu leads, trails or doubles a separator', () => {
  const targets = [
    { kind: 'canvas' },
    { kind: 'segment' },
    { kind: 'nodes' },
    { kind: 'items', from: 'canvas' },
    { kind: 'items', from: 'layers' },
  ] as const
  for (const t of targets) {
    for (const c of [ctx(), ctx({ selectedCount: 2, single: null }), ctx({ single: 'text', hasText: true })]) {
      const e = editorMenu(t, c)
      assert.ok(e.length > 0)
      assert.notEqual(e[0].kind, 'sep')
      assert.notEqual(e[e.length - 1].kind, 'sep')
      for (let i = 1; i < e.length; i++) assert.ok(!(e[i].kind === 'sep' && e[i - 1].kind === 'sep'))
    }
  }
})
