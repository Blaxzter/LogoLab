import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import { App } from './App'
import { ErrorBoundary } from './components/report/ErrorBoundary'
import { useStore } from './state/store'
import { installErrorLog } from './lib/report/errorLog'
import { provideReportContext } from './lib/report/reportContext'
import { flushSession, loadSession, requestPersistentStorage } from './lib/persist/session'
import { registerServiceWorker } from './pwa/register'

/**
 * How long the first paint waits for the stored session. The session is read
 * before rendering so a reload doesn't flash the empty state first. IndexedDB
 * can stall, so the wait is capped; past it the app boots empty without
 * deleting anything, and the next reload can still restore the session.
 */
const RESTORE_BUDGET_MS = 2000

async function boot() {
  // First, so errors thrown during boot are logged too.
  installErrorLog()

  const session = await Promise.race([
    loadSession().catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), RESTORE_BUDGET_MS)),
  ])
  if (session) useStore.getState().hydrate(session)

  // Without persistent storage the browser may evict the session under disk pressure.
  requestPersistentStorage()

  // Writes are debounced, so flush pending ones when the tab is closed or
  // backgrounded (mobile may discard a background tab without warning).
  addEventListener('pagehide', flushSession)
  addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSession()
  })

  // Registration waits for `window.load` so the precache fetch doesn't compete
  // with the first paint.
  registerServiceWorker()

  // Image context for issue reports (lib/report/reportContext), read via `getState` so
  // it describes the logo loaded at report time.
  provideReportContext('image', () => {
    const { logo, assetKey } = useStore.getState()
    if (!logo.src) return { loaded: false }
    return {
      // Never include the pixels: a report describes the art's shape, not the
      // user's art itself.
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
       * Last-resort boundary for everything outside the per-route boundaries in
       * App.tsx (header, sidebar, router), where a throw would blank the page.
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
