// Service-worker registration and the small amount of state the UI needs from it.
//
// A standalone zustand store, like src/theme.ts and for the same reason: it is
// app-wide, it is tiny, and it has nothing to do with the working session.
//
// The update policy is PROMPT, not auto-reload. A new build reaching the browser
// mid-trace and swapping the code out would abort work in flight; the session is
// persisted now, but a trace that was 8 seconds in is still 8 seconds lost. So a
// new worker installs, waits, and the page offers a reload.

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
    // No worker in charge of this page (dev, unsupported, blocked): there is no
    // handover to wait for, so the button means what it says.
    if (!handover) {
      location.reload()
      return
    }
    // The notice STAYS until the page actually goes. Clearing it here took the
    // only control that applies the update away from anyone whose handover did
    // not land, which is how a stuck update looked like a button doing nothing.
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

/** How often an open tab re-checks for a new build. Long: this app is a tool
 *  someone keeps open for an afternoon, not a feed. */
const UPDATE_INTERVAL_MS = 60 * 60 * 1000

export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return

  if (!import.meta.env.PROD) {
    // A worker registered by a production build on the same host (localhost, or
    // the branded dev hostname after testing a preview build) would keep serving
    // its precached bundle over the dev server, and the symptom — edits that
    // don't show up — costs an hour to recognise. So dev actively clears them.
    void navigator.serviceWorker.getRegistrations().then((regs) => {
      for (const reg of regs) void reg.unregister()
    })
    return
  }

  // After `load`, so registering never competes with the first render for
  // bandwidth: the precache fetch is a few megabytes.
  //
  // The readyState check is not belt-and-braces. This runs from main.tsx AFTER
  // the boot gate has awaited the stored session out of IndexedDB, and `load`
  // routinely fires during that await — a bare `addEventListener('load', …)`
  // here attaches to an event that has already happened, and the worker is
  // silently never registered. (Observed: zero registrations, on a page whose
  // install prompt had already fired.)
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
            // A controller already running means this is an UPDATE; none means
            // this was the first install, and the app is now offline-capable.
            if (navigator.serviceWorker.controller) usePwa.setState({ needRefresh: true })
            else usePwa.setState({ offlineReady: true })
          })
        })

        setInterval(() => void reg.update(), UPDATE_INTERVAL_MS)
      } catch {
        /* blocked, unsupported, or served over plain http — the app still works,
           it just isn't installable or offline-capable */
      }
    })()
  }

  // Who is in charge of this page, and what a change of hands means. See
  // pwa/handover.ts — the rule it keeps (a first claim is not a reload, a
  // handover is, and one the user asked for always is) is the whole reason the
  // update button works.
  handover = watchHandover({
    container: navigator.serviceWorker,
    reload: () => location.reload(),
  })

  window.addEventListener('beforeinstallprompt', (event) => {
    // Keep the event: without preventDefault Chrome shows its own mini-infobar,
    // and the event can't be replayed later from a button.
    event.preventDefault()
    usePwa.setState({ installPrompt: event as InstallPromptEvent })
  })

  window.addEventListener('appinstalled', () => usePwa.setState({ installPrompt: null }))
}
