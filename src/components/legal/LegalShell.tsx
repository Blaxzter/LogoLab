import { ArrowLeft } from 'lucide-react'
import { Link } from 'react-router-dom'
import { LegalFooter } from './LegalFooter'

/**
 * Standalone, full-height chrome for the legal pages (Impressum / Datenschutz).
 * Deliberately separate from the studio shell — no sidebar, no appearance FAB —
 * so the long-form text reads cleanly. Tokens drive the colors, so it follows
 * the light/dark theme automatically.
 */
export function LegalShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col overflow-x-hidden bg-bg">
      <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-line bg-surface px-3 sm:px-4">
        <Link to="/" className="flex min-w-0 items-center gap-2.5">
          <BrandMark />
          <span className="truncate text-[0.95rem] font-bold tracking-tight text-ink">LogoLab</span>
        </Link>
        <Link
          to="/"
          className="btn btn-ghost h-8 gap-1.5 px-2.5 text-xs"
          title="Back to the app"
        >
          <ArrowLeft size={14} />
          Back to app
        </Link>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto">
        <article className="legal mx-auto max-w-3xl px-5 py-10 sm:px-8 sm:py-14">
          {children}
        </article>
        <LegalFooter />
      </main>
    </div>
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
