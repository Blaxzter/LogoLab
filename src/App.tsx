import { Download, Eraser, Eye, Wand2, X } from 'lucide-react'
import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import type { Tab } from './store'
import { useLogo, useStore } from './store'
import { useLiveFavicon } from './hooks/useLiveFavicon'
import { Sidebar } from './components/Sidebar'
import { PreviewGrid } from './components/PreviewGrid'
import CleanupPanel from './components/panels/CleanupPanel'
import VectorizePanel from './components/panels/VectorizePanel'
import ExportPanel from './components/panels/ExportPanel'

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: 'preview', label: 'Preview', icon: <Eye size={15} /> },
  { id: 'cleanup', label: 'Cleanup', icon: <Eraser size={15} /> },
  { id: 'vectorize', label: 'Vectorize', icon: <Wand2 size={15} /> },
  { id: 'export', label: 'Export', icon: <Download size={15} /> },
]

function Header() {
  const logo = useLogo()
  const clearLogo = useStore((s) => s.clearLogo)
  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-line bg-surface px-4">
      <div className="flex items-center gap-2.5">
        <BrandMark />
        <div className="leading-none">
          <div className="text-[0.95rem] font-bold tracking-tight text-ink">LogoLab</div>
          <div className="text-[0.68rem] text-muted">preview · vectorize · export</div>
        </div>
      </div>

      <nav className="flex rounded-lg bg-surface-3 p-0.5">
        {TABS.map((t) => (
          <NavLink
            key={t.id}
            to={`/${t.id}`}
            className={({ isActive }) =>
              `flex h-8 items-center gap-1.5 rounded-[7px] px-3 text-sm font-medium transition-all ${
                isActive ? 'bg-surface text-ink shadow-xs' : 'text-muted hover:text-ink-2'
              }`
            }
          >
            {t.icon}
            {t.label}
          </NavLink>
        ))}
      </nav>

      <div className="flex items-center gap-3">
        {/* Clearing the loaded logo from here covers every view — including
            Cleanup & Vectorize, where the sidebar (and its remove button) is
            collapsed away. Only shown once something is actually loaded. */}
        {logo.src && (
          <button
            onClick={clearLogo}
            title="Clear the loaded logo"
            className="btn btn-ghost h-8 gap-1.5 px-2.5 text-xs"
          >
            <X size={14} />
            Clear
          </button>
        )}
        <span className="hidden text-xs text-faint sm:block">Runs 100% in your browser</span>
        <a
          href={REPO_URL}
          target="_blank"
          rel="noreferrer"
          title="View source on GitHub"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink"
        >
          <GithubMark />
          <span className="sr-only">GitHub repository</span>
        </a>
      </div>
    </header>
  )
}

const REPO_URL = 'https://github.com/Blaxzter/LogoLab'

function GithubMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.017C22 6.484 17.522 2 12 2Z"
      />
    </svg>
  )
}

function BrandMark() {
  return (
    <svg width="30" height="30" viewBox="0 0 64 64" fill="none" aria-hidden>
      <rect x="2" y="2" width="60" height="60" rx="16" fill="#14161c" />
      <circle cx="32" cy="32" r="15" stroke="#fff" strokeWidth="3.2" />
      <circle cx="32" cy="32" r="6" fill="#6366f1" />
    </svg>
  )
}

export function App() {
  useLiveFavicon()
  return (
    <div className="flex h-full flex-col">
      <Header />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="min-w-0 flex-1 overflow-y-auto bg-bg">
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
    </div>
  )
}
