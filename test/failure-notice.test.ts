// The failure question — asked once, answered once.
//
//   node --test test/failure-notice.test.ts
//
// This is the difference between a prompt and nagging, and both failure modes
// are invisible until someone is annoyed by the shipped app. The tracer retries:
// change a setting on art it cannot handle and the same failure happens again,
// and again. If every one of those re-asked a question the user has already said
// no to, people would learn to dismiss the toast without reading it — which
// costs exactly the reports this whole feature exists to collect.
//
// The other direction matters too: a failure that is SUPERSEDED (a new trace
// started, a different file picked) must clear WITHOUT being remembered as a no.
// The user never answered it, and silently treating that as a refusal would mean
// a real failure later never gets to ask.

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  clearFailure,
  dismissFailure,
  getFailure,
  raiseFailure,
  resetFailureNotices,
  subscribeFailure,
} from '../src/lib/failureNotice.ts'

beforeEach(() => resetFailureNotices())

test('nothing is being asked until something fails', () => {
  assert.equal(getFailure(), null)
})

test('a failure asks, carrying the error the report will need', () => {
  const err = new Error('Invalid typed array length')
  raiseFailure('the vectorizer', 'Could not vectorize this image.', err)
  const notice = getFailure()
  assert.equal(notice?.what, 'the vectorizer')
  assert.equal(notice?.message, 'Could not vectorize this image.')
  assert.equal(notice?.error, err, 'the report needs the thrown thing, not the sentence')
})

test('a retry of the same failure does not restart the question', () => {
  raiseFailure('the vectorizer', 'Could not vectorize this image.', new Error('a'))
  const first = getFailure()
  raiseFailure('the vectorizer', 'Could not vectorize this image.', new Error('b'))
  assert.equal(getFailure(), first, 'same object — nothing subscribed should re-render')
})

test('a DIFFERENT failure replaces it rather than stacking', () => {
  raiseFailure('the vectorizer', 'Could not vectorize this image.', new Error('a'))
  raiseFailure('the uploader', 'Could not read that file.', new Error('b'))
  assert.equal(getFailure()?.what, 'the uploader')
})

test('dismissed means dismissed: the same failure never asks again', () => {
  raiseFailure('the vectorizer', 'Could not vectorize this image.', new Error('a'))
  dismissFailure()
  assert.equal(getFailure(), null)
  raiseFailure('the vectorizer', 'Could not vectorize this image.', new Error('a'))
  assert.equal(getFailure(), null, 'the answer was no — asking again is nagging')
})

test('a dismissal is about THAT failure, not about failures in general', () => {
  raiseFailure('the vectorizer', 'Could not vectorize this image.', new Error('a'))
  dismissFailure()
  raiseFailure('the uploader', 'Could not read that file.', new Error('b'))
  assert.equal(getFailure()?.what, 'the uploader')
})

test('a superseded question clears without being counted as a no', () => {
  raiseFailure('the vectorizer', 'Could not vectorize this image.', new Error('a'))
  clearFailure()
  assert.equal(getFailure(), null)
  raiseFailure('the vectorizer', 'Could not vectorize this image.', new Error('a'))
  assert.notEqual(getFailure(), null, 'it was never answered, so it may ask again')
})

test('subscribers hear every change, and unsubscribing stops that', () => {
  let beats = 0
  const off = subscribeFailure(() => beats++)
  raiseFailure('the vectorizer', 'Could not vectorize this image.', new Error('a'))
  assert.equal(beats, 1)
  raiseFailure('the vectorizer', 'Could not vectorize this image.', new Error('a'))
  assert.equal(beats, 1, 'a no-op raise must not wake the tree')
  dismissFailure()
  assert.equal(beats, 2)
  off()
  raiseFailure('the uploader', 'Could not read that file.', new Error('b'))
  assert.equal(beats, 2)
})

test('clearing or dismissing nothing is a no-op, not a notification', () => {
  let beats = 0
  subscribeFailure(() => beats++)
  clearFailure()
  dismissFailure()
  assert.equal(beats, 0)
})
