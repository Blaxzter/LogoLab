// What this build is, for the footer to say out loud.
//
// Injected by vite.config.ts (`__LOGOLAB_BUILD__`) rather than imported, because
// two of the three values do not exist in the source at all: the commit and its
// date are properties of the checkout being built, not of any file in it. The
// version DOES live in a file — packages/mcp/package.json, the one place it is
// written — and is read there so the site and the npm package can never disagree
// about which tracer this is.
//
// Every field is best-effort at build time (a tarball has no git), so every one
// can arrive empty and the UI has to cope. `hasBuildInfo` is that check.

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
 * The build date as a short, localised day — `13 Sep 2026` in en-GB, `13. Sept.
 * 2026` in de-DE. Empty when the date is missing or unparseable, so a bad stamp
 * degrades to showing just the version rather than `Invalid Date`.
 */
export function releaseDateLabel(b: BuildInfo = BUILD, locale?: string): string {
  if (!b.date) return ''
  const at = new Date(b.date)
  if (Number.isNaN(at.getTime())) return ''
  return at.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' })
}

/** The long form, for the `title` tooltip — says which half is which. */
export function buildTitle(b: BuildInfo = BUILD, locale?: string): string {
  const parts: string[] = []
  if (b.version) parts.push(`LogoLab ${versionLabel(b)}`)
  const day = releaseDateLabel(b, locale)
  if (day) parts.push(`built ${day}`)
  if (b.commit) parts.push(`from ${b.commit}`)
  return parts.join(' · ')
}
