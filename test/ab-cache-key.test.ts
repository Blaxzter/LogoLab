// /labs/ab caches a FROZEN comparison under a key built from the stamp(s). A stamp lives
// outside ENGINE_HASH's reach, and `pnpm gen:absnapshot <same-name>` rewrites it in place,
// so a key made of the NAME alone served a re-blessed stamp's old verdicts and heats.
//
//   node --test test/ab-cache-key.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { snapOptionsKey } from '../src/components/labs/abCacheKey.ts'

const manifest = (createdAt: string) => JSON.stringify({ name: 'before-x', rev: 'abc1234', createdAt, cases: [] })
const before = { name: 'before-x', raw: manifest('2026-10-06T10:00:00.000Z') }
const reblessed = { name: 'before-x', raw: manifest('2026-10-06T11:00:00.000Z') }
const after = { name: 'after-x', raw: manifest('2026-10-06T12:00:00.000Z') }

test('ab cache key: a re-bless under the same name is a new key', () => {
  assert.notEqual(snapOptionsKey(before), snapOptionsKey(reblessed))
  assert.equal(snapOptionsKey(before), snapOptionsKey({ ...before }))
})

test('ab cache key: pair mode moves when EITHER side is re-stamped', () => {
  const k = snapOptionsKey(before, after)
  assert.notEqual(k, snapOptionsKey(reblessed, after))
  assert.notEqual(k, snapOptionsKey(before, { name: 'after-x', raw: manifest('2026-10-07T00:00:00.000Z') }))
  assert.equal(k, snapOptionsKey({ ...before }, { ...after }))
})

test('ab cache key: pair and single-stamp keys never collide', () => {
  assert.notEqual(snapOptionsKey(before), snapOptionsKey(before, after))
  assert.notEqual(snapOptionsKey(before, after), snapOptionsKey(after, before))
})
