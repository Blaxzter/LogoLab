import { NavLink } from 'react-router-dom'
import { REPO_URL } from '../navItems'
import { BUILD, buildTitle, hasBuildInfo, releaseDateLabel, versionLabel } from '../../lib/buildInfo'
import { Tooltip } from '../ui/Tooltip'

/**
 * Which build you are looking at — the version of the tracer and the day it was
 * built. Worth a line in the footer because the site deploys on every push to
 * main: without it, "it still does the thing" and "your fix has not reached me
 * yet" are indistinguishable from the outside, and a bug report cannot say which.
 *
 * The version links to its GitHub release, so the notes for exactly this build
 * are one click away. Renders nothing at all when the stamp is empty (a build
 * with no git and no manifest) rather than printing `v` and a blank date.
 */
function BuildStamp() {
  if (!hasBuildInfo()) return null
  const version = versionLabel()
  const day = releaseDateLabel()
  return (
    // The long form is a real tooltip, not a native `title` — this was the last
    // one left in the app, and a bubble that takes a second to appear and can't
    // be themed is not the same affordance as the ones everywhere else.
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
      {hasBuildInfo() && (
        <>
          <span aria-hidden className="opacity-50">·</span>
          <BuildStamp />
        </>
      )}
    </footer>
  )
}
