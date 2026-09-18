import { lazy, Suspense, useEffect, useState } from 'react'
import { Bug, Loader2, Menu, SlidersHorizontal, X } from 'lucide-react'
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { useLogo, useStore } from './store'
import { useActiveTab } from './hooks/useActiveTab'
import { useLiveFavicon } from './hooks/useLiveFavicon'
import { Sidebar, MobileSidebarDrawer } from './components/Sidebar'
import { ErrorBoundary } from './components/ErrorBoundary'
import { ReportIssueLink } from './components/ReportIssue'
import { AgentSetupButton } from './components/AgentSetup'
import { AppMenu } from './components/AppMenu'
import { Toasts } from './components/Toasts'
import { SavedChip } from './components/SavedChip'
import { InstallAppButton } from './components/PwaPrompts'
import { LabPopover } from './components/LabPopover'
import { SupportPopover } from './components/SupportPopover'
import { ThemeToggleButton } from './components/ThemeToggle'
import { TABS, REPO_URL, GithubMark } from './components/navItems'
import { UploadDropzone } from './components/UploadDropzone'
import { TipLabel, Tooltip } from './components/ui/Tooltip'
import { TryExampleButton } from './components/ExamplesDialog'
import { PreviewGrid } from './components/PreviewGrid'
import CleanupPanel from './components/panels/CleanupPanel'
import ExportPanel from './components/panels/ExportPanel'
import Impressum from './components/legal/Impressum'
import Datenschutz from './components/legal/Datenschutz'
import { LegalFooter } from './components/legal/LegalFooter'

/**
 * The vectorizer's labs (see LAB_VIEWS in components/navItems). Lazy, every one of
 * them: each pulls in the devtest scoring modules and traces a whole corpus, and none
 * of that has any business in the bundle a normal user downloads to crop a logo. They
 * were separate Vite HTML entries for exactly this reason — React.lazy is what keeps
 * that isolation now that they're routes.
 */
/**
 * The SVG editor. Lazy for the same reason the labs are: it is a whole vector
 * authoring tool — canvas, shape builders, path surgery — and none of it belongs
 * in the bundle someone downloads to preview a logo on a phone mockup.
 */
const EditorPanel = lazy(() => import('./components/panels/EditorPanel'))

/**
 * The two tabs that carry the TRACER. Lazy for the same reason, and it is the
 * single biggest thing in the first load: `src/lib/trace` is 144 kB of the entry
 * chunk, and it arrives only because these two routes were imported eagerly —
 * Preview, the landing tab, was paying for a vectorizer it never calls. Measured
 * on the whole entry chunk: 893 → 425 kB raw, 287 → 132 kB gzip. The cost is one
 * Suspense fallback the first time either tab is opened; they share the trace
 * chunk, so opening the second is free.
 */
const VectorizePanel = lazy(() => import('./components/panels/VectorizePanel'))
const SheetPanel = lazy(() => import('./components/panels/SheetPanel'))

const LabsIndex = lazy(() => import('./components/labs/LabsIndex'))
const PipelineLab = lazy(() => import('./components/labs/PipelineLab'))
const AbLab = lazy(() => import('./components/labs/AbLab'))
// The Workbench asks ONE question — "is the trace correct against the art that made the pixels?" —
// of a switchable corpus. What can't be asked of every corpus lives in its own lab: raster-only art
// in the Gallery (just look) and Feature A/B (compare revisions), potrace vs crisp in EngineLab.
const Workbench = lazy(() => import('./components/labs/workbench/Workbench'))
const GalleryLab = lazy(() => import('./components/labs/GalleryLab'))
const EngineLab = lazy(() => import('./components/labs/EngineLab'))
const ProfilerLab = lazy(() => import('./components/labs/ProfilerLab'))

function LabLoading() {
  return (
    <div className="flex items-center justify-center gap-2 py-24 text-sm text-muted">
      <Loader2 size={16} className="animate-spin text-accent" />
      Loading the harness…
    </div>
  )
}

