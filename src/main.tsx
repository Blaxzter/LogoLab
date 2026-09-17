import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import { App } from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { useStore } from './store'
import { provideCrashContext } from './lib/crashContext'
import {
  flushSession,
  loadSession,
  requestPersistentStorage,
} from './lib/persist/session'
import { registerServiceWorker } from './pwa/register'

/**
 * How long the first paint will wait for the stored session.
 *
 * Reading it before rendering is what makes a reload look like nothing happened:
 * hydrating afterwards would paint the empty drop zone first and then snap to the
 * user's logo. The read is a handful of IndexedDB keys and normally lands inside
 * a frame — but IndexedDB can stall behind another tab's upgrade or a cold
 * profile, and a blank page is a far worse failure than a late restore, so the
 * wait is capped. Past the cap the app boots empty and the session is simply not
 * restored; nothing is deleted, so the next reload can still bring it back.
 */
const RESTORE_BUDGET_MS = 2000

async function boot() {
  const session = await Promise.race([
    loadSession().catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), RESTORE_BUDGET_MS)),
  ])
  if (session) useStore.getState().hydrate(session)

  // "Nothing is lost" only holds while the browser keeps the data; without this
  // the origin sits in the evictable pool and a low-disk device can clear it.
  requestPersistentStorage()

  // Writes are debounced (a node drag would otherwise store the document per
  // frame), so a tab closed mid-gesture could lose the last few hundred ms. Both
  // events fire on a real close on desktop and on a backgrounded tab on mobile —
  // which is where an app gets discarded without any further warning.
  addEventListener('pagehide', flushSession)
  addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSession()
  })

  // Registration itself waits for `window.load` — the worker's precache fetch is
  // a few megabytes and has no business competing with the first paint.
  registerServiceWorker()

  // What a crash report says about the image, wherever in the app the crash
  // happens (see lib/crashContext). Read through `getState` so it reports the
  // logo that is loaded AT CRASH TIME, not the empty one this boot started with.
  provideCrashContext('image', () => {
    const { logo, assetKey } = useStore.getState()
    if (!logo.src) return { loaded: false }
    return {
      // The pixels themselves are never in here: a bug report carries the SHAPE
      // of the art, not the art. It is the user's logo, and it is often nobody
      // else's to see.
      width: logo.naturalWidth,
      height: logo.naturalHeight,
      type: logo.mime,
      isSvg: logo.isSvg,
      svgChars: logo.svgText?.length ?? null,
      edited: Boolean(logo.src && logo.src !== logo.originalSrc),
      assetKey,
    }
  })

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      {/*
       * The last resort, under everything. The per-route boundaries in App.tsx
       * cover the panels; this one covers what is outside them — the header, the
       * sidebar, the router itself — where a throw would otherwise blank the page
       * with no way back but a reload the user has to think of on their own.
       */}
      <ErrorBoundary what="LogoLab" kind="app">
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </ErrorBoundary>
    </StrictMode>,
  )
}

void boot()
