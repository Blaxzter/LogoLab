// The save indicator has to be able to say "not saved".
//
//   node --test test/save-status.test.ts
//
// This is the module behind the header's Saved chip, and its two failure modes
// are both quiet ones. Report "saved" while a newer value is still only in
// memory and the chip is lying about the one thing it exists to promise; get
// stuck on "saving" and it cries wolf forever. Neither shows up in a screenshot,
// because both look exactly like the working version at the moment you look.
//
// The pending arithmetic is the subtle part: writes are DEBOUNCED, so a slot can
// be re-armed while its own previous write is still in flight, and the settle
// has to be measured against the count read when that write started — not the
// count now.

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  getSaveStatus,
  markArmed,
  markDropped,
  markFailed,
  markRestored,
  markSaved,
  markSettled,
  resetSaveStatus,
  subscribeSaveStatus,
} from '../src/lib/persist/status.ts'

beforeEach(() => resetSaveStatus())

test('a fresh session has nothing to report', () => {
  const s = getSaveStatus()
  assert.equal(s.pending, false)
  assert.equal(s.savedAt, null)
  assert.equal(s.failed, false)
})

test('arming turns it pending, settling turns it saved', () => {
  const seq = markArmed('logo')
  assert.equal(getSaveStatus().pending, true)
  assert.equal(getSaveStatus().savedAt, null)

  markSettled('logo', seq, true)
  const s = getSaveStatus()
  assert.equal(s.pending, false)
  assert.equal(s.failed, false)
  assert.ok(s.savedAt !== null && s.savedAt <= Date.now())
})

test('a value armed DURING a write keeps it pending', () => {
  const first = markArmed('vectorize')
  // The debounce re-arms while the first write is still in flight.
  markArmed('vectorize')
  // ...and the first write now lands. It stored the OLD value, so the newer one
  // is still only in memory and the chip must keep saying so.
  markSettled('vectorize', first, true)
  assert.equal(getSaveStatus().pending, true, 'the second value has not been written yet')

  markSettled('vectorize', 2, true)
  assert.equal(getSaveStatus().pending, false)
})

test('one slot settling does not clear another slot', () => {
  const logo = markArmed('logo')
  markArmed('sheet')
  markSettled('logo', logo, true)
  assert.equal(getSaveStatus().pending, true, 'the sheet is still unwritten')
})

test('a failed write is reported, and a later success of the SAME store clears it', () => {
  const seq = markArmed('sheet')
  markSettled('sheet', seq, false)
  const failed = getSaveStatus()
  assert.equal(failed.failed, true)
  assert.equal(failed.pending, false)
  assert.equal(failed.savedAt, null, 'a failed write must not stamp a save time')

  const retry = markArmed('sheet')
  markSettled('sheet', retry, true)
  assert.equal(getSaveStatus().failed, false)
  assert.ok(getSaveStatus().savedAt !== null)
})

test("another store's success does not hide a failure", () => {
  // The logo did not fit in IndexedDB and is not retried until it changes; a
  // slider's localStorage write landing a moment later says nothing about it.
  // One global flag let any success flip the chip back to "Saved" while a
  // reload would lose the logo.
  const seq = markArmed('logo')
  markSettled('logo', seq, false)
  markSaved('ls:appearance')
  assert.equal(getSaveStatus().failed, true, 'a localStorage save must not clear the logo failure')
  const sheet = markArmed('sheet')
  markSettled('sheet', sheet, true)
  assert.equal(getSaveStatus().failed, true, 'nor another slot landing')

  // A localStorage failure is cleared by that key alone, too.
  resetSaveStatus()
  markFailed('ls:export')
  markSaved('ls:appearance')
  assert.equal(getSaveStatus().failed, true)
  markSaved('ls:export')
  assert.equal(getSaveStatus().failed, false)
})

test('dropping a store forgets its pending write and its failure', () => {
  const seq = markArmed('sheet')
  markSettled('sheet', seq, false)
  markArmed('sheet')
  assert.equal(getSaveStatus().pending, true)
  markDropped('sheet')
  assert.equal(getSaveStatus().pending, false, 'a cancelled write is not owed any more')
  assert.equal(getSaveStatus().failed, false, 'a deleted slot cannot be unsaved')
  assert.equal(getSaveStatus().savedAt, null, 'nothing was saved, so no timestamp')
})

test('a synchronous store that throws is reported too', () => {
  markFailed('ls:appearance')
  assert.equal(getSaveStatus().failed, true)
})

test('a restored session already counts as saved', () => {
  // The reason this exists: without it the chip reads "nothing saved yet" to
  // someone who just reloaded INTO their restored work — true of this page load,
  // and the opposite of the answer they are looking for.
  const at = Date.now() - 60_000
  markRestored(at)
  assert.equal(getSaveStatus().savedAt, at, 'reports when the DATA was written, not now')
  assert.equal(getSaveStatus().pending, false)
})

test('a restore never moves the timestamp backwards', () => {
  markSaved('ls:appearance')
  const live = getSaveStatus().savedAt
  markRestored(Date.now() - 600_000)
  assert.equal(getSaveStatus().savedAt, live, 'an older stored slot must not age a fresh save')
})

test('the snapshot keeps its identity when nothing changed', () => {
  // useSyncExternalStore compares by identity: a new object for an unchanged
  // status re-renders the header on every keystroke of a brand-name field.
  const seq = markArmed('logo')
  markSettled('logo', seq, true)
  const a = getSaveStatus()
  markSettled('logo', seq, true)
  assert.equal(getSaveStatus(), a, 'a repeat settle must not publish a new object')
})

test('subscribers are notified, and unsubscribing stops that', () => {
  let calls = 0
  const off = subscribeSaveStatus(() => calls++)
  markArmed('logo')
  assert.ok(calls > 0)
  const seen = calls
  off()
  markSettled('logo', 1, true)
  assert.equal(calls, seen, 'no calls after unsubscribe')
})
