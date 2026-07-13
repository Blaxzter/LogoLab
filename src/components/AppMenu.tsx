import { Bug, Coffee, Heart, X } from 'lucide-react'
import { NavLink } from 'react-router-dom'
import { useLogo, useStore } from '../store'
import { Sheet } from './ui/Sheet'
import { ThemeToggleSegmented } from './ThemeToggle'
import { TABS, LAB_VIEWS, REPO_URL, COFFEE_URL, SPONSOR_URL, GithubMark } from './navItems'

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

        <ThemeToggleSegmented />

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

        {/* The desktop header's bug popover has no room here, so the harnesses
            list flat — same set, same order. */}
        <div className="my-2 h-px bg-line" />
        <div className="flex items-center gap-2 px-3 pb-1 text-[0.7rem] font-bold uppercase tracking-wider text-faint">
          <Bug size={13} />
          Dev views
        </div>
        {LAB_VIEWS.map((v) => (
          <a
            key={v.href}
            href={v.href}
            target="_blank"
            rel="noreferrer"
            onClick={onClose}
            className={`${row} text-ink-2 hover:bg-surface-3`}
          >
            <span className="grid h-5 w-5 place-items-center">{v.icon}</span>
            {v.label}
          </a>
        ))}

        <div className="my-2 h-px bg-line" />

        <a
          href={COFFEE_URL}
          target="_blank"
          rel="noreferrer"
          onClick={onClose}
          className={`${row} text-ink-2 hover:bg-surface-3`}
        >
          <span className="grid h-5 w-5 place-items-center">
            <Coffee size={16} />
          </span>
          Buy me a coffee
        </a>

        <a
          href={SPONSOR_URL}
          target="_blank"
          rel="noreferrer"
          onClick={onClose}
          className={`${row} text-ink-2 hover:bg-surface-3`}
        >
          <span className="grid h-5 w-5 place-items-center">
            <Heart size={16} className="text-pink-500" />
          </span>
          Sponsor on GitHub
        </a>
      </nav>

      <div className="shrink-0 border-t border-line px-4 py-3 pb-safe text-xs text-faint">
        Runs 100% in your browser · no uploads, no sign-up.
      </div>
    </Sheet>
  )
}
