// The studio's auto-probes apply on a fresh image and only MEASURE on a restore
// — and "restore" is keyed to the image, not to a flag armed at mount.
//
//   node --test test/probe-ledger.test.ts
//
// The bug this gates: a stored view exists after the first ever visit, so the old
// boolean was armed on every mount and consumed only by a probe that actually
// ran. A "Clean SVG" source never probes, so the flag survived an upload and the
// fresh image was traced with the previous image's options.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { probeShouldApply, restoredDecision } from '../src/components/vectorize/probeLedger.ts'

test('a fresh session (no stored view) applies on the first image', () => {
  const decidedFor = restoredDecision(null)
  assert.equal(decidedFor, null)
  assert.equal(probeShouldApply(decidedFor, 'k1'), true)
})

test('a restore measures only on its own image, then applies on a new upload', () => {
  let decidedFor = restoredDecision({ probedAssetKey: 'k1' })
  assert.equal(probeShouldApply(decidedFor, 'k1'), false, "the restored options are the user's own")
  decidedFor = 'k1' // the probe ran (measurement only) and recorded the image
  assert.equal(probeShouldApply(decidedFor, 'k2'), true, 'a fresh upload is not a restore')
})

test('the flag does not survive an image swap when no probe ran in between', () => {
  // Restored with an SVG in "Clean SVG" mode: no probe ever runs for k1, and the
  // stored view still names the image before it.
  const decidedFor = restoredDecision({ probedAssetKey: 'k0' })
  // The user uploads another image, or switches that SVG to Re-trace: the
  // options on screen were decided for k0, not for this one.
  assert.equal(probeShouldApply(decidedFor, 'k1'), true)
  assert.equal(probeShouldApply(decidedFor, 'k2'), true)
})

test('a view that records no image is not a decision for the one on screen', () => {
  // Stored before the field existed, or saved while a "Clean SVG" source sat
  // unprobed. Treating it as decided is exactly the old bug.
  assert.equal(restoredDecision({}), null)
  assert.equal(probeShouldApply(restoredDecision({}), 'k1'), true)
  assert.equal(probeShouldApply(restoredDecision({ probedAssetKey: null }), 'k1'), true)
})