/** The same wait, worded for a normal tab — "the harness" is lab language. */
function PanelLoading({ what }: { what: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-24 text-sm text-muted">
      <Loader2 size={16} className="animate-spin text-accent" />
      Loading {what}…
    </div>
  )
}

function Header({ onOpenMenu }: { onOpenMenu: () => void }) {
  const logo = useLogo()
  const clearLogo = useStore((s) => s.clearLogo)
  const tab = useActiveTab()
  const activeLabel = TABS.find((t) => t.id === tab)?.label ?? ''

  return (
    /*
     * A GRID, not a flex row with justify-between.
     *
     * The tab nav is the thing people aim at, so its position must not be a
     * function of what happens to be beside it. Under justify-between it was: the
     * right cluster is much wider than the wordmark, which pushed the nav ~135px
     * left of centre, and anything that changed the cluster's width — the Saved
     * chip going from "Saving…" to "Saved 4 min ago", a Clear button appearing —
     * slid the whole nav sideways under the cursor.
     *
     * Equal 1fr side tracks put the auto-width middle track exactly in the centre
     * and keep it there no matter what either side does. When a side genuinely
     * outgrows its share the track grows and the nav drifts, which is the old
     * behaviour as a graceful floor rather than the normal case.
     */
    <header className="grid h-14 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-2 border-b border-line bg-surface px-3 sm:px-4">
      <div className="flex min-w-0 items-center gap-2.5">
        <BrandMark />
        {/* min-w-0 + truncate so a tight phone width shrinks the wordmark instead
            of forcing the whole header (and page) wider than the viewport. */}
        <div className="min-w-0 leading-none">
          <div className="truncate text-[0.95rem] font-bold tracking-tight text-ink">LogoLab</div>
          {/* Below lg the inline tab nav is hidden, so echo the active tab here to
              keep a location cue; at lg+ the static tagline returns. */}
          <div className="truncate text-[0.68rem] text-muted">
            <span className="lg:hidden">{activeLabel}</span>
            <span className="hidden lg:inline">preview · vectorize · export</span>
          </div>
        </div>
      </div>

      {/*
       * Desktop tab nav — the hamburger replaces it below lg.
       *
       * lg, not md: at 768 the nav (599px) plus the right cluster overflowed the
       * header by ~270px, which ate the wordmark entirely and pushed the last
       * icons off the right edge. That was true before the Saved chip and the
       * chip made it worse. A tablet gets the menu, which holds every tab anyway.
       */}
      <nav className="hidden shrink-0 rounded-lg bg-surface-3 p-0.5 lg:flex">
        {TABS.map((t) => (
          <NavLink
            key={t.id}
            to={`/${t.id}`}
            className={({ isActive }) =>
              `flex h-8 items-center gap-1.5 rounded-[12px] px-3 text-sm font-medium transition-all ${
                isActive ? 'bg-surface text-ink shadow-xs' : 'text-muted hover:text-ink-2'
              }`
            }
          >
            {t.icon}
            {t.label}
          </NavLink>
        ))}
      </nav>

      {/* Right cluster — its contents move into AppMenu below lg. Justified to
          the end so the icons stay put while the Saved chip's label changes
          width beside them.

          Every tooltip in here is `side="bottom"`. There is no room above a
          control that sits 8px from the top of the viewport, and the default
          `top` would land the bubble on the icon it is describing. Tooltip
          flips on its own now, but saying it here means the placement is the
          intent rather than a fallback being relied on. */}
      <div className="flex items-center justify-end gap-3">
        <div className="hidden items-center gap-3 lg:flex">
          {logo.src && (
            <Tooltip label="Clear the loaded logo" side="bottom">
              <button
                onClick={clearLogo}
                aria-label="Clear logo"
                className="btn btn-ghost h-8 gap-1.5 px-2 text-xs"
              >
                <X size={14} />
                {/* Label only where the row has room for it — the nav's centring
                    budget is this cluster's width. */}
                <span className="hidden 2xl:inline">Clear</span>
              </button>
            </Tooltip>
          )}
          {/* When the session was last written down. Replaces the old restore
              BANNER, which cost every page a strip of vertical space to say
              something that belongs in the title bar. */}
          <SavedChip />
          <div className="flex items-center gap-1">
            {/* LogoLab's MCP server. First in the cluster because it is a product
                feature, not a meta affordance like the three that follow — and
                because it has no other desktop home (the mobile menu has a row). */}
            {/* Only rendered while the browser is offering an install. */}
            <InstallAppButton />
            <AgentSetupButton variant="icon" />
            <ThemeToggleButton />
            {/* One click, no popover: the prefilled issue opens with whatever
                the studios are working on already in it (components/ReportIssue).
                It keeps the bug glyph — the labs moved to a flask, because two
                bugs in one header would have meant neither of them said
                anything, and "report a problem" has the better claim to it. */}
            <ReportIssueLink
              subject={{ what: 'LogoLab', kind: 'problem' }}
              tip={
                <TipLabel
                  title="Report a problem"
                  detail="Opens a prefilled GitHub issue with your settings and this build attached. Nothing is sent until you post it."
                />
              }
              icon={<Bug size={18} />}
              showExternal={false}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink"
            >
              <span className="sr-only">Report a problem</span>
            </ReportIssueLink>
            <LabPopover />
            <SupportPopover />
            <Tooltip label="Source on GitHub" side="bottom">
              <a
                href={REPO_URL}
                target="_blank"
                rel="noreferrer"
                className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink"
              >
                <GithubMark />
                <span className="sr-only">GitHub repository</span>
              </a>
            </Tooltip>
          </div>
        </div>

        {/* Menu trigger (~44px target). */}
        <button
          type="button"
          onClick={onOpenMenu}
          aria-label="Open menu"
          className="btn btn-ghost h-10 w-10 shrink-0 px-0 lg:hidden"
        >
          <Menu size={20} />
        </button>
      </div>
    </header>
  )
}

