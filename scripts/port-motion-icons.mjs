#!/usr/bin/env node
// Ports the animated icons LogoLab uses from @respeak/lucide-motion-vue
// (https://github.com/respeak-io/lucide-motion-vue) into React data.
//
//   node scripts/port-motion-icons.mjs [path/to/lucide-motion-vue]
//
// Without a path it shallow-clones the repo into the OS temp dir. The Vue
// SFCs come in two generated shapes — a hand-templated `<motion.svg>` with an
// `animations` object beside it, and a data-driven `MultiVariantIcon` — and
// both reduce to the same thing: an element tree plus Motion variants. The
// variants are plain Motion data, which `motion/react` reads exactly as
// `motion-v` does, so they are copied as-is. Only the `default` animation is
// kept; `AnimatedIcon` never asks for another.
//
// Output: src/components/ui/icons/motionData.ts (generated — re-run, don't edit).

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** kebab icon name in the Vue repo → the lucide-react export it animates. */
const ICONS = {
  'arrow-left': 'ArrowLeft',
  'arrow-right': 'ArrowRight',
  bot: 'Bot',
  box: 'Box',
  brush: 'Brush',
  check: 'Check',
  'check-check': 'CheckCheck',
  'chevron-down': 'ChevronDown',
  'chevron-left': 'ChevronLeft',
  'chevron-right': 'ChevronRight',
  'circle-help': 'CircleHelp',
  code: 'Code',
  coffee: 'Coffee',
  contrast: 'Contrast',
  copy: 'Copy',
  download: 'Download',
  expand: 'Expand',
  'external-link': 'ExternalLink',
  eye: 'Eye',
  'eye-off': 'EyeOff',
  feather: 'Feather',
  folder: 'Folder',
  frame: 'Frame',
  'grip-vertical': 'GripVertical',
  group: 'Group',
  hand: 'Hand',
  heart: 'Heart',
  history: 'History',
  layers: 'Layers',
  'layout-grid': 'LayoutGrid',
  lightbulb: 'Lightbulb',
  'link-2': 'Link2',
  lock: 'Lock',
  'map-pin': 'MapPin',
  'maximize-2': 'Maximize2',
  menu: 'Menu',
  moon: 'Moon',
  'pen-tool': 'PenTool',
  play: 'Play',
  plus: 'Plus',
  redo: 'Redo',
  'refresh-cw': 'RefreshCw',
  'rotate-ccw': 'RotateCcw',
  'rotate-cw': 'RotateCw',
  scissors: 'Scissors',
  search: 'Search',
  shrink: 'Shrink',
  'sliders-horizontal': 'SlidersHorizontal',
  sparkles: 'Sparkles',
  star: 'Star',
  sun: 'Sun',
  terminal: 'Terminal',
  timer: 'Timer',
  'toggle-left': 'ToggleLeft',
  'toggle-right': 'ToggleRight',
  'trash-2': 'Trash2',
  undo: 'Undo',
  upload: 'Upload',
  'wand-sparkles': 'WandSparkles',
  x: 'X',
}

const REPO = 'https://github.com/respeak-io/lucide-motion-vue'
let root = process.argv[2]
if (!root) {
  root = join(mkdtempSync(join(tmpdir(), 'lmv-')), 'lucide-motion-vue')
  execFileSync('git', ['clone', '-q', '--depth', '1', REPO, root], { stdio: 'inherit' })
}
const commit = execFileSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD']).toString().trim()

/**
 * Evaluates the script's top-level data: every column-0 `const` (shared
 * transitions, `v-for` lists, `animations`) except the component plumbing,
 * in source order so one may use another. Types are stripped properly rather than by
 * pattern, because some variants are functions of Motion's `custom`
 * (`(custom: number) => ({…})`). Returns the values by name.
 */
const RUNTIME = new Set(['props', 'variants', 'selfWrap'])

