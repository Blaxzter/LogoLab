// The animated icons: one import path, and data that still matches lucide.
//
//   node --test test/animated-icons.test.ts
//
// src/components/ui/icons is all of lucide-react with the icons ported from
// lucide-motion-vue (scripts/port-motion-icons.mjs) shadowing their static
// exports. Its failure mode is silent: import `Copy` from 'lucide-react' again
// and the button works, the typecheck passes, the icon renders — it just never
// animates, and never falls back for reduced motion either, because it is not
// going through the wrapper at all. So the first test fails on any direct import.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import * as data from '../src/components/ui/icons/motionData.ts'

const ICON_MODULE = join('src', 'components', 'ui', 'icons')

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) sources(p, out)
    else if (/\.tsx?$/.test(name)) out.push(p)
  }
  return out
}

test('app code imports icons from ui/icons, never lucide-react directly', () => {
  const offenders = sources('src')
    .filter((p) => !p.startsWith(ICON_MODULE + sep))
    .filter((p) => /from\s+['"]lucide-react['"]/.test(readFileSync(p, 'utf8')))
    .map((p) => relative('.', p))
  assert.deepEqual(offenders, [], 'import these from src/components/ui/icons instead')
})

test('every ported icon is wrapped in index.ts and has something that moves', () => {
  const index = readFileSync(join(ICON_MODULE, 'index.ts'), 'utf8')
  for (const [exportName, icon] of Object.entries(data)) {
    assert.ok(
      new RegExp(`\\b${exportName} as ${exportName}Static\\b`).test(index),
      `${exportName}: not wrapped in index.ts — re-run scripts/port-motion-icons.mjs`,
    )
    const keys: string[] = []
    const walk = (els: typeof icon.elements) =>
      els.forEach((e) => {
        if (e.key) keys.push(e.key)
        if (e.children) walk(e.children)
      })
    walk(icon.elements)
    // A key with no variants renders static (scissors names `circle1` upstream
    // and never animates it), so the bar is that SOMETHING moves.
    const moving = keys.filter((k) => Object.keys(icon.variants[k] ?? {}).length > 0)
    assert.ok(moving.length > 0, `${icon.name}: nothing in it animates`)
  }
})
