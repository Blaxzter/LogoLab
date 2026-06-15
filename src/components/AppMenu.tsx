import { X } from 'lucide-react'
import { NavLink } from 'react-router-dom'
import { useLogo, useStore } from '../store'
import { Sheet } from './ui/Sheet'
import { TABS, REPO_URL, GithubMark } from './navItems'

/**
 * The mobile title-bar menu (right slide-over). Below md the header collapses to
 * brand + a hamburger; this holds everything that lived inline on desktop: the
 * four tab links, a Clear-logo action (works on every tab, including the studios
 * where the header button is otherwise hidden), the GitHub link, and the
 * "runs in your browser" note. Auto-closes on navigation.
 */
export function AppMenu({ open, onClose }: { open: boolean; onClose: () => void }) {
  const logo = useLogo()
  const clearLogo = useStore((s) => s.clearLogo)

  const row = 'flex h-12 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors'

  return (
    <Sheet open={open} onClose={onClose} title="Menu" side="right">
      <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-3">
        {TABS.map((t) => (
          <NavLink
            key={t.id}
            to={`/${t.id}`}
            onClick={onClose}
            className={({ isActive }) =>
              `${row} ${isActive ? 'bg-accent-soft text-accent' : 'text-ink-2 hover:bg-surface-3'}`
            }
          >
            <span className="grid h-5 w-5 place-items-center">{t.icon}</span>
            {t.label}
          </NavLink>
        ))}

        <div className="my-2 h-px bg-line" />

        {logo.src && (
          <button
            type="button"
            onClick={() => {
              clearLogo()
              onClose()
            }}
            className={`${row} text-ink-2 hover:bg-surface-3`}
          >
            <span className="grid h-5 w-5 place-items-center">
              <X size={16} />
            </span>
            Clear logo
          </button>
        )}

        <a
          href={REPO_URL}
          target="_blank"
          rel="noreferrer"
          onClick={onClose}
          className={`${row} text-ink-2 hover:bg-surface-3`}
        >
          <span className="grid h-5 w-5 place-items-center">
            <GithubMark size={16} />
          </span>
          View source on GitHub
        </a>
      </nav>

      <div className="shrink-0 border-t border-line px-4 py-3 pb-safe text-xs text-faint">
        Runs 100% in your browser · no uploads, no sign-up.
      </div>
    </Sheet>
  )
}
