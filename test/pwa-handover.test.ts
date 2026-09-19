// The update button has to end in a reload.
//
//   node --test test/pwa-handover.test.ts
//
// This is the bug that shipped: "A new version is ready. [Reload]" did nothing
// at all for the user it matters most to — the one on their first visit.
//
// The click cannot reload the page itself (that races the handover and lands
// back on the old build), so it asks the waiting worker to skip waiting and
// reloads on `controllerchange`. The guard on that handler kept a page from
// bouncing when the FIRST worker of all claims it — and it read a flag captured
// at boot. On a first visit the page is not controlled at boot; it becomes
// controlled seconds later when that first worker claims it. The flag never
// heard about it. So for the rest of that tab's life every handover looked like
// a first install, the reload was skipped, and the notice closed on nothing.
//
// The rules, all three of which are invisible in a screenshot:
//   • a first claim is not a reload,
//   • a handover IS one, however long ago the page was claimed,
//   • one the user asked for always is — even if the handover never lands.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { watchHandover, HANDOVER_GRACE_MS, type ControllerSource } from '../src/pwa/handover.ts'

/** A stand-in for `navigator.serviceWorker` we can drive by hand. */
function container(controlled: boolean) {
  const listeners: (() => void)[] = []
  const self = {
    controller: controlled ? worker() : null,
    addEventListener: (_type: 'controllerchange', fn: () => void) => void listeners.push(fn),
    /** The browser side: a worker activated and took the page over. */
    handOver() {
      self.controller = worker()
      for (const fn of listeners) fn()
    },
  }
  return self
}

/** A stand-in for a `ServiceWorker`, recording what the page asked it. */
function worker() {
  const sent: unknown[] = []
  return { sent, postMessage: (message: unknown) => void sent.push(message) }
}

/** Collects the grace-period callback instead of waiting three seconds for it. */
function pendingTimers() {
  const timers: { fn: () => void; ms: number }[] = []
  return {
    timers,
    schedule: (fn: () => void, ms: number) => void timers.push({ fn, ms }),
    /** Nothing took over in time. */
    fire: () => timers.forEach((t) => t.fn()),
  }
}

function setup(controlled: boolean) {
  const sw = container(controlled)
  const clock = pendingTimers()
  let reloads = 0
  const handover = watchHandover({
    container: sw as unknown as ControllerSource,
    reload: () => void reloads++,
    schedule: clock.schedule,
  })
  return { sw, clock, handover, reloads: () => reloads }
}

test('the first worker of all claims the page without bouncing the visitor', () => {
  const { sw, reloads } = setup(false)
  sw.handOver()
  assert.equal(reloads(), 0, 'a first install is not an update')
})

test('a handover AFTER that first claim still reloads', () => {
  const { sw, reloads } = setup(false)
  sw.handOver() // the first install claims the page
  sw.handOver() // an hour later, a new build takes over
  assert.equal(reloads(), 1, 'the bug: the boot-time flag said "never controlled" forever')
})

test('a handover on an already-controlled page reloads', () => {
  const { sw, reloads } = setup(true)
  sw.handOver()
  assert.equal(reloads(), 1)
})

test('the click asks the waiting build to take over, and lands on it', () => {
  const { sw, handover, reloads } = setup(true)
  const waiting = worker()

  handover.take(waiting)
  assert.deepEqual(waiting.sent, [{ type: 'SKIP_WAITING' }])
  assert.equal(reloads(), 0, 'reloading before the handover lands you back on the old build')

  sw.handOver()
  assert.equal(reloads(), 1)
})

test('a click on a page that was never controlled reloads all the same', () => {
  const { sw, handover, reloads } = setup(false)
  handover.take(worker())
  sw.handOver()
  assert.equal(reloads(), 1, 'the user asked; a first-claim exemption is not theirs to inherit')
})

test('a handover that never lands reloads anyway, rather than nothing at all', () => {
  const { clock, handover, reloads } = setup(true)
  handover.take(worker())
  assert.equal(clock.timers[0]?.ms, HANDOVER_GRACE_MS)
  clock.fire()
  assert.equal(reloads(), 1)
})

test('a stale notice — nothing waiting — still reloads on the click', () => {
  const { handover, reloads } = setup(true)
  handover.take(null)
  assert.equal(reloads(), 1)
})

test('the page reloads once, however many things say so', () => {
  const { sw, clock, handover, reloads } = setup(true)
  handover.take(worker())
  handover.take(worker()) // an impatient second click
  sw.handOver()
  sw.handOver() // a second tab's worker, another claim
  clock.fire()
  assert.equal(reloads(), 1)
})
