import { NavLink } from 'react-router-dom'
import { REPO_URL } from '../shell/navItems'
import { BUILD, buildTitle, hasBuildInfo, releaseDateLabel, versionLabel } from '../../lib/buildInfo'
import { Tooltip } from '../ui/Tooltip'

/**
 * Which build you are looking at: tracer version and build date. The site
 * deploys on every push to main, so this lets a user (and a bug report) say
 * which build they have. The version links to its GitHub release. Renders
 * nothing when the stamp is empty rather than printing `v` and a blank date.
 */
function BuildStamp() {
  if (!hasBuildInfo()) return null
  const version = versionLabel()
  const day = releaseDateLabel()
  return (
    // A themed Tooltip, not a native `title`, like every other hint in the app.
    <Tooltip label={buildTitle()}>
      <span className="flex items-center gap-1.5">
        {version && (
          <a
            href={`${REPO_URL}/releases/tag/${version}`}
            target="_blank"
            rel="noreferrer"
            className="transition-colors hover:text-ink"
          >
            {version}
          </a>
        )}
        {version && day && (
          <span aria-hidden className="opacity-50">
            ·
          </span>
        )}
        {day && <time dateTime={BUILD.date}>{day}</time>}
      </span>
    </Tooltip>
  )
}

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
      <span aria-hidden className="opacity-50">
        ·
      </span>
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
      <span aria-hidden className="opacity-50">
        ·
      </span>
      <NavLink to="/impressum" className="transition-colors hover:text-ink">
        Impressum
      </NavLink>
      <span aria-hidden className="opacity-50">
        ·
      </span>
      <NavLink to="/datenschutz" className="transition-colors hover:text-ink">
        Datenschutz
      </NavLink>
      <span aria-hidden className="opacity-50">
        ·
      </span>
      <a href={REPO_URL} target="_blank" rel="noreferrer" className="transition-colors hover:text-ink">
        GitHub
      </a>
      {hasBuildInfo() && (
        <>
          <span aria-hidden className="opacity-50">
            ·
          </span>
          <BuildStamp />
        </>
      )}
    </footer>
  )
}
