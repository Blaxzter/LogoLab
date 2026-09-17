// The session's error log — the part of a bug report nobody could have typed.
//
//   node --test test/error-log.test.ts
//
// This buffer exists because the error in front of you is usually the SYMPTOM:
// the worker that died and was restarted, the decode that quietly fell back, the
// promise nobody awaited. All of that lands in the console, which nobody opens
// and nobody can paste from a phone.
//
// Two ways it could fail silently, both pinned here. It could fill with fifty
// copies of one retrying error and push everything else out — so repeats
// collapse instead of accumulating. And it could carry the user's actual image
// into a public issue tracker, because an error message likes to quote the URL
// it failed on and in this app that URL is sometimes a `data:` URL holding the
// picture. A promise that the art never leaves the browser is only as good as
// the least careful string that gets appended to a report.

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { clearErrorLog, logError, recentErrors, redact } from '../src/lib/errorLog.ts'

beforeEach(() => clearErrorLog())

test('a fresh session has nothing to report', () => {
  assert.deepEqual(recentErrors(), [])
})

test('errors are kept oldest first, with their source', () => {
  logError('upload', new Error('decode failed'))
  logError('trace', new Error('worker died'))
  const log = recentErrors()
  assert.equal(log.length, 2)
  assert.equal(log[0].source, 'upload')
  assert.equal(log[0].message, 'Error: decode failed')
  assert.equal(log[1].source, 'trace')
  assert.equal(log[0].count, 1)
})

test('a repeat is counted, not appended — a retry loop must not flush the log', () => {
  logError('upload', new Error('decode failed'))
  for (let i = 0; i < 200; i++) logError('trace', new Error('worker died'))
  const log = recentErrors()
  assert.equal(log.length, 2, 'two distinct errors, however many times they happened')
  assert.equal(log[1].count, 200)
  assert.equal(log[0].source, 'upload', 'and the older, rarer one survived')
})

test('a repeat moves to the end: most recent is what a reader looks at first', () => {
  logError('a', new Error('first'))
  logError('b', new Error('second'))
  logError('a', new Error('first'))
  assert.deepEqual(
    recentErrors().map((e) => e.source),
    ['b', 'a'],
  )
})

test('the same message from two sources stays two entries', () => {
  logError('trace', new Error('aborted'))
  logError('sheet-tile', new Error('aborted'))
  assert.equal(recentErrors().length, 2)
})

test('the buffer is bounded — the oldest go first', () => {
  for (let i = 0; i < 100; i++) logError('trace', new Error(`failure ${i}`))
  const log = recentErrors()
  assert.ok(log.length <= 25, `kept ${log.length} entries`)
  assert.match(log[log.length - 1].message, /failure 99/, 'the newest is always there')
  assert.doesNotMatch(log[0].message, /failure 0$/, 'the oldest were dropped')
})

test('anything at all can be logged, including what was never an Error', () => {
  logError('worker', 'plain string')
  logError('worker', { code: 7 })
  logError('worker', undefined)
  const log = recentErrors()
  assert.equal(log[0].message, 'plain string')
  assert.equal(log[1].message, '{"code":7}')
  assert.equal(log[2].message, 'undefined')
})

test('a huge message is cut — one entry must not own the whole report', () => {
  logError('trace', new Error('x'.repeat(5000)))
  const [entry] = recentErrors()
  assert.ok(entry.message.length <= 320, `kept ${entry.message.length} chars`)
  assert.match(entry.message, /…$/)
})

test("the user's image is redacted out of a message, not carried into an issue", () => {
  const pixels = `data:image/png;base64,${'iVBORw0KGgoAAAANS'.repeat(40)}`
  logError('upload', new Error(`Failed to decode ${pixels}`))
  const [entry] = recentErrors()
  assert.doesNotMatch(entry.message, /iVBORw0KGgo/)
  assert.match(entry.message, /data:…/)
})

test('redact leaves ordinary text and short data-ish words alone', () => {
  assert.equal(redact('TypeError: x is not a function'), 'TypeError: x is not a function')
  assert.equal(redact('the data: flag'), 'the data: flag')
  assert.match(redact('fetch of blob:http://localhost/9c2f-ab failed'), /blob:…/)
})

test('the log is a copy — a report cannot mutate what it is describing', () => {
  logError('trace', new Error('worker died'))
  const first = recentErrors()
  first[0].message = 'tampered'
  assert.equal(recentErrors()[0].message, 'Error: worker died')
})
