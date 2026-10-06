// A NumberField commits what its text parses to — and a BLANK field is not 0.
// `Number('')` is 0, so clearing the editor's X field and tabbing away used to
// move the shape to x = 0 (and a cleared stroke width erased the stroke).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseNumberDraft } from '../src/components/ui/numberDraft.ts'

test('a blank or whitespace draft reverts instead of committing 0', () => {
  assert.equal(parseNumberDraft(''), null)
  assert.equal(parseNumberDraft('   '), null)
  assert.equal(parseNumberDraft('', 0), null)
})

test('a typed 0 still commits 0', () => {
  assert.equal(parseNumberDraft('0'), 0)
  assert.equal(parseNumberDraft(' 0 ', 0, 10), 0)
})

test('numbers parse, junk and out-of-range values revert', () => {
  assert.equal(parseNumberDraft('12.5'), 12.5)
  assert.equal(parseNumberDraft('-3', -5), -3)
  assert.equal(parseNumberDraft('abc'), null)
  assert.equal(parseNumberDraft('Infinity'), null)
  assert.equal(parseNumberDraft('-1', 0), null)
  assert.equal(parseNumberDraft('11', 0, 10), null)
})
