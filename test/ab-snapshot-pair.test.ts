// The A/B snapshot PAIRING contract (src/devtest/abCorpus.ts).
//
// Two stamps of one change are a set: `pnpm gen:absnapshot before-x`, change the tracer,
// `pnpm gen:absnapshot after-x`. /labs/ab groups them into one dropdown entry that diffs
// the two FROZEN outputs against each other — no working-tree trace, so the comparison
// does not decay as the tree moves on.
//
// The grouping is a naming convention, which makes it exactly the kind of thing that
// breaks silently: rename the prefix, or let `snapshotDirName` mangle it, and pairs simply
// stop appearing with no error anywhere. This pins the round trip.
//
//   node --test test/ab-snapshot-pair.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { conventionalPartner, pairSlug, snapshotDirName } from '../src/devtest/abCorpus.ts'

test('pair: before- and after- name each other', () => {
  assert.equal(conventionalPartner('before-cornerjunction'), 'after-cornerjunction')
  assert.equal(conventionalPartner('after-cornerjunction'), 'before-cornerjunction')
  // …and the relation is an involution, which is what lets the view dedupe a pair found
  // from either end into one entry.
  for (const n of ['before-x', 'after-x', 'before-14-gallery', 'after-sub-pixel-edges']) {
    assert.equal(conventionalPartner(conventionalPartner(n)!), n)
  }
})

test('pair: a name outside the convention has no partner', () => {
  for (const n of ['4c4a317', 'baseline', 'beforehand', 'aftermath', 'before', 'after', 'x-before-y']) {
    assert.equal(conventionalPartner(n), null, `${n} must not pair`)
  }
})

test('pair: the shared slug is what labels the pair', () => {
  assert.equal(pairSlug('before-cornerjunction'), 'cornerjunction')
  assert.equal(pairSlug('after-cornerjunction'), 'cornerjunction')
  assert.equal(pairSlug('before-cornerjunction'), pairSlug('after-cornerjunction'))
  // A name outside the convention is its own slug — the view then labels the pair with
  // both full names instead.
  assert.equal(pairSlug('4c4a317'), '4c4a317')
})

test('pair: a conventional name survives the directory sanitizer', () => {
  // The writer passes the CLI name through snapshotDirName before it becomes a folder AND
  // the dropdown key. If that mangled the prefix, the pair would exist on disk and never
  // group — so the convention has to be closed under it.
  for (const n of ['before-cornerjunction', 'after-14-gallery', 'before-sub_pixel.v2']) {
    assert.equal(snapshotDirName(n), n)
    assert.equal(snapshotDirName(conventionalPartner(n)!), conventionalPartner(n))
  }
  // A name with spaces is sanitized on BOTH sides consistently, so it still pairs.
  const dirty = snapshotDirName('before corner junction')
  assert.equal(dirty, 'before-corner-junction')
  assert.equal(conventionalPartner(dirty), 'after-corner-junction')
})
