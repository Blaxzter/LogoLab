// Service-worker registration and the small app-wide store the UI reads from it.
//
// Updates prompt rather than auto-reload, so a new build never interrupts a
// trace in flight: a new worker installs, waits, and the page offers a reload.

import { create } from 'zustand'
import { flushSession } from '../lib/persist/session'
import { watchHandover, type Handover } from './handover'

/** The `beforeinstallprompt` event, which TypeScript's DOM lib doesn't model. */
interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

interface PwaState {
  /** A newer build is installed and waiting for the page to hand over. */
  needRefresh: boolean
  /** The first install finished: everything the app needs is now cached. */
  offlineReady: boolean
  /** The waiting build was asked to take over; the reload is on its way. */
  updating: boolean
  /** The browser offered an install; null when it hasn't (or already did). */
  installPrompt: InstallPromptEvent | null
  /** Take the waiting build and reload onto it. */
  update: () => void
  /** Let the user wave the notice away without acting on it. */
  dismiss: () => void
  /** Show the browser's install dialog. */
  install: () => Promise<void>
}

export const usePwa = create<PwaState>((set, get) => ({
  needRefresh: false,
  offlineReady: false,
  updating: false,
  installPrompt: null,

  update: () => {
    // Write out anything still sitting in a debounce before the page goes.
    flushSession()
    // No service worker (dev, unsupported, blocked): nothing to hand over.
    if (!handover) {
      location.reload()
      return
    }
    // Keep the notice up until the page actually reloads; if the handover
    // stalls, it is the only control that can apply the update.
    set({ updating: true })
    handover.take(registration?.waiting ?? null)
  },

  dismiss: () => set({ needRefresh: false, offlineReady: false }),

  install: async () => {
    const prompt = get().installPrompt
    if (!prompt) return
    // One shot: the event can't be re-prompted, so it goes whatever the answer.
    set({ installPrompt: null })
    try {
      await prompt.prompt()
      await prompt.userChoice
    } catch {
      /* dismissed, or the browser withdrew it */
    }
  },
}))

let registration: ServiceWorkerRegistration | null = null
let handover: Handover | null = null

/** How often an open tab re-checks for a new build. */
const UPDATE_INTERVAL_MS = 60 * 60 * 1000

export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return

  if (!import.meta.env.PROD) {
    // Unregister any worker left by a production build on this host; it would
    // keep serving its precached bundle over the dev server.
    void navigator.serviceWorker.getRegistrations().then((regs) => {
      for (const reg of regs) void reg.unregister()
    })
    return
  }

  // Register after `load` so the precache does not compete with the first
  // render. Keep the readyState check: this runs after main.tsx awaits the
  // stored session, and `load` often fires during that await, so a bare
  // listener would never run and the worker would never register.
  if (document.readyState === 'complete') register()
  else window.addEventListener('load', register, { once: true })

  function register() {
    void (async () => {
      try {
        const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' })
        registration = reg

        // Installed before this tab opened and already waiting.
        if (reg.waiting && navigator.serviceWorker.controller) {
          usePwa.setState({ needRefresh: true })
        }

        reg.addEventListener('updatefound', () => {
          const installing = reg.installing
          if (!installing) return
          installing.addEventListener('statechange', () => {
            if (installing.state !== 'installed') return
            // With a controller this is an update; without, the first install.
            if (navigator.serviceWorker.controller) usePwa.setState({ needRefresh: true })
            else usePwa.setState({ offlineReady: true })
          })
        })

        setInterval(() => void reg.update(), UPDATE_INTERVAL_MS)
      } catch {
        /* blocked or plain http: the app works, just not offline */
      }
    })()
  }

  // Decides when a controller change reloads the page (see handover.ts).
  handover = watchHandover({
    container: navigator.serviceWorker,
    reload: () => location.reload(),
  })

  window.addEventListener('beforeinstallprompt', (event) => {
    // Keep the event for the app's own install button instead of Chrome's infobar.
    event.preventDefault()
    usePwa.setState({ installPrompt: event as InstallPromptEvent })
  })

  window.addEventListener('appinstalled', () => usePwa.setState({ installPrompt: null }))
}