function scriptConsts(src) {
  const script = src.slice(src.indexOf('<script'), src.indexOf('</script>'))
  const lines = script.split(/\r?\n/)
  const decls = []
  for (let i = 0; i < lines.length; i++) {
    const m = /^const (\w+)\b/.exec(lines[i])
    if (!m || RUNTIME.has(m[1])) continue
    let j = i + 1
    while ((j < lines.length && !/^\S/.test(lines[j])) || /^[}\])]/.test(lines[j] ?? '')) j++
    decls.push({ name: m[1], text: lines.slice(i, j).join('\n') })
  }
  const js = stripTypeScriptTypes(decls.map((d) => d.text).join('\n'))
  // motion-v's `cubicBezier(a, b, c, d)` builds an easing function; Motion
  // takes the bare `[a, b, c, d]` as the same curve, and that serializes.
  const cubicBezier = (...points) => points
  return new Function('cubicBezier', `${js}\nreturn { ${decls.map((d) => d.name).join(', ')} }`)(cubicBezier)
}

const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase())

function styleObject(css) {
  const out = {}
  for (const decl of css.split(';')) {
    const [k, ...v] = decl.split(':')
    if (k.trim() && v.length) out[camel(k.trim())] = v.join(':').trim()
  }
  return out
}

/** Element attrs from the Vue form to the React form; `key` from `:variants`. */
function convertAttrs(raw, file, scope) {
  const el = { attrs: {} }
  for (const [, name, value] of raw.matchAll(/([:@]?[\w-]+)(?:="([^"]*)")?/g)) {
    if (name.startsWith('@') || name === 'initial' || name === ':animate' || name === ':key' || name.startsWith('v-'))
      continue
    if (name === ':variants') {
      const m = /^variants\.(\w+)$/.exec(value)
      if (!m) throw new Error(`${file}: unexpected :variants="${value}"`)
      el.key = m[1]
    } else if (name === 'style') {
      el.style = styleObject(value)
    } else if (name.startsWith(':')) {
      // Numbers and strings are SVG attributes; an object is a Motion prop
      // (`:transition`), and `:custom` feeds function variants — both pass
      // straight through to the motion element.
      let v
      try {
        v = Function(...Object.keys(scope), `return (${value})`)(...Object.values(scope))
      } catch {
        throw new Error(`${file}: ${name}="${value}" reads component state`)
      }
      el.attrs[camel(name.slice(1))] = v
    } else {
      el.attrs[name === 'class' ? 'className' : camel(name)] = value
    }
  }
  return el
}

/**
 * Parses the children of the template's `<motion.svg>` into an element tree.
 * A `v-for="(item, index) in LIST"` is unrolled over the script's `const LIST`.
 */
