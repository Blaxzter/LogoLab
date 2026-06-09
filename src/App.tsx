import { Download, Eraser, Eye, Wand2 } from 'lucide-react'
import { useStore } from './store'
import type { Tab } from './store'
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
  const tab = useStore((s) => s.tab)
  const setTab = useStore((s) => s.setTab)
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
        {TABS.map((t) => {
          const active = t.id === tab
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex h-8 items-center gap-1.5 rounded-[7px] px-3 text-sm font-medium transition-all ${
                active ? 'bg-surface text-ink shadow-xs' : 'text-muted hover:text-ink-2'
              }`}
            >
              {t.icon}
              {t.label}
            </button>
          )
        })}
      </nav>

      <div className="hidden text-xs text-faint sm:block">Runs 100% in your browser</div>
    </header>
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
  const tab = useStore((s) => s.tab)
  useLiveFavicon()
  return (
    <div className="flex h-full flex-col">
      <Header />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="min-w-0 flex-1 overflow-y-auto bg-bg">
          {tab === 'preview' && <PreviewGrid />}
          {tab === 'cleanup' && <CleanupPanel />}
          {tab === 'vectorize' && <VectorizePanel />}
          {tab === 'export' && <ExportPanel />}
        </main>
      </div>
    </div>
  )
}
