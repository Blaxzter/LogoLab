import { NavLink } from 'react-router-dom'
import { REPO_URL } from '../navItems'

/**
 * Slim site footer carrying the legally-required links (Impressum &
 * Datenschutz must be reachable from every page). Used by both the studio
 * shell and the standalone legal pages.
 */
export function LegalFooter() {
  return (
    <footer className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 border-t border-line bg-surface px-4 py-3 text-xs text-muted">
      <span>© 2026 LogoLab</span>
      <span aria-hidden className="text-faint">·</span>
      <NavLink to="/impressum" className="transition-colors hover:text-ink">
        Impressum
      </NavLink>
      <span aria-hidden className="text-faint">·</span>
      <NavLink to="/datenschutz" className="transition-colors hover:text-ink">
        Datenschutz
      </NavLink>
      <span aria-hidden className="text-faint">·</span>
      <a
        href={REPO_URL}
        target="_blank"
        rel="noreferrer"
        className="transition-colors hover:text-ink"
      >
        GitHub
      </a>
    </footer>
  )
}