function parseTemplate(src, file, consts) {
  const open = src.search(/<motion\.svg\b/)
  const body = src.slice(src.indexOf('>', open) + 1, src.lastIndexOf('</motion.svg>'))
  const top = []
  const stack = [{ children: top }]
  for (const m of body.matchAll(/<(\/?)(?:motion\.)?(\w+)((?:\s+[:@\w-]+(?:="[^"]*")?)*)\s*(\/?)>/g)) {
    const [, closing, tag, attrs, selfClosing] = m
    if (closing) {
      stack.pop()
      continue
    }
    const parent = stack[stack.length - 1]
    const loop = /v-for="\((\w+)(?:,\s*(\w+))?\)\s+in\s+(\w+)"/.exec(attrs)
    if (loop) {
      if (!selfClosing) throw new Error(`${file}: v-for on a container`)
      const [, item, index = '__index', list] = loop
      consts[list].forEach((value, i) => {
        ;(parent.children ??= []).push({ tag, ...convertAttrs(attrs, file, { ...consts, [item]: value, [index]: i }) })
      })
      continue
    }
    const el = { tag, ...convertAttrs(attrs, file, consts) }
    ;(parent.children ??= []).push(el)
    if (!selfClosing) stack.push(el)
  }
  // Some icons (feather, hand) animate the `<motion.svg>` itself. The React
  // wrapper owns the svg, so that motion moves onto a group around the body.
  const root = /:variants="variants\.(\w+)"/.exec(src.slice(open, src.indexOf('>', open)))
  if (root) return [{ tag: 'g', attrs: {}, key: root[1], children: top }]
  return top
}

/** MultiVariant data: kebab attrs → React camelCase, recursively. */
function reactifyElements(elements) {
  return elements.map((e) => {
    const attrs = {}
    let style
    for (const [k, v] of Object.entries(e.attrs ?? {})) {
      if (k === 'style') style = typeof v === 'string' ? styleObject(v) : v
      else attrs[k === 'class' ? 'className' : camel(k)] = v
    }
    if (e.paths) throw new Error(`${e.tag}: morph chains are not ported`)
    const out = { tag: e.tag, attrs }
    if (e.key) out.key = e.key
    if (style) out.style = style
    if (e.children) out.children = reactifyElements(e.children)
    return out
  })
}

function port(name) {
  const file = join(root, 'src/icons', `${name}.vue`)
  const src = readFileSync(file, 'utf8')
  const source = /Source: hand-written|hand-written/.test(src.slice(0, 600)) ? 'hand-written' : 'animate-ui'
  const consts = scriptConsts(src)
  closure = consts
  if (/MultiVariantIcon/.test(src)) {
    const def = consts.animations.default ?? Object.values(consts.animations)[0]
    return { source, elements: reactifyElements(def.elements), variants: def.variants }
  }
  return { source, elements: parseTemplate(src, file, consts), variants: consts.animations.default }
}

/** The SFC consts the value being serialized was evaluated against. */
let closure = {}

/** JS source for a value — JSON plus `Infinity`, with bare keys where legal. */
function toJs(v, indent = '') {
  // A `custom` variant: its parameter is Motion's per-element `custom` number.
  if (typeof v === 'function') {
    const fn = v.toString().replace(/^\(([^)]*)\)\s*=>/, (_, p) => `(${p.trim()}: any) =>`)
    // A variant function may read the SFC's other consts (`ROWS`): bind the
    // ones it names around it, so the emitted function stands alone.
    const free = Object.keys(closure).filter((k) => k !== 'animations' && new RegExp(String.raw`\b${k}\b`).test(fn))
    if (!free.length) return fn
    return `((${free.map((k) => `${k}: any`).join(', ')}) => ${fn})(${free.map((k) => toJs(closure[k], indent)).join(', ')})`
  }
  if (v === Infinity) return 'Infinity'
  if (v === -Infinity) return '-Infinity'
  if (Array.isArray(v)) {
    if (v.every((x) => typeof x !== 'object' || x === null)) return `[${v.map((x) => toJs(x)).join(', ')}]`
    return `[\n${v.map((x) => `${indent}  ${toJs(x, indent + '  ')}`).join(',\n')},\n${indent}]`
  }
  if (v && typeof v === 'object') {
    const keys = Object.keys(v)
    if (!keys.length) return '{}'
    const key = (k) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k))
    return `{\n${keys.map((k) => `${indent}  ${key(k)}: ${toJs(v[k], indent + '  ')}`).join(',\n')},\n${indent}}`
  }
  return JSON.stringify(v)
}

const lines = [
  '// GENERATED by scripts/port-motion-icons.mjs — do not edit; re-run the script.',
  `// Source: ${REPO} @ ${commit}`,
  '// Geometry: Lucide (ISC). Motion: animate-ui (MIT + Commons Clause) and',
  '// lucide-motion-vue hand-written (MIT) — the comment on each icon says which.',
  '',
  "import type { MotionIconData } from './motionTypes'",
  '',
]
for (const [name, exportName] of Object.entries(ICONS)) {
  const data = port(name)
  lines.push(`/** ${name} (${data.source}) */`)
  lines.push(
    `export const ${exportName}: MotionIconData = ${toJs({ name, elements: data.elements, variants: data.variants })}`,
  )
  lines.push('')
}
const out = 'src/components/ui/icons/motionData.ts'
writeFileSync(out, lines.join('\n'))

// The app's one icon module: all of lucide-react, with the animated ones
// shadowing their static exports (a local export wins over `export *`).
const names = Object.values(ICONS)
const index = [
  '// GENERATED by scripts/port-motion-icons.mjs — do not edit; re-run the script.',
  '// Import icons from HERE, not from lucide-react: an icon listed below animates',
  '// when its control is hovered; every other lucide icon passes through static.',
  '',
  "export * from 'lucide-react'",
  'import {',
  ...names.map((n) => `  ${n} as ${n}Static,`),
  "} from 'lucide-react'",
  "import { animated } from './AnimatedIcon'",
  "import * as data from './motionData'",
  '',
  ...names.map((n) => `export const ${n} = /* @__PURE__ */ animated(${n}Static, data.${n})`),
  '',
]
writeFileSync('src/components/ui/icons/index.ts', index.join('\n'))
console.log(`${names.length} icons → ${out} + index.ts (${commit})`)
