// The header collapses in steps, and each step is TWO files agreeing.
//
//   node --test test/header-collapse.test.ts
//
// This gate exists because the disagreement is invisible to everything else.
// The hamburger in App.tsx was `lg:hidden` while the Sheet behind AppMenu was
// hard-wired `md:hidden`, so between 768 and 1024px the button was on screen
// and the panel it opens was `display:none`. Nothing throws: React sets `open`,
// the sheet mounts, the stylesheet removes it, and useBodyScrollLock freezes
// the page — a header button that does nothing but stop you scrolling. The
// typecheck is happy, the tests were happy, and it took a screenshot from
// someone on a tablet to find it.
//
// The second pairing is the tab list. It exists in both the header nav and the
// menu, and exactly one of them may show it at a given width: reveal the nav at
// `md` while the menu still lists tabs below `lg` and a tablet gets the same six
// rows twice; move one without the other far enough and a range gets none.
//
// Regexes over the sources, not a DOM: `node --test` here has no jsdom, and the
// thing being checked is a pair of class strings, which is exactly what a source
// read can see.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const APP = readFileSync('src/App.tsx', 'utf8')
const MENU = readFileSync('src/components/shell/AppMenu.tsx', 'utf8')
const SHEET = readFileSync('src/components/ui/Sheet.tsx', 'utf8')

/** The element bearing `aria-label="Open menu"`, with its className. */
function menuTrigger(): string {
  const at = APP.indexOf('aria-label="Open menu"')
  assert.notEqual(at, -1, 'App.tsx no longer has a button labelled "Open menu"')
  const cls = /className="([^"]*)"/.exec(APP.slice(at, at + 400))
  assert.ok(cls, 'the menu trigger has no className to read a breakpoint from')
  return cls[1]
}

/** The single `<prefix>:hidden` in a class string. */
function hiddenAt(className: string, what: string): string {
  const found = [...className.matchAll(/\b([a-z0-9]+):hidden\b/g)].map((m) => m[1])
  assert.equal(found.length, 1, `${what} should name exactly one :hidden breakpoint, got ${found.join(', ') || 'none'}`)
  return found[0]
}

test('the menu trigger and the sheet it opens hide at the same width', () => {
  const trigger = hiddenAt(menuTrigger(), 'the menu trigger')

  const prop = /<Sheet[^>]*hideFrom="([a-z0-9]+)"/.exec(MENU)
  assert.ok(prop, 'AppMenu no longer passes hideFrom to its Sheet — it would fall back to md')
  assert.equal(
    prop[1],
    trigger,
    `the hamburger is ${trigger}:hidden but its sheet hides from ${prop[1]} — one of those widths opens nothing`,
  )
})

test('every hideFrom Sheet accepts is the breakpoint it claims to be', () => {
  const table = /const HIDE_FROM = \{([^}]*)\}/.exec(SHEET)
  assert.ok(table, 'Sheet no longer maps hideFrom to a class')
  for (const [, key, cls] of table[1].matchAll(/([a-z0-9]+):\s*'([^']+)'/g)) {
    assert.equal(cls, `${key}:hidden`, `hideFrom="${key}" would hide at ${cls}`)
  }
})

test('the tabs are listed by the header or by the menu, never both', () => {
  const nav = /<nav aria-label="Sections" className="([^"]*)"/.exec(APP)
  assert.ok(nav, 'the header tab nav lost its aria-label, or its className moved')
  const shown = [...nav[1].matchAll(/\b([a-z0-9]+):flex\b/g)].map((m) => m[1])
  assert.equal(shown.length, 1, `the header nav should appear at exactly one breakpoint, got ${shown.join(', ') || 'none'}`)

  // The menu's copy of the tab list — a `contents` wrapper so the rows stay flex
  // children of the nav, hidden from the width at which the header takes over.
  const group = /className="contents ([a-z0-9]+):hidden"/.exec(MENU)
  assert.ok(group, "AppMenu's tab group is no longer a `contents … :hidden` wrapper")
  assert.equal(
    group[1],
    shown[0],
    `the header shows tabs from ${shown[0]} but the menu keeps listing them until ${group[1]}`,
  )
})
