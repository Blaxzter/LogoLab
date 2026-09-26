import { lazy, Suspense, useEffect, useState } from 'react'
import { Bug, Loader2, Menu, SlidersHorizontal, X } from 'lucide-react'
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { useLogo, useStore } from './state/store'
import { useActiveTab } from './hooks/useActiveTab'
import { useLiveFavicon } from './hooks/useLiveFavicon'
import { useMediaQuery } from './hooks/useIsMobile'
import { Sidebar, MobileSidebarDrawer } from './components/shell/Sidebar'
import { ErrorBoundary } from './components/report/ErrorBoundary'
import { ReportDialog } from './components/report/ReportDialog'
import { AgentSetupButton } from './components/shell/AgentSetup'
import { AppMenu } from './components/shell/AppMenu'
import { Toasts } from './components/shell/Toasts'
import { SavedChip } from './components/shell/SavedChip'
import { InstallAppButton } from './components/shell/PwaPrompts'
import { LabPopover } from './components/shell/LabPopover'
import { SupportPopover } from './components/shell/SupportPopover'
import { ThemeToggleButton } from './components/shell/ThemeToggle'
import { TABS, REPO_URL, GithubMark } from './components/shell/navItems'
import { UploadDropzone } from './components/intake/UploadDropzone'
import { TipLabel, Tooltip } from './components/ui/Tooltip'
import { TryExampleButton } from './components/intake/ExamplesDialog'
import { PreviewGrid } from './components/panels/PreviewGrid'
import CleanupPanel from './components/panels/CleanupPanel'
import ExportPanel from './components/panels/ExportPanel'
import Impressum from './components/legal/Impressum'
import Datenschutz from './components/legal/Datenschutz'
import { LegalFooter } from './components/legal/LegalFooter'

// Heavy routes are lazy so the landing bundle stays small: the SVG editor, the
// two tabs that pull in the tracer (they share its chunk), and the labs, which
// also pull in the bench scoring modules.
const EditorPanel = lazy(() => import('./components/panels/EditorPanel'))

const VectorizePanel = lazy(() => import('./components/panels/VectorizePanel'))
const SheetPanel = lazy(() => import('./components/panels/SheetPanel'))

const LabsIndex = lazy(() => import('./components/labs/LabsIndex'))
const PipelineLab = lazy(() => import('./components/labs/PipelineLab'))
const AbLab = lazy(() => import('./components/labs/AbLab'))
// Workbench scores traces against their source art over a switchable corpus;
// raster-only art lives in the Gallery, revision comparison in Feature A/B.
const Workbench = lazy(() => import('./components/labs/workbench/Workbench'))
const GalleryLab = lazy(() => import('./components/labs/GalleryLab'))
const ProfilerLab = lazy(() => import('./components/labs/ProfilerLab'))

function LabLoading() {
  return (
    <div className="flex items-center justify-center gap-2 py-24 text-sm text-muted">
      <Loader2 size={16} className="animate-spin text-accent" />
      Loading the harness…
    </div>
  )
}

/** Loading fallback for a normal tab. */
function PanelLoading({ what }: { what: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-24 text-sm text-muted">
      <Loader2 size={16} className="animate-spin text-accent" />
      Loading {what}…
    </div>
  )
}

