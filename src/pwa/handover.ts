// The handover: a waiting build takes control of the page and the page reloads
// onto it. Kept apart from register.ts (which reads `import.meta.env`) so node
// tests can reach it.
//
// Don't just call `location.reload()` on click: reloading before the new worker
// takes control races the handover and lands back on the old build. The click
// asks the worker to skip waiting and the reload fires on `controllerchange`,
// with a grace timer as a backstop.
//
// Rules: the very first claim of a page is not a reload; any later handover
// is; and one the user asked for always ends in a reload.

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
 * How long a user-requested handover may take before the page reloads anyway.
 * Long enough for the normal activate/claim path to win.
 */
export const HANDOVER_GRACE_MS = 3000

export interface Handover {
  /** Hand the page to the waiting build and reload onto it. */
  take: (waiting: Skippable | null) => void
}

export function watchHandover({ container, reload, schedule }: HandoverDeps): Handover {
  const later = schedule ?? ((fn: () => void, ms: number) => void setTimeout(fn, ms))

  // Tracked live, not captured once at boot: a first visit gains a controller
  // later, and a boot-time flag would mistake every later handover for a first
  // install and skip the reload.
  let controlled = Boolean(container.controller)
  // The user asked: this ends in a reload regardless of controller history.
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
    // Don't reload on the first claim, or every first-time visitor bounces.
    if (replaced || asked) go()
  })

  return {
    take(waiting) {
      asked = true
      // Nothing waiting (stale notice): just reload.
      if (!waiting) {
        go()
        return
      }
      waiting.postMessage({ type: 'SKIP_WAITING' })
      // Backstop: if the handover never lands, reload anyway.
      later(go, HANDOVER_GRACE_MS)
    },
  }
}
