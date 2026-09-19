// The handover: a waiting build takes control of the page, and the page reloads
// onto it.
//
// Its own module, apart from the registration in register.ts, for the reason
// ui/tooltipPlace.ts is: register.ts is browser wiring and reads
// `import.meta.env`, which node cannot evaluate, so anything a test must reach
// has to be out of it. And this earns a test more than most things do — every
// way it can fail looks identical from the outside: a button that does nothing.
//
// Why the reload is not simply `location.reload()` on the click: the waiting
// worker has to take over FIRST. Reloading while the old worker is still in
// charge races the handover and lands the user back on the build they just
// asked to leave. So the click asks the worker to skip waiting, and the reload
// rides on `controllerchange` — with a timer underneath it, because a handover
// that never lands must not be the end of the road.

/** The half of a `ServiceWorker` this needs: something to ask. */
interface Skippable {
  postMessage: (message: unknown) => void
}

/** The half of `navigator.serviceWorker` this needs. */
export interface ControllerSource {
  readonly controller: Skippable | null
  addEventListener: (type: 'controllerchange', listener: () => void) => void
}

export interface HandoverDeps {
  container: ControllerSource
  reload: () => void
  /** Injected so a test doesn't have to sit through the grace period. */
  schedule?: (fn: () => void, ms: number) => void
}

/**
 * How long a handover the user ASKED for is given before the page reloads
 * anyway. Long enough that the ordinary path (activate, claim, reload) always
 * wins the race; short enough that a browser which drops the message costs a
 * few seconds rather than the whole point of the notice.
 */
export const HANDOVER_GRACE_MS = 3000

export interface Handover {
  /** Hand the page to the waiting build and reload onto it. */
  take: (waiting: Skippable | null) => void
}

export function watchHandover({ container, reload, schedule }: HandoverDeps): Handover {
  const later = schedule ?? ((fn: () => void, ms: number) => void setTimeout(fn, ms))

  // LIVE, not a snapshot. A first visit starts with no controller and gains one
  // the moment that first worker claims the page — so a flag captured at boot
  // says "there was never a controller" for the rest of the tab's life, and the
  // next handover, the one the user actually clicked for, is then mistaken for a
  // first install and skipped. That is the bug this module was extracted for.
  let controlled = Boolean(container.controller)
  // The user asked. Whatever the controller history says, this ends in a reload.
  let asked = false
  let reloading = false

  const go = () => {
    if (reloading) return
    reloading = true
    reload()
  }

  container.addEventListener('controllerchange', () => {
    const replaced = controlled
    controlled = true
    // The very first worker claims the page as soon as it activates. Reloading
    // THEN would bounce every first-time visitor for no reason.
    if (replaced || asked) go()
  })

  return {
    take(waiting) {
      asked = true
      // Nothing waiting — the notice was stale, or the worker went away. A plain
      // reload is then the honest thing: it is what the button promised.
      if (!waiting) {
        go()
        return
      }
      waiting.postMessage({ type: 'SKIP_WAITING' })
      // The backstop. If the handover lands, `controllerchange` has already
      // reloaded and this finds `reloading` set; if it never lands, the user
      // still gets the reload they clicked for instead of a dead button.
      later(go, HANDOVER_GRACE_MS)
    },
  }
}