function BrandMark() {
  return (
    <svg width="30" height="30" viewBox="0 0 64 64" fill="none" aria-hidden>
      {/* Chip relit per theme so it doesn't merge into the dark header. */}
      <rect x="2" y="2" width="60" height="60" rx="16" style={{ fill: 'var(--color-brand-chip)' }} />
      <circle cx="32" cy="32" r="15" stroke="#fff" strokeWidth="3.2" />
      <circle cx="32" cy="32" r="6" fill="#6366f1" />
    </svg>
  )
}

/**
 * Mobile-only entry to load a logo on the Preview tab before one exists. On
 * desktop the sidebar's Logo section covers this; on phones the sidebar is a
 * drawer that only opens *after* a logo is loaded, so without this card there'd
 * be no way to add one from Preview. Cleanup, Vectorize & Export all render their
 * own full-width upload empty states, so only Preview needs it.
 */
function MobileLogoIntro() {
  return (
    <div className="border-b border-line bg-surface p-4 md:hidden">
      <h2 className="text-[0.7rem] font-bold uppercase tracking-wider text-faint">Logo</h2>
      <p className="mb-3 mt-1 text-sm text-muted">Add a logo to preview and export it.</p>
      <UploadDropzone />
      <div className="mt-2">
        <TryExampleButton />
      </div>
    </div>
  )
}

