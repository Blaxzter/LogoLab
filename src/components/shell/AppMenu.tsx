import { Bug, Coffee, Heart, X } from 'lucide-react'
import { NavLink } from 'react-router-dom'
import { useLogo, useStore } from '../../state/store'
import { AgentSetupButton } from './AgentSetup'
import { InstallAppButton } from './PwaPrompts'
import { SavedStatusRow } from './SavedChip'
import { Sheet } from '../ui/Sheet'
import { ThemeToggleSegmented } from './ThemeToggle'
import { TABS, LAB_VIEWS, REPO_URL, COFFEE_URL, SPONSOR_URL, GithubMark } from './navItems'

/**
 * The title-bar menu (right slide-over), used below xl. Below xl it holds the
 * header's right-hand cluster; below md the tab links join it.
 *
 * `hideFrom="xl"` must match the `xl:hidden` on the hamburger in App.tsx, or
 * the trigger opens a panel CSS has hidden, leaving a scroll-locked page.
 */
export function AppMenu({
  open,
  onClose,
  onReport,
}: {
  open: boolean
  onClose: () => void
  /** Opens the same ask the header's bug button does (components/report/ReportDialog). */
  onReport: () => void
}) {
  const logo = useLogo()
  const clearLogo = useStore((s) => s.clearLogo)

  const row = 'flex h-12 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors'

  return (
    <Sheet open={open} onClose={onClose} title="Menu" side="right" hideFrom="xl">
      <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-3">
        {/* `contents` keeps the rows direct flex children of the nav (so they keep
            its gap) while `md:hidden` still hides the group. */}
        <div className="contents md:hidden">
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
        </div>

        {/* Only rendered while the browser is offering an install. */}
        <InstallAppButton
          variant="ghost"
          className={`${row} justify-start text-ink-2 hover:bg-surface-3`}
          onInstalled={onClose}
        />

        <AgentSetupButton variant="ghost" className={`${row} justify-start`} onOpened={onClose} />

        <div className="my-2 h-px bg-line" />

        <ThemeToggleSegmented />

        <div className="my-2 h-px bg-line" />

        {/* Stands in for the header's Saved chip, hidden below xl. */}
        <SavedStatusRow className={`${row} text-ink-2 hover:bg-surface-3`} onAct={onClose} />

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

        <button
          type="button"
          onClick={() => {
            onClose()
            onReport()
          }}
          className={`${row} text-ink-2 hover:bg-surface-3`}
        >
          <span className="grid h-5 w-5 place-items-center">
            <Bug size={16} />
          </span>
          Report a problem
        </button>

        {/* The desktop labs popover's entries, listed flat. */}
        <div className="my-2 h-px bg-line" />
        <div className="flex items-center gap-2 px-3 pb-1 text-[0.7rem] font-bold uppercase tracking-wider text-faint">
          <Bug size={13} />
          Dev views
        </div>
        {LAB_VIEWS.map((v) => (
          <NavLink
            key={v.to}
            to={v.to}
            onClick={onClose}
            className={({ isActive }) =>
              `${row} ${isActive ? 'bg-accent-soft text-accent' : 'text-ink-2 hover:bg-surface-3'}`
            }
          >
            <span className="grid h-5 w-5 place-items-center">{v.icon}</span>
            {v.label}
          </NavLink>
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
