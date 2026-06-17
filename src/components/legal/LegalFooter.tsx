import { NavLink } from 'react-router-dom'
import { REPO_URL } from '../navItems'

/**
 * Just the legally-required links, no footer chrome — for embedding in an
 * existing bar (e.g. the Cleanup/Vectorize desktop status bar) so the
 * full-height studios stay reachable without a separate footer that would add a
 * second scroll. Inherits the host bar's font/size/color; only the hover lifts.
 */
export function LegalLinksInline({ className = '' }: { className?: string }) {
  return (
    <span className={`flex items-center gap-2 ${className}`}>
      <NavLink to="/impressum" className="transition-colors hover:text-ink">
        Impressum
      </NavLink>
      <span aria-hidden className="opacity-50">·</span>
      <NavLink to="/datenschutz" className="transition-colors hover:text-ink">
        Datenschutz
      </NavLink>
    </span>
  )
}

/**
 * Slim site footer carrying the legally-required links (Impressum &
 * Datenschutz must be reachable from every page). Used by both the studio
 * shell and the standalone legal pages.
 */
export function LegalFooter({ className = '' }: { className?: string }) {
  return (
    <footer
      className={`flex shrink-0 flex-wrap items-center justify-center gap-x-3 gap-y-1 border-t border-line/60 px-4 py-5 text-[0.7rem] text-faint ${className}`}
    >
      <span>© 2026 LogoLab</span>
      <span aria-hidden className="opacity-50">·</span>
      <NavLink to="/impressum" className="transition-colors hover:text-ink">
        Impressum
      </NavLink>
      <span aria-hidden className="opacity-50">·</span>
      <NavLink to="/datenschutz" className="transition-colors hover:text-ink">
        Datenschutz
      </NavLink>
      <span aria-hidden className="opacity-50">·</span>
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