function Header({ onOpenMenu, onReport }: { onOpenMenu: () => void; onReport: () => void }) {
  const logo = useLogo()
  const clearLogo = useStore((s) => s.clearLogo)
  const tab = useActiveTab()
  const activeLabel = TABS.find((t) => t.id === tab)?.label ?? ''
  // Between md and lg the tabs are icon-only and need a tooltip. Must match the
  // `lg:inline` breakpoint on the tab labels.
  const iconOnlyTabs = useMediaQuery('(max-width: 1023px)')

  return (
    /*
     * A grid with equal 1fr side tracks keeps the tab nav centred regardless of
     * the side clusters' widths (e.g. the Saved chip's label changing), so it
     * doesn't slide under the cursor.
     *
     * Children set their columns explicitly: a `display:none` nav is not placed,
     * and auto-placement would move the right cluster into the middle track.
     */
    <header className="grid h-14 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-2 border-b border-line bg-surface px-3 sm:px-4">
      <div className="col-start-1 flex min-w-0 items-center gap-2.5">
        <BrandMark />
        {/* min-w-0 + truncate so a tight phone width shrinks the wordmark instead
            of forcing the whole header (and page) wider than the viewport. */}
        <div className="min-w-0 leading-none">
          <div className="truncate text-[0.95rem] font-bold tracking-tight text-ink">LogoLab</div>
          {/* Below md there is no tab nav at all, so echo the active tab here to
              keep a location cue; from md the active pill carries its own label
              and the static tagline returns. */}
          <div className="truncate text-[0.68rem] text-muted">
            <span className="md:hidden">{activeLabel}</span>
            <span className="hidden md:inline">preview · vectorize · export</span>
          </div>
        </div>
      </div>

      {/*
       * The tab nav collapses in steps:
       * >= xl  labelled tabs and the full right cluster.
       * lg–xl  labelled tabs; the right cluster folds into the menu.
       * md–lg  icon-only tabs, except the active one keeps its label.
       * < md   no nav; the menu holds every tab.
       */}
      <nav aria-label="Sections" className="col-start-2 hidden shrink-0 rounded-lg bg-surface-3 p-0.5 md:flex">
        {TABS.map((t) => (
          // Below lg the tab is icon-only, so it gets aria-label and a tooltip;
          // above lg the empty label makes Tooltip render the link alone.
          <Tooltip key={t.id} label={iconOnlyTabs ? t.label : ''} side="bottom">
            <NavLink
              to={`/${t.id}`}
              aria-label={t.label}
              className={({ isActive }) =>
                `flex h-8 items-center gap-1.5 rounded-[12px] px-2.5 text-sm font-medium transition-all lg:px-3 ${
                  isActive ? 'bg-surface text-ink shadow-xs' : 'text-muted hover:text-ink-2'
                }`
              }
            >
              {({ isActive }) => (
                <>
                  {t.icon}
                  {/* `hidden` removes the span from the flex row entirely, so the
                      gap-1.5 goes with it and the pill collapses to a square. */}
                  <span className={isActive ? undefined : 'hidden lg:inline'}>{t.label}</span>
                </>
              )}
            </NavLink>
          </Tooltip>
        ))}
      </nav>

      {/* Right cluster; its contents move into AppMenu below xl. Justified to
          the end so the icons stay put while the Saved chip's label changes.
          Every tooltip here is `side="bottom"`: there is no room above a
          control at the top of the viewport. */}
      <div className="col-start-3 flex items-center justify-end gap-3">
        <div className="hidden items-center gap-3 xl:flex">
          {logo.src && (
            <Tooltip label="Clear the loaded logo" side="bottom">
              <button
                type="button"
                onClick={clearLogo}
                aria-label="Clear logo"
                className="btn btn-ghost h-8 gap-1.5 px-2 text-xs"
              >
                <X size={14} />
                {/* Label only on wide screens; this cluster's width limits the nav's centring. */}
                <span className="hidden 2xl:inline">Clear</span>
              </button>
            </Tooltip>
          )}
          {/* When the session was last saved. */}
          <SavedChip />
          <div className="flex items-center gap-1">
            {/* Only rendered while the browser is offering an install. */}
            <InstallAppButton />
            {/* The MCP server setup; its only desktop entry point. */}
            <AgentSetupButton variant="icon" />
            <ThemeToggleButton />
            {/* Opens ReportDialog, which asks bug vs idea and shows what gets
                attached, rather than linking straight to GitHub. */}
            <Tooltip
              label={
                <TipLabel title="Report a problem" detail="A bug, or an idea. Nothing is sent until you post it." />
              }
              side="bottom"
            >
              <button
                type="button"
                onClick={onReport}
                aria-label="Report a problem"
                className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink"
              >
                <Bug size={18} />
              </button>
            </Tooltip>
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

        {/* Menu trigger. `xl:hidden` must match `hideFrom` on AppMenu's Sheet,
            or the trigger locks the page and shows nothing. */}
        <Tooltip label="Menu" side="bottom">
          <button
            type="button"
            onClick={onOpenMenu}
            aria-label="Open menu"
            className="btn btn-ghost h-10 w-10 shrink-0 px-0 xl:hidden"
          >
            <Menu size={20} />
          </button>
        </Tooltip>
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
 * Mobile-only upload card on Preview. On phones the sidebar is a drawer that
 * only appears once a logo is loaded; the other tabs have their own empty states.
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
  // Shared by the header's bug button and the mobile menu.
  const [reportOpen, setReportOpen] = useState(false)

  // Appearance controls exist only on Preview and Export; on phones their
  // drawer is offered once a logo is loaded.
  const showStyling = tab === 'preview' || tab === 'export'
  const hasLogo = Boolean(logo.src)

  // Full-height studios show the legal links in their desktop status bar, so
  // the footer is hidden there on desktop.
  const isStudio = tab === 'cleanup' || tab === 'vectorize' || tab === 'sheet' || tab === 'editor'

  // Close overlays on any navigation (including Back), and the appearance
  // drawer when its trigger disappears.
  useEffect(() => {
    setMenuOpen(false)
    if (!showStyling || !hasLogo) setDrawerOpen(false)
  }, [tab, showStyling, hasLogo])

  // Legal pages render in a standalone shell without the studio chrome.
  if (pathname === '/impressum' || pathname === '/datenschutz') {
    return (
      <Routes>
        <Route path="/impressum" element={<Impressum />} />
        <Route path="/datenschutz" element={<Datenschutz />} />
      </Routes>
    )
  }

  // The labs keep the header but drop the sidebar and appearance button to use
  // the full width.
  if (pathname.startsWith('/labs')) {
    return (
      <div className="flex h-full flex-col overflow-x-hidden">
        <Header onOpenMenu={() => setMenuOpen(true)} onReport={() => setReportOpen(true)} />
        <AppMenu open={menuOpen} onClose={() => setMenuOpen(false)} onReport={() => setReportOpen(true)} />
        {reportOpen && <ReportDialog onClose={() => setReportOpen(false)} />}
        <Toasts />
        <main className="min-h-0 flex-1 overflow-y-auto bg-bg">
          {/* One boundary for all labs; resetKey clears a crash on navigation. */}
          <ErrorBoundary what="this lab" resetKey={pathname}>
            <Suspense fallback={<LabLoading />}>
              <Routes>
                <Route path="/labs" element={<LabsIndex />} />
                <Route path="/labs/pipeline" element={<PipelineLab />} />
                <Route path="/labs/ab" element={<AbLab />} />
                <Route path="/labs/workbench" element={<Workbench />} />
                <Route path="/labs/gallery" element={<GalleryLab />} />
                <Route path="/labs/profiler" element={<ProfilerLab />} />
                {/* Old routes, redirected so bookmarks keep working. */}
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
      <Header onOpenMenu={() => setMenuOpen(true)} onReport={() => setReportOpen(true)} />
      <AppMenu open={menuOpen} onClose={() => setMenuOpen(false)} onReport={() => setReportOpen(true)} />
      {reportOpen && <ReportDialog onClose={() => setReportOpen(false)} />}
      <div className="flex min-h-0 flex-1">
        {/* Inline on desktop, a drawer on mobile. Hidden on the Editor tab,
            which edits its own document rather than the working logo. */}
        {tab !== 'editor' && <Sidebar className="hidden md:block" />}
        {/* Flex column with an mt-auto footer: the footer sits at the bottom of
            short pages and scrolls below tall ones instead of being pinned. */}
        <main
          className={`flex min-w-0 flex-1 flex-col overflow-y-auto bg-bg ${
            showStyling && hasLogo ? 'max-md:pb-24' : ''
          }`}
        >
          {tab === 'preview' && !hasLogo && <MobileLogoIntro />}
          {/*
           * One error boundary per panel, so a crash costs only that panel.
           *
           * The boundary must sit outside the Suspense: a lazy chunk that fails
           * to load rejects into the nearest boundary above its Suspense, and
           * one inside would let it escape to the root.
           *
           * Don't drop `resetKey={pathname}`: the router renders every route in
           * the same position, so React reuses one boundary instance across all
           * tabs, and without the key a crash in one tab follows you to the next.
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

      {/* Mobile appearance drawer and its button, on tabs with controls once a logo is loaded. */}
      {showStyling && <MobileSidebarDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />}
      <Toasts />
      {showStyling && hasLogo && (
        <Tooltip label="Customize appearance">
          <button
            type="button"
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
