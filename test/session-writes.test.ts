// What the session's debounced writes do around a delete, a flush and Start fresh.
//
//   node --test test/session-writes.test.ts
//
// Node has no IndexedDB, so every slot write here FAILS (idbSet answers false)
// and the save status is the probe: a write that ran shows up as `failed`, a
// write that never ran leaves the status clean. That is enough to see the three
// ways a debounced write landed at the wrong time:
//
//  - deleting a slot left its armed writer running, so the timer wrote the
//    deleted value back over the delete (a cleared sheet came back on reload);
//  - a slot's debounce was fixed by its first write, so `saveSlot(…, 0)` — the
//    editor re-stamping its seenKey — still waited 900 ms;
//  - `pagehide` flushed only the slot writers, never a settings write or a
//    component's publish into the working logo.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { debounce } from '../src/lib/persist/local.ts'
import { clearSession, flushSession, saveSlot, SLOTS } from '../src/lib/persist/session.ts'
import { getSaveStatus, resetSaveStatus } from '../src/lib/persist/status.ts'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('deleting a slot cancels its armed write', async () => {
  resetSaveStatus()
  saveSlot(SLOTS.sheet, { tiles: [1, 2, 3] }, 10)
  assert.equal(getSaveStatus().pending, true)
  saveSlot(SLOTS.sheet, null)
  assert.equal(getSaveStatus().pending, false, 'nothing is owed for a deleted slot')
  await wait(40)
  assert.equal(getSaveStatus().failed, false, 'the cancelled write must never run')
  assert.equal(getSaveStatus().pending, false)
})

test('a zero-delay save is written now, whatever the slot debounce is', async () => {
  resetSaveStatus()
  // The slot's first write fixes a long debounce...
  saveSlot(SLOTS.editor, { doc: 1 }, 10_000)
  // ...and the immediate re-save must not wait for it.
  saveSlot(SLOTS.editor, { doc: 2 }, 0)
  await wait(10)
  const s = getSaveStatus()
  assert.equal(s.pending, false, 'the write already ran')
  assert.equal(s.failed, true, 'and reached the (absent) IndexedDB')
})

test('flushSession runs every armed debounce, not only the slot writers', async () => {
  resetSaveStatus()
  const order: string[] = []
  // A component's publish into the working logo, which queues a slot write.
  const publish = debounce(() => {
    order.push('publish')
    saveSlot(SLOTS.logo, { svg: 'x' }, 10_000)
  }, 10_000)
  const settings = debounce((v: number) => order.push(`settings ${v}`), 10_000)
  publish()
  settings(3)
  flushSession()
  assert.deepEqual(order.sort(), ['publish', 'settings 3'])
  await wait(10)
  assert.equal(getSaveStatus().pending, false, 'the slot write the publish armed was flushed too')
})

// Last: clearSession freezes writes for the rest of the page (it reloads after).
test('Start fresh drops every armed write and refuses later ones', async () => {
  resetSaveStatus()
  const writes: number[] = []
  const settings = debounce((v: number) => writes.push(v), 10)
  settings(1)
  saveSlot(SLOTS.vectorize, { doc: 1 }, 10)
  await clearSession()
  await wait(40)
  flushSession() // the reload's pagehide
  assert.deepEqual(writes, [], 'a settings write armed before the clear never lands')
  saveSlot(SLOTS.vectorize, { doc: 2 }, 0)
  await wait(10)
  const s = getSaveStatus()
  assert.equal(s.failed, false, 'no slot write ran after the clear')
  assert.equal(s.pending, false)
})