export function App() {
  useLiveFavicon()
  const { pathname } = useLocation()
  const tab = useActiveTab()
  const logo = useLogo()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  // The appearance controls only exist on Preview & Export. On phones they live
  // in a slide-over that we only surface once a logo is loaded (nothing to tweak
  // before then) — matches the desktop sidebar, which is also logo-driven.
  const showStyling = tab === 'preview' || tab === 'export'
  const hasLogo = Boolean(logo.src)

  // The full-height studios (Cleanup/Vectorize) carry the legal links in their
  // own desktop status bar, so on desktop we drop the bottom footer there — it
  // would otherwise add a second scroll past an already full-height tool. On
  // mobile those studios have no status bar, so the footer stays (scrolls in).
  const isStudio =
    tab === 'cleanup' || tab === 'vectorize' || tab === 'sheet' || tab === 'editor'

  // Close any open overlay on navigation (covers the back button, not just the
  // in-menu links), and drop the appearance drawer when its trigger disappears.
  useEffect(() => {
    setMenuOpen(false)
    if (!showStyling || !hasLogo) setDrawerOpen(false)
  }, [tab, showStyling, hasLogo])

  // Legal pages (Impressum / Datenschutz) render in their own standalone shell —
  // no studio sidebar or appearance FAB — so the long-form text reads cleanly.
  if (pathname === '/impressum' || pathname === '/datenschutz') {
    return (
      <Routes>
        <Route path="/impressum" element={<Impressum />} />
        <Route path="/datenschutz" element={<Datenschutz />} />
      </Routes>
    )
  }

  // The labs keep the app header (they're part of the app, not a dev sidecar) but drop
  // the studio sidebar and the appearance FAB: they carry their own toolbar, and they
  // want the full width for the panel strips.
  if (pathname.startsWith('/labs')) {
    return (
      <div className="flex h-full flex-col overflow-x-hidden">
        <Header onOpenMenu={() => setMenuOpen(true)} />
        <AppMenu open={menuOpen} onClose={() => setMenuOpen(false)} />
        <Toasts />
        <main className="min-h-0 flex-1 overflow-y-auto bg-bg">
          {/* One boundary for all of them — a lab is a harness, and the pathname
              resets it so walking to another lab clears the last one's crash. */}
          <ErrorBoundary what="this lab" resetKey={pathname}>
            <Suspense fallback={<LabLoading />}>
              <Routes>
                <Route path="/labs" element={<LabsIndex />} />
                <Route path="/labs/pipeline" element={<PipelineLab />} />
                <Route path="/labs/ab" element={<AbLab />} />
                <Route path="/labs/workbench" element={<Workbench />} />
                <Route path="/labs/gallery" element={<GalleryLab />} />
                <Route path="/labs/scoreboard" element={<EngineLab />} />
                <Route path="/labs/profiler" element={<ProfilerLab />} />
                {/* Old routes, kept as deep-links so bookmarks survive. `golden` has no view any
                    more — the regression gate still runs in CI, but Feature A/B already shows those
                    exact fixtures, which is where you'd go to look at them. */}
                <Route path="/labs/truth" element={<Navigate to="/labs/workbench?corpus=tier0" replace />} />
                <Route path="/labs/logos" element={<Navigate to="/labs/workbench?corpus=logos" replace />} />
                <Route path="/labs/eval" element={<Navigate to="/labs/scoreboard" replace />} />
                <Route path="/labs/golden" element={<Navigate to="/labs/ab" replace />} />
                <Route path="*" element={<Navigate to="/labs" replace />} />
              </Routes>
            </Suspense>
          </ErrorBoundary>
        </main>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-x-hidden">
      <Header onOpenMenu={() => setMenuOpen(true)} />
      <AppMenu open={menuOpen} onClose={() => setMenuOpen(false)} />
      <div className="flex min-h-0 flex-1">
        {/* Inline column on desktop; a drawer (below) replaces it on mobile.
            Hidden on the Editor tab: that tool edits its OWN document, not the
            app's working logo, so a logo rail there is both misleading and a
            320px bite out of the canvas. */}
        {tab !== 'editor' && <Sidebar className="hidden md:block" />}
        {/* flex column + footer with mt-auto = the footer rides below the
            content instead of being a bar pinned to the viewport: it rests at
            the bottom on short pages and scrolls out of view under tall ones
            (incl. the full-height studio tabs, whose shrink-0 root keeps the
            whole area and pushes the footer just past the fold). */}
        <main
          className={`flex min-w-0 flex-1 flex-col overflow-y-auto bg-bg ${
            showStyling && hasLogo ? 'max-md:pb-24' : ''
          }`}
        >
          {tab === 'preview' && !hasLogo && <MobileLogoIntro />}
          {/*
           * ONE BOUNDARY PER PANEL (components/ErrorBoundary). A throw anywhere in
           * a render path used to unmount the whole tree and leave a blank page;
           * per-route means a crash in the vectorizer costs you the vectorizer —
           * the header, the loaded logo and every other tab keep working, and the
           * panel can be remounted clean without a reload.
           *
           * The boundary sits OUTSIDE the Suspense on purpose. A lazy chunk that
           * fails to load (a deploy replaced it under an open tab, or the network
           * dropped) rejects into the nearest boundary ABOVE its Suspense — put it
           * inside and the rejection sails past to the root and takes the whole
           * app with it, which is what used to happen to the tab that failed.
           *
           * `resetKey` is NOT belt and braces. The router renders the matched
           * route's element in the same position every time, so React reuses ONE
           * boundary instance across all six and merely updates its props — a
           * crash in Preview followed by a click on Cleanup showed Cleanup the
           * preview's crash screen. The pathname is what ends the crash.
           */}
          <Routes>
            <Route
              path="/preview"
              element={
                <ErrorBoundary what="the preview" resetKey={pathname}>
                  <PreviewGrid />
                </ErrorBoundary>
              }
            />
            <Route
              path="/cleanup"
              element={
                <ErrorBoundary what="cleanup" resetKey={pathname}>
                  <CleanupPanel />
                </ErrorBoundary>
              }
            />
            <Route
              path="/vectorize"
              element={
                <ErrorBoundary what="the vectorizer" resetKey={pathname}>
                  <Suspense fallback={<PanelLoading what="the vectorizer" />}>
                    <VectorizePanel />
                  </Suspense>
                </ErrorBoundary>
              }
            />
            <Route
              path="/editor"
              element={
                <ErrorBoundary what="the editor" resetKey={pathname}>
                  <Suspense fallback={<PanelLoading what="the editor" />}>
                    <EditorPanel />
                  </Suspense>
                </ErrorBoundary>
              }
            />
            <Route
              path="/sheet"
              element={
                <ErrorBoundary what="the icon sheet" resetKey={pathname}>
                  <Suspense fallback={<PanelLoading what="the icon sheet" />}>
                    <SheetPanel />
                  </Suspense>
                </ErrorBoundary>
              }
            />
            <Route
              path="/export"
              element={
                <ErrorBoundary what="export" resetKey={pathname}>
                  <ExportPanel />
                </ErrorBoundary>
              }
            />
            {/* Root and any unknown path land on Preview. */}
            <Route path="/" element={<Navigate to="/preview" replace />} />
            <Route path="*" element={<Navigate to="/preview" replace />} />
          </Routes>
          <LegalFooter className={`mt-auto ${isStudio ? 'md:hidden' : ''}`} />
        </main>
      </div>

      {/* Mobile appearance drawer + the button that opens it. Only on the tabs
          that have controls, and only once there's a logo to customize. */}
      {showStyling && (
        <MobileSidebarDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
      )}
      <Toasts />
      {showStyling && hasLogo && (
        <Tooltip label="Customize appearance">
          <button
            onClick={() => setDrawerOpen(true)}
            className="btn btn-primary bottom-safe fixed right-5 z-30 h-12 gap-2 rounded-full px-5 shadow-lg md:hidden"
          >
            <SlidersHorizontal size={18} />
            Customize
          </button>
        </Tooltip>
      )}
    </div>
  )
}
