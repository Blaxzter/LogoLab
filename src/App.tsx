import { useEffect, useState } from 'react'
import { Menu, SlidersHorizontal, X } from 'lucide-react'
import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import { useLogo, useStore } from './store'
import { useActiveTab } from './hooks/useActiveTab'
import { useLiveFavicon } from './hooks/useLiveFavicon'
import { Sidebar, MobileSidebarDrawer } from './components/Sidebar'
import { AppMenu } from './components/AppMenu'
import { SupportPopover } from './components/SupportPopover'
import { ThemeToggleButton } from './components/ThemeToggle'
import { TABS, REPO_URL, GithubMark } from './components/navItems'
import { UploadDropzone } from './components/UploadDropzone'
import { Tooltip } from './components/ui/Tooltip'
import { TryExampleButton } from './components/ExamplesDialog'
import { PreviewGrid } from './components/PreviewGrid'
import CleanupPanel from './components/panels/CleanupPanel'
import VectorizePanel from './components/panels/VectorizePanel'
import ExportPanel from './components/panels/ExportPanel'

function Header({ onOpenMenu }: { onOpenMenu: () => void }) {
  const logo = useLogo()
  const clearLogo = useStore((s) => s.clearLogo)
  const tab = useActiveTab()
  const activeLabel = TABS.find((t) => t.id === tab)?.label ?? ''

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-line bg-surface px-3 sm:px-4">
      <div className="flex min-w-0 items-center gap-2.5">
        <BrandMark />
        {/* min-w-0 + truncate so a tight phone width shrinks the wordmark instead
            of forcing the whole header (and page) wider than the viewport. */}
        <div className="min-w-0 leading-none">
          <div className="truncate text-[0.95rem] font-bold tracking-tight text-ink">LogoLab</div>
          {/* Below md the inline tab nav is hidden, so echo the active tab here to
              keep a location cue; at md+ the static tagline returns. */}
          <div className="truncate text-[0.68rem] text-muted">
            <span className="md:hidden">{activeLabel}</span>
            <span className="hidden md:inline">preview · vectorize · export</span>
          </div>
        </div>
      </div>

      {/* Desktop tab nav — replaced by the hamburger menu below md. */}
      <nav className="hidden shrink-0 rounded-lg bg-surface-3 p-0.5 md:flex">
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

      {/* Desktop right cluster — its contents move into AppMenu below md. */}
      <div className="hidden shrink-0 items-center gap-3 md:flex">
        {logo.src && (
          <button onClick={clearLogo} className="btn btn-ghost h-8 gap-1.5 px-2.5 text-xs">
            <X size={14} />
            Clear
          </button>
        )}
        <span className="text-xs text-faint">Runs 100% in your browser</span>
        <div className="flex items-center gap-1">
          <ThemeToggleButton />
          <SupportPopover />
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink"
          >
            <GithubMark />
            <span className="sr-only">GitHub repository</span>
          </a>
        </div>
      </div>

      {/* Mobile menu trigger (~44px target). */}
      <button
        type="button"
        onClick={onOpenMenu}
        aria-label="Open menu"
        className="btn btn-ghost h-10 w-10 shrink-0 px-0 md:hidden"
      >
        <Menu size={20} />
      </button>
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
  const tab = useActiveTab()
  const logo = useLogo()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  // The appearance controls only exist on Preview & Export. On phones they live
  // in a slide-over that we only surface once a logo is loaded (nothing to tweak
  // before then) — matches the desktop sidebar, which is also logo-driven.
  const showStyling = tab === 'preview' || tab === 'export'
  const hasLogo = Boolean(logo.src)

  // Close any open overlay on navigation (covers the back button, not just the
  // in-menu links), and drop the appearance drawer when its trigger disappears.
  useEffect(() => {
    setMenuOpen(false)
    if (!showStyling || !hasLogo) setDrawerOpen(false)
  }, [tab, showStyling, hasLogo])

  return (
    <div className="flex h-full flex-col overflow-x-hidden">
      <Header onOpenMenu={() => setMenuOpen(true)} />
      <AppMenu open={menuOpen} onClose={() => setMenuOpen(false)} />
      <div className="flex min-h-0 flex-1">
        {/* Inline column on desktop; a drawer (below) replaces it on mobile. */}
        <Sidebar className="hidden md:block" />
        <main
          className={`min-w-0 flex-1 overflow-y-auto bg-bg ${
            showStyling && hasLogo ? 'max-md:pb-24' : ''
          }`}
        >
          {tab === 'preview' && !hasLogo && <MobileLogoIntro />}
          <Routes>
            <Route path="/preview" element={<PreviewGrid />} />
            <Route path="/cleanup" element={<CleanupPanel />} />
            <Route path="/vectorize" element={<VectorizePanel />} />
            <Route path="/export" element={<ExportPanel />} />
            {/* Root and any unknown path land on Preview. */}
            <Route path="/" element={<Navigate to="/preview" replace />} />
            <Route path="*" element={<Navigate to="/preview" replace />} />
          </Routes>
        </main>
      </div>

      {/* Mobile appearance drawer + the button that opens it. Only on the tabs
          that have controls, and only once there's a logo to customize. */}
      {showStyling && (
        <MobileSidebarDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
      )}
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
