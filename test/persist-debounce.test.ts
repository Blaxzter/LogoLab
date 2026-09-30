// A cancelled debounced write stays cancelled.
//
//   node --test test/persist-debounce.test.ts
//
// Removing the logo forgets the vectorize studio's stored settings
// (`forgetStudioView`), so the next image starts from the defaults instead of the
// last image's sliders — a leftover Smoothing 0 traced every later image as a
// raw pixel staircase. The settings are saved through a 300 ms debounce, so a
// slider moved just before the removal still has a write pending. If that write
// fires after the key is removed, it puts back exactly what was cleared, and the
// reset silently does nothing. `cancel()` is what prevents that.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { debounce } from '../src/lib/persist/local.ts'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('a pending write is dropped by cancel and never fires', async () => {
  const writes: number[] = []
  const save = debounce((v: number) => writes.push(v), 10)
  save(1)
  save.cancel()
  await wait(30)
  assert.deepEqual(writes, [])
  // A flush after the cancel has nothing to write either.
  save.flush()
  assert.deepEqual(writes, [])
})

test('the debounce still works after a cancel', async () => {
  const writes: number[] = []
  const save = debounce((v: number) => writes.push(v), 10)
  save(1)
  save.cancel()
  save(2)
  save(3)
  await wait(30)
  assert.deepEqual(writes, [3])
})
