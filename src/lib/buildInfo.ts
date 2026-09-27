// Build identity shown in the footer, injected by vite.config.ts as
// `__LOGOLAB_BUILD__` (the commit and date come from git, not from any file).
// The version is read from packages/mcp/package.json so the site and the npm
// package report the same tracer version.
//
// Every field may be empty (e.g. a build without git); `hasBuildInfo` checks.

declare const __LOGOLAB_BUILD__: { version: string; date: string; commit: string }

export interface BuildInfo {
  /** Semver of the tracer this build carries, e.g. `0.1.1`. Empty if unknown. */
  version: string
  /** ISO-8601 committer date of the commit it was built from. Empty if unknown. */
  date: string
  /** Short commit SHA. Empty outside a git checkout. */
  commit: string
}

const EMPTY: BuildInfo = { version: '', date: '', commit: '' }

export const BUILD: BuildInfo = typeof __LOGOLAB_BUILD__ === 'object' && __LOGOLAB_BUILD__ ? __LOGOLAB_BUILD__ : EMPTY

/** True when there is anything worth printing. */
export const hasBuildInfo = (b: BuildInfo = BUILD): boolean => Boolean(b.version || b.date)

/** `v0.1.1`, or an empty string when the version did not make it into the build. */
export const versionLabel = (b: BuildInfo = BUILD): string => (b.version ? `v${b.version}` : '')

/**
 * The build date as a short localised day (`13 Sep 2026` in en-GB). Empty when
 * missing or unparseable, never `Invalid Date`.
 */
export function releaseDateLabel(b: BuildInfo = BUILD, locale?: string): string {
  if (!b.date) return ''
  const at = new Date(b.date)
  if (Number.isNaN(at.getTime())) return ''
  return at.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' })
}

/** The long form (version, date and commit) for a tooltip. */
export function buildTitle(b: BuildInfo = BUILD, locale?: string): string {
  const parts: string[] = []
  if (b.version) parts.push(`LogoLab ${versionLabel(b)}`)
  const day = releaseDateLabel(b, locale)
  if (day) parts.push(`built ${day}`)
  if (b.commit) parts.push(`from ${b.commit}`)
  return parts.join(' · ')
}
