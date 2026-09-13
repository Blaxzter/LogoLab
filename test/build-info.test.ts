// The footer's build stamp — what the site says it IS.
//
//   node --test test/build-info.test.ts
//
// The values are injected by vite.config.ts at build time and every one of them
// can be missing (a build from a tarball has no git, a broken manifest read
// leaves no version), so what actually needs pinning is the DEGRADATION: a
// half-empty stamp must render as less, never as `v` followed by nothing or the
// word `Invalid Date` sitting in the footer of every page.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTitle, hasBuildInfo, releaseDateLabel, versionLabel, type BuildInfo } from '../src/lib/buildInfo.ts'

const FULL: BuildInfo = { version: '0.1.1', date: '2026-09-13T14:26:20+02:00', commit: '6a1dc5b' }

test('a complete stamp reads as a version and a day', () => {
  assert.equal(versionLabel(FULL), 'v0.1.1')
  assert.equal(releaseDateLabel(FULL, 'en-GB'), '13 Sept 2026')
  assert.equal(buildTitle(FULL, 'en-GB'), 'LogoLab v0.1.1 · built 13 Sept 2026 · from 6a1dc5b')
  assert.equal(hasBuildInfo(FULL), true)
})

test('the date is localised, not hard-coded to one format', () => {
  const en = releaseDateLabel(FULL, 'en-GB')
  const de = releaseDateLabel(FULL, 'de-DE')
  assert.notEqual(en, de, `both locales rendered "${en}" — the locale is being ignored`)
  for (const s of [en, de]) assert.match(s, /2026/)
})

test('no git in the build: the version still prints, the commit is simply absent', () => {
  const noGit: BuildInfo = { version: '0.1.1', date: '', commit: '' }
  assert.equal(hasBuildInfo(noGit), true)
  assert.equal(versionLabel(noGit), 'v0.1.1')
  assert.equal(releaseDateLabel(noGit), '', 'no date to show')
  assert.equal(buildTitle(noGit, 'en-GB'), 'LogoLab v0.1.1')
})

test('no manifest: the day still prints, with no stray "v"', () => {
  const noVersion: BuildInfo = { version: '', date: FULL.date, commit: '6a1dc5b' }
  assert.equal(versionLabel(noVersion), '', 'a bare "v" is worse than nothing')
  assert.equal(hasBuildInfo(noVersion), true)
  assert.match(buildTitle(noVersion, 'en-GB'), /^built /)
})

test('an unparseable date degrades to no date, never to "Invalid Date"', () => {
  const bad: BuildInfo = { version: '0.1.1', date: 'not-a-date', commit: '' }
  assert.equal(releaseDateLabel(bad), '')
  assert.doesNotMatch(buildTitle(bad, 'en-GB'), /Invalid/)
})

test('an empty stamp renders nothing at all', () => {
  const none: BuildInfo = { version: '', date: '', commit: '' }
  assert.equal(hasBuildInfo(none), false, 'the footer drops the whole span on this')
  assert.equal(buildTitle(none), '')
})

// The version shown has to be the version that ships, or the footer links to a
// release tag that does not exist. vite.config.ts reads packages/mcp/package.json
// for exactly that reason — the same manifest `packageVersion()` reads and the
// release workflow checks the tag against.
test('the build stamp reads the version from the manifest that ships', async () => {
  const { readFileSync } = await import('node:fs')
  const config = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8')
  assert.match(
    config,
    /packages\/mcp\/package\.json/,
    'the stamp must take its version from the published manifest, not the private app one',
  )
})
