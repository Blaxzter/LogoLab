// Generates the LINE-ART corpus for the centreline tracer (src/lib/trace/centerline/):
// the ⌇ lane of /labs/ab and the answer sheet of test/centerline-gate.test.ts.
//
//     node bench/genLineArt.ts
//
// Every case is authored with STROKES, on purpose, and that is the opposite of the rule
// genEdgeCases.ts follows. There, a stroked element is refused as ground truth because the
// visible boundary is the OUTLINE of the stroke, not the `d` — and an outline tracer is
// scored on boundaries. A centreline tracer is scored on the opposite thing: the `d` IS the
// answer, and `stroke-width` is the second answer. So here the authored file is exact ground
// truth for exactly the quantities the engine has to recover (bench/lineArtGround.ts reads
// it), and svgGround.ts still refuses it for the outline lanes, which is right.
//
// Two lanes of cases:
//   ⌇ synthetic — one mechanism each (corners, curves, junctions, closed loops, the
//     stroke→fill width ladder, caps and joins, a sheet of music, hairlines). viewBox 256,
//     traced at 512 by the A/B line lane, so 1 unit = 2 px: widths 1–9 u are 2–18 px strokes.
//   ◎ lucide — real monoline icons (Lucide, ISC; the app already ships lucide-react), the
//     class of art D3 in docs/pre-release-backlog.md names: 24-unit icons at stroke 2 with
//     round caps and joins. Framed into the same 256 box at ×8, so a 512 raster has 32 px
//     strokes — the "rendered icon PNG" regime — and the lab's raster switch reaches the
//     thin end (128 px ⇒ 8 px strokes).
//
// Dev/test only; never bundled (scripts/swPlugin.ts skips examples/line-art).

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { subPathsToD } from '../src/lib/path/model.ts'
import { faceFromBytes } from '../src/lib/text/engine.ts'
import { makeTextGroup, newTextData, replaceText } from '../src/lib/text/edit.ts'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const V = 256
const INK = 'rgb(26,26,34)'
const f = (n: number): string => String(Number(n.toFixed(3)))

const svg = (body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${V}" height="${V}" viewBox="0 0 ${V} ${V}">${body}</svg>\n`

/** A group of strokes with one width / cap / join. */
function strokes(w: number, cap: 'butt' | 'round' | 'square', join: 'miter' | 'round' | 'bevel', body: string): string {
  return `<g fill="none" stroke="${INK}" stroke-width="${f(w)}" stroke-linecap="${cap}" stroke-linejoin="${join}">${body}</g>`
}
const fills = (body: string): string => `<g fill="${INK}" stroke="none">${body}</g>`
const path = (d: string): string => `<path d="${d}"/>`

/** A rounded rectangle as an explicit cubic path (no `rx` — the readers model paths, not rounded rects). */
function roundedRect(x: number, y: number, w: number, h: number, r: number): string {
  const k = 0.5522847498 * r
  return (
    `M${f(x + r)},${f(y)} H${f(x + w - r)} C${f(x + w - r + k)},${f(y)} ${f(x + w)},${f(y + r - k)} ${f(x + w)},${f(y + r)} ` +
    `V${f(y + h - r)} C${f(x + w)},${f(y + h - r + k)} ${f(x + w - r + k)},${f(y + h)} ${f(x + w - r)},${f(y + h)} ` +
    `H${f(x + r)} C${f(x + r - k)},${f(y + h)} ${f(x)},${f(y + h - r + k)} ${f(x)},${f(y + h - r)} ` +
    `V${f(y + r)} C${f(x)},${f(y + r - k)} ${f(x + r - k)},${f(y)} ${f(x + r)},${f(y)} Z`
  )
}

/** An Archimedean spiral (r = a + b·θ) as quarter-turn elliptical-arc-free cubics: sampled
 *  densely and fitted per quarter turn with the standard 4-point cubic through the samples
 *  (Catmull-style), which keeps the authored node count small and the curve smooth. */
function spiral(cx: number, cy: number, a: number, b: number, turns: number): string {
  const pts: { x: number; y: number }[] = []
  const N = Math.round(turns * 4)
  for (let i = 0; i <= N * 8; i++) {
    const t = (i / (N * 8)) * turns * 2 * Math.PI
    const r = a + b * t
    pts.push({ x: cx + r * Math.cos(t), y: cy + r * Math.sin(t) })
  }
  // Catmull–Rom → cubic Bézier through every 8th sample (one node per eighth turn).
  let d = `M${f(pts[0].x)},${f(pts[0].y)}`
  for (let i = 0; i + 8 <= pts.length - 1; i += 8) {
    const p0 = pts[Math.max(0, i - 8)]
    const p1 = pts[i]
    const p2 = pts[i + 8]
    const p3 = pts[Math.min(pts.length - 1, i + 16)]
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 }
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 }
    d += ` C${f(c1.x)},${f(c1.y)} ${f(c2.x)},${f(c2.y)} ${f(p2.x)},${f(p2.y)}`
  }
  return d
}

/** A line of text as glyph OUTLINES (fills), laid out by the app's own HarfBuzz engine on
 *  the bundled Inter — deterministic, no system fonts. Baseline starts at (x, y). */
function caption(text: string, x: number, y: number, size: number, weight: number): string {
  const bytes = readFileSync(join(ROOT, 'public', 'fonts', 'inter.ttf'))
  const face = faceFromBytes(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
  const data = replaceText(newTextData({ x, y }, size, { weight }), 0, 0, text)
  const group = makeTextGroup('caption', data, () => ({ face, synthItalic: false }))
  return group.children.map((c) => (c.kind === 'path' ? `<path d="${subPathsToD(c.subPaths, 3)}"/>` : '')).join('')
}

/** One S-curve, its own width — the ladder's repeating unit. */
const sCurve = (x: number, y: number, h: number): string =>
  `M${f(x)},${f(y)} C${f(x + 22)},${f(y)} ${f(x - 6)},${f(y + h)} ${f(x + 16)},${f(y + h)}`

// ---------------------------------------------------------------------------
// ⌇ synthetic cases
// ---------------------------------------------------------------------------

interface Case {
  name: string
  note: string
  make: () => string
}

const SYNTHETIC: Case[] = [
  {
    name: 'la-polylines',
    note: 'open polylines: a zigzag of 30–110° corners (round), an L (miter, butt caps), a staircase (square caps)',
    make: () =>
      svg(
        strokes(3, 'round', 'round', path('M16,30 L48,150 L80,30 L128,150 L176,30 L240,150')) +
          strokes(4, 'butt', 'miter', path('M24,236 L24,190 L96,190')) +
          strokes(2, 'square', 'miter', path('M128,236 h16 v-12 h16 v-12 h16 v-12 h16 v-12 h16')),
      ),
  },
  {
    name: 'la-curves',
    note: 'smooth open curves: a double S, a sine wave, a self-crossing loop, a spiral — no authored corners',
    make: () =>
      svg(
        strokes(3, 'round', 'round', path('M16,40 C90,40 40,110 110,110 C180,110 130,180 236,180')) +
          strokes(
            2,
            'round',
            'round',
            path('M16,224 C32,196 48,196 64,224 S96,252 112,224 S144,196 160,224 S192,252 208,224 S240,196 248,224'),
          ) +
          strokes(3, 'round', 'round', path('M140,24 C240,24 240,96 190,96 C140,96 140,40 236,56')) +
          strokes(2.5, 'round', 'round', path(spiral(60, 150, 3, 3.2, 2.25))),
      ),
  },
  {
    name: 'la-junctions',
    note: 'T, Y, X at 90° and 33°, a # grid, a 4-line asterisk, a K — where centrelines meet',
    make: () =>
      svg(
        strokes(
          4,
          'round',
          'round',
          path('M20,30 L80,30 M50,30 L50,90') + // T
            path('M110,90 L140,50 L170,90 M140,50 L140,20') + // Y
            path('M190,20 L240,70 M240,20 L190,70'), // X at 90°
        ) +
          strokes(
            3,
            'round',
            'round',
            path('M20,140 L120,110 M20,110 L120,140') + // X at 33°
              path('M150,105 v60 M175,105 v60 M140,120 h60 M140,150 h60') + // # grid
              path('M30,205 h80 M70,165 v80 M42,177 L98,233 M98,177 L42,233') + // asterisk
              path('M150,180 v60 M150,210 L200,180 M150,210 L200,240'), // K
          ),
      ),
  },
  {
    name: 'la-loops',
    note: 'closed strokes: a circle, a rounded square, a triangle (round joins), a figure-8 crossing itself',
    make: () =>
      svg(
        strokes(3, 'round', 'round', `<circle cx="60" cy="60" r="36"/>` + path(roundedRect(150, 20, 84, 84, 12))) +
          strokes(3, 'round', 'round', `<polygon points="60,150 20,230 100,230"/>`) +
          strokes(
            2.5,
            'round',
            'round',
            // A lemniscate whose lobes cross at the centre (≈77°), not touch.
            path('M130,200 C130,150 210,250 210,200 C210,150 130,250 130,200 Z'),
          ),
      ),
  },
  {
    name: 'la-widths',
    note: 'one S at widths 1→9 u (2–18 px @512), then a lollipop (stroke out of a filled disc) and a stroke leaving a filled square: where a stroke ends and a fill begins',
    make: () => {
      const widths = [1, 1.5, 2, 3, 4, 6, 9]
      let body = ''
      widths.forEach((w, i) => {
        body += strokes(w, 'round', 'round', path(sCurve(14 + i * 34, 24, 90)))
      })
      body += fills(`<circle cx="40" cy="190" r="16"/>` + `<rect x="170" y="172" width="36" height="36"/>`)
      body += strokes(3, 'round', 'round', path('M40,190 L130,190') + path('M206,190 L244,190'))
      return svg(body)
    },
  },
  {
    name: 'la-caps',
    note: 'butt / round / square caps at 8 u and 2 u; miter / round / bevel joins on chevrons; a 14° miter that exceeds the miter limit',
    make: () =>
      svg(
        strokes(8, 'butt', 'miter', path('M30,40 h80')) +
          strokes(8, 'round', 'miter', path('M30,70 h80')) +
          strokes(8, 'square', 'miter', path('M30,100 h80')) +
          strokes(8, 'butt', 'miter', path('M150,30 L190,70 L230,30')) +
          strokes(8, 'butt', 'round', path('M150,80 L190,120 L230,80')) +
          strokes(8, 'butt', 'bevel', path('M150,130 L190,170 L230,130')) +
          strokes(2, 'butt', 'miter', path('M30,200 h80')) +
          strokes(2, 'round', 'miter', path('M30,215 h80')) +
          strokes(2, 'square', 'miter', path('M30,230 h80')) +
          strokes(6, 'butt', 'miter', path('M150,190 L230,200 L150,210')),
      ),
  },
  {
    name: 'la-score',
    note: 'sheet music: 1 u staff lines (2 px @512), 1.5 u barlines, 1.2 u stems into FILLED note heads, a 1 u slur, a flag',
    make: () => {
      const staff = [100, 108, 116, 124, 132].map((y) => `M16,${y} H240`).join(' ')
      const heads = [
        [50, 116],
        [90, 108],
        [170, 124],
        [210, 112],
      ]
      const headEls = heads
        .map(([x, y]) => `<ellipse cx="${x}" cy="${y}" rx="5.2" ry="3.6" transform="rotate(-20 ${x} ${y})"/>`)
        .join('')
      const stems = heads.map(([x, y]) => `M${x + 4.6},${y - 1.2} V${y - 30}`).join(' ')
      return svg(
        strokes(1, 'butt', 'miter', path(staff)) +
          strokes(1.5, 'butt', 'miter', path('M16,100 V132 M128,100 V132 M240,100 V132')) +
          fills(headEls) +
          strokes(1.2, 'butt', 'miter', path(stems)) +
          strokes(1, 'round', 'round', path('M50,92 C80,70 140,70 170,98')) +
          strokes(1.5, 'round', 'round', path('M214.6,82 c8,8 10,14 4,24')),
      )
    },
  },
  {
    name: 'la-hairline',
    note: '0.5–1.25 u strokes (1–2.5 px @512): at and below the sub-pixel floor, plus a 0.75 u circle',
    make: () =>
      svg(
        strokes(0.5, 'butt', 'miter', path('M20,40 L236,60')) +
          strokes(0.75, 'butt', 'miter', path('M20,80 L236,100')) +
          strokes(1, 'butt', 'miter', path('M20,120 L236,140')) +
          strokes(1.25, 'butt', 'miter', path('M20,160 L236,180')) +
          strokes(0.75, 'butt', 'miter', `<circle cx="128" cy="215" r="30"/>`),
      ),
  },
  // ---- The field report's three defects (§39.8): an agent turned ten Gemini icon sheets
  // into a set with `split_icon_sheet` + strokes and named what came back wrong. One
  // mechanism each, scaled to the art that showed it.
  {
    name: 'la-hub',
    note: 'a windmill hub: four outlined sails whose edges meet a small ring (centreline radius 1.4 W) in V pairs ON the ring',
    make: () => {
      // Ring of centreline radius R; each sail's edges sit ±h off its axis, h = R/√2, so
      // two neighbouring sails' edges cross exactly on the ring (as the windmills draw it).
      const cx = 128
      const cy = 128
      const R = 13
      const h = R / Math.SQRT2
      const tip = 96
      let body = ''
      for (const deg of [-135, -45, 45, 135]) {
        const a = (deg * Math.PI) / 180
        const u = { x: Math.cos(a), y: Math.sin(a) }
        const n = { x: -u.y, y: u.x }
        const at = (side: number, t: number) =>
          `${f(cx + side * h * n.x + t * u.x)},${f(cy + side * h * n.y + t * u.y)}`
        body += path(`M${at(1, h)} L${at(1, tip)} L${at(-1, tip)} L${at(-1, h)}`)
      }
      return svg(strokes(9, 'round', 'round', `<circle cx="${cx}" cy="${cy}" r="${R}"/>` + body))
    },
  },
  {
    name: 'la-cup',
    note: 'a trophy crossed by a putter whose shaft is a DOUBLE line (two thin strokes, a one-unit gap) crossing the bowl where it turns into the stem, its club head looped back beside the crossing',
    make: () =>
      svg(
        // The cup: rim, bowl sides curving into the stem, a flat foot (T-joined, no acute corners).
        strokes(
          7.5,
          'round',
          'round',
          path('M56,40 H200 C200,104 166,136 142,150 V214') +
            path('M56,40 C56,104 90,136 114,150 V214') +
            path('M86,214 H170'),
        ) +
          // The shaft: two 4 u strokes 5 u apart — a 1 u gap, which at the sheet's 86 px tile
          // was under a pixel and half closed by the cut.
          strokes(4, 'round', 'round', path('M190,10 L60,186') + path('M194.02,12.97 L64.02,188.97')) +
          // The club head: a loop leaving the shaft's foot and coming back up beside it.
          strokes(5, 'round', 'round', path('M62,187.5 C44,206 22,200 30,184 C36,172 70,170 104,150')),
      ),
  },
  {
    name: 'la-stubs',
    note: 'faint texture touching thick strokes (no thin stub strokes may come of it) beside a thin line hanging off a thick bar, a dashed line and dots (all kept)',
    make: () => {
      // The texture is drawn but is not part of the answer (data-ground="none"): faint
      // radial specks on the inside of a ring and under a bar, like the dimples on the
      // sheet's golf balls where they touch the ball's outline. Read by the profile they
      // are ~0.25 W wide and run ~2 W from the stroke they hang off (§39.8).
      const speck = (cx: number, cy: number, deg: number): string =>
        `<ellipse cx="${f(cx)}" cy="${f(cy)}" rx="1.6" ry="6" transform="rotate(${deg} ${f(cx)} ${f(cy)})"/>`
      const ring = { cx: 80, cy: 80 }
      const onRing = (deg: number): string => {
        const a = (deg * Math.PI) / 180
        return speck(ring.cx + 25 * Math.cos(a), ring.cy + 25 * Math.sin(a), deg + 90)
      }
      const texture = `<g fill="rgb(110,110,118)" stroke="none" data-ground="none">${onRing(40)}${onRing(165)}${speck(176, 55.5, 0)}</g>`
      return svg(
        strokes(8, 'round', 'round', `<circle cx="${ring.cx}" cy="${ring.cy}" r="34"/>` + path('M140,46 H236')) +
          texture +
          // A thin line hanging off the bar: thinner than the bar, but long — a stroke.
          strokes(2.5, 'round', 'round', path('M212,46 V120')) +
          strokes(
            2.5,
            'butt',
            'round',
            path(Array.from({ length: 12 }, (_, i) => `M${f(20 + i * 18)},170 h9`).join(' ')),
          ) +
          strokes(
            2.5,
            'round',
            'round',
            path(Array.from({ length: 6 }, (_, i) => `M${f(132 + i * 12)},${f(126 + (i % 2) * 8)} l3,2`).join(' ')),
          ) +
          fills(Array.from({ length: 6 }, (_, i) => `<circle cx="${f(40 + i * 32)}" cy="214" r="2.2"/>`).join('')),
      )
    },
  },
  {
    name: 'la-arrows',
    note: 'three thick down-arrows whose arrowhead arms run 2, 2.5 and 3 widths from the tip: where three strokes merge, a real arm must not be pruned as a spur',
    make: () => {
      const w = 10
      let body = ''
      ;[2, 2.5, 3].forEach((k, i) => {
        const x = 52 + i * 76
        const a = (k * w) / Math.SQRT2
        body += path(`M${x},40 V180`) + path(`M${f(x - a)},${f(180 - a)} L${x},180 L${f(x + a)},${f(180 - a)}`)
      })
      return svg(strokes(w, 'round', 'round', body))
    },
  },
  {
    name: 'la-y-corner',
    note: 'an envelope whose V ends ON the rounded corners (as a generated mail icon draws it, not as Lucide does): top, side and V meet with no two in line, so no stroke runs through the junction to cover the ends',
    make: () => {
      const x = 40
      const y = 64
      const w = 176
      const r = 23
      // The V's ends: 70° round each corner arc from the top (near where the side starts),
      // on the rect's centreline; its arms fall at 34°. The style-reference sheet's mail.
      const t = (70 * Math.PI) / 180
      const ex = r - r * Math.sin(t)
      const ey = r - r * Math.cos(t)
      const vy = y + ey + (w / 2 - ex) * Math.tan((34 * Math.PI) / 180)
      return svg(
        strokes(
          16,
          'round',
          'round',
          path(roundedRect(x, y, w, 128, r)) +
            path(`M${f(x + ex)},${f(y + ey)} L128,${f(vy)} L${f(x + w - ex)},${f(y + ey)}`),
        ),
      )
    },
  },
  {
    name: 'la-hybrid',
    note: 'a QR-like block of filled modules and a bold caption ("Pro Shop", Inter Bold outlines) beside clean strokes: block and caption come back as fills, the strokes — and the finder squares, clean square rings — as strokes',
    make: () => {
      // 21×21 modules of 5 u, three finder patterns, a fixed pseudo-random fill.
      const M = 5
      const x0 = 14
      const y0 = 14
      const N = 21
      const finders = [
        [0, 0],
        [0, N - 7],
        [N - 7, 0],
      ]
      const on = (r: number, c: number): boolean => {
        // The three finder patterns (drawn below), each with its one-module separator; the
        // modules here are only their 3×3 centres.
        for (const [fr, fc] of finders) {
          if (r < fr - 1 || r > fr + 7 || c < fc - 1 || c > fc + 7) continue
          return Math.max(Math.abs(r - fr - 3), Math.abs(c - fc - 3)) <= 1
        }
        let x = (r * 73856093) ^ (c * 19349663) ^ 0x5bd1e995
        x = Math.imul(x ^ (x >>> 13), 0x5bd1e995)
        return ((x ^ (x >>> 15)) & 7) < 4
      }
      let rects = ''
      for (let r = 0; r < N; r++)
        for (let c = 0; c < N; c++)
          if (on(r, c)) rects += `<rect x="${x0 + c * M}" y="${y0 + r * M}" width="${M}" height="${M}"/>`
      // A finder's outer ring is a square ring one module wide: line art, and the answer
      // says so (a stroked square on its centreline).
      const rings = finders
        .map(
          ([fr, fc]) =>
            `<rect x="${x0 + fc * M + M / 2}" y="${y0 + fr * M + M / 2}" width="${6 * M}" height="${6 * M}"/>`,
        )
        .join('')
      return svg(
        fills(rects + caption('Pro Shop', 18, 172, 30, 700)) +
          strokes(M, 'butt', 'miter', rings) +
          strokes(
            5,
            'round',
            'round',
            `<circle cx="196" cy="62" r="34"/>` + path('M176,200 L194,218 L238,168') + path('M18,236 H238'),
          ),
      )
    },
  },
]

// ---------------------------------------------------------------------------
// ◎ Lucide icons — read straight out of the installed lucide-react package
// ---------------------------------------------------------------------------

/** The icons, and what each brings: circles inside paths, dots (a stroked r=1 circle at
 *  width 2 is a solid disc), long sweeps, tight curls, dense junctions. */
const LUCIDE: { name: string; why: string }[] = [
  { name: 'house', why: 'a door inside a roof — a closed outline with a T on each side' },
  { name: 'bell', why: 'one long symmetric sweep plus a tiny clapper arc' },
  { name: 'settings', why: 'a 12-lobed gear outline around a small circle' },
  { name: 'search', why: 'a circle with a handle: a stroke leaving a ring tangentially' },
  { name: 'mail', why: 'a rounded rect crossed by a V — three junctions on one edge' },
  { name: 'heart', why: 'a single closed curve with one sharp cusp' },
  { name: 'git-branch', why: 'three small rings joined by short straight and curved runs' },
  { name: 'shopping-cart', why: 'two solid dots (stroked r=1 at width 2) under an open polyline' },
  { name: 'umbrella', why: 'a scalloped arc, a stem through it, a hooked handle' },
  { name: 'map-pin', why: 'a teardrop with a small ring inside' },
  { name: 'camera', why: 'a rounded body with a lens ring inside — a ring inside a closed outline' },
  { name: 'star', why: 'ten sharp corners on one closed polyline' },
]

/** The icon's SVG elements, straight from lucide-react's ESM module for it. The module is
 *  `const __iconNode = [ ["path", { d: "…", key }], ["circle", {…}] ]` — evaluated as an
 *  expression rather than re-parsed, since it is a build artifact of a package we ship. */
function lucideNodes(name: string): [string, Record<string, string>][] {
  const file = join(ROOT, 'node_modules', 'lucide-react', 'dist', 'esm', 'icons', `${name}.mjs`)
  const src = readFileSync(file, 'utf8')
  const m = /const __iconNode = (\[[\s\S]*?\]);\n/.exec(src)
  if (!m) throw new Error(`no __iconNode in ${file}`)
  return new Function(`return ${m[1]}`)() as [string, Record<string, string>][]
}

const LUCIDE_LICENSE =
  'Lucide icon, ISC License, Copyright (c) 2026 Lucide Icons and Contributors — ' +
  'https://lucide.dev/license — reproduced here as a tracer test fixture.'

function lucideCase(name: string, why: string): Case {
  return {
    name: `lucide-${name}`,
    note: `Lucide "${name}": ${why}`,
    make: () => {
      const els = lucideNodes(name)
        .map(([tag, a]) => {
          const attrs = Object.entries(a)
            .filter(([k]) => k !== 'key')
            .map(([k, v]) => `${k}="${v}"`)
            .join(' ')
          return `<${tag} ${attrs}/>`
        })
        .join('')
      // 24-unit art framed into the 256 box at ×8 (192 u of art, 32 u of margin), stroke 2
      // as Lucide draws it. The transform is on the <g>, where every reader here expects it.
      return svg(
        `<!-- ${LUCIDE_LICENSE} -->` +
          `<g transform="translate(32 32) scale(8)">${strokes(2, 'round', 'round', els)}</g>`,
      )
    },
  }
}

// ---------------------------------------------------------------------------
// ⌇ COLOUR line art — several inks, for Strokes in Colour (centerline/colour.ts)
// ---------------------------------------------------------------------------
//
// Their own directory (public/examples/colour-line-art/), because the mono gate and
// lineArtGround read every line-art case as ONE ink. Each case is one mechanism of the
// colour path: crossings of two inks (the reason the union is traced, not a mask per
// ink), a line of one ink tied to a shape of another (the paint split at the node), a
// colour change with NO node (the known limit — majority ink), light ink on a coloured
// paper, inks on transparency, and overlapping loops (the engine's weak spot, in both
// modes). Plus Lucide icons with one ink per element.

const C = {
  red: 'rgb(214,48,49)',
  blue: 'rgb(40,98,214)',
  green: 'rgb(39,153,84)',
  orange: 'rgb(240,150,20)',
  purple: 'rgb(128,64,190)',
  pink: 'rgb(224,69,123)',
  ink: INK,
}

/** Strokes in one ink. */
function inked(color: string, w: number, body: string, cap: 'butt' | 'round' = 'round'): string {
  return `<g fill="none" stroke="${color}" stroke-width="${f(w)}" stroke-linecap="${cap}" stroke-linejoin="round">${body}</g>`
}

const COLOUR: Case[] = [
  {
    name: 'cl-crossings',
    note: 'two inks crossing: a red/blue X at 90°, a green/orange X at 33°, a # of red rows over blue columns',
    make: () =>
      svg(
        inked(C.blue, 4, path('M64,16 V112')) +
          inked(C.red, 4, path('M16,64 H112')) +
          inked(C.orange, 4, path('M150,20 L230,110')) +
          inked(C.green, 4, path('M150,110 L230,20')) +
          inked(C.blue, 4, path('M96,140 V240 M160,140 V240')) +
          inked(C.red, 4, path('M64,172 H192 M64,208 H192')),
      ),
  },
  {
    name: 'cl-ties',
    note: 'a line of one ink leaving a shape of another: a kite and its string, a balloon ring and its tail, a T of two inks',
    make: () =>
      svg(
        inked(C.pink, 4, path('M60,20 L96,56 L60,92 L24,56 Z')) +
          inked(C.ink, 3, path('M60,92 C50,130 80,150 66,200')) +
          inked(C.blue, 4, `<circle cx="170" cy="60" r="34"/>`) +
          inked(C.orange, 3, path('M170,94 C160,120 190,140 176,170')) +
          inked(C.purple, 4, path('M110,236 H240')) +
          inked(C.green, 4, path('M210,236 V190')),
      ),
  },
  {
    name: 'cl-handover',
    note: 'a colour change with NO node (red then blue on one straight line — majority ink, the known limit) and one AT a corner (an L)',
    make: () =>
      svg(
        inked(C.red, 4, path('M20,60 H128'), 'butt') +
          inked(C.blue, 4, path('M128,60 H236'), 'butt') +
          inked(C.green, 4, path('M40,120 V220')) +
          inked(C.purple, 4, path('M40,220 H200')),
      ),
  },
  {
    name: 'cl-paper',
    note: 'light inks on a navy paper: white and yellow strokes, a crossing between them',
    make: () =>
      svg(
        `<rect width="${V}" height="${V}" fill="rgb(22,33,78)"/>` +
          inked('rgb(255,255,255)', 4, path('M30,60 C90,20 160,100 226,60')) +
          inked('rgb(250,210,60)', 4, path('M128,30 V226')) +
          inked('rgb(255,255,255)', 4, `<circle cx="128" cy="170" r="44"/>`),
      ),
  },
  {
    name: 'cl-transparent',
    note: 'inks on TRANSPARENCY (no paper colour): a white stroke beside a red and a blue one — coverage comes from alpha',
    make: () =>
      svg(
        inked('rgb(255,255,255)', 5, path('M30,50 H226')) +
          inked(C.red, 5, path('M30,128 C100,90 156,166 226,128')) +
          inked(C.blue, 5, path('M30,206 H226')),
      ),
  },
  {
    name: 'cl-loops',
    note: 'overlapping LOOPS of different inks: two interlocked rings, three petals over a centre ring — the engine is weak here in mono too',
    make: () =>
      svg(
        inked(C.blue, 4, `<circle cx="70" cy="70" r="40"/>`) +
          inked(C.red, 4, `<circle cx="120" cy="70" r="40"/>`) +
          inked(
            C.pink,
            4,
            `<circle cx="128" cy="160" r="30"/><circle cx="88" cy="196" r="30"/><circle cx="168" cy="196" r="30"/>`,
          ) +
          inked(C.orange, 4, `<circle cx="128" cy="190" r="18"/>`),
      ),
  },
]

/** A Lucide icon with one ink per ELEMENT, in the order given (cycling). */
function lucideColourCase(name: string, inks: string[], why: string): Case {
  return {
    name: `cl-lucide-${name}`,
    note: `Lucide "${name}" in colour: ${why}`,
    make: () => {
      const els = lucideNodes(name)
        .map(([tag, a], i) => {
          const attrs = Object.entries(a)
            .filter(([k]) => k !== 'key')
            .map(([k, v]) => `${k}="${v}"`)
            .join(' ')
          return `<${tag} ${attrs} stroke="${inks[i % inks.length]}"/>`
        })
        .join('')
      return svg(
        `<!-- ${LUCIDE_LICENSE} -->` +
          `<g transform="translate(32 32) scale(8)">${strokes(2, 'round', 'round', els)}</g>`,
      )
    },
  }
}

const LUCIDE_COLOUR: Case[] = [
  lucideColourCase('mail', [C.blue, C.red], 'a blue envelope crossed by a red V — three two-ink junctions on one edge'),
  lucideColourCase(
    'git-branch',
    [C.green, C.orange, C.purple, C.ink],
    'rings and runs in four inks, joined end to end',
  ),
  lucideColourCase('search', [C.ink, C.blue], 'a blue ring with a dark handle leaving it tangentially'),
  lucideColourCase('umbrella', [C.ink, C.ink, C.red], 'a red canopy with a dark stem running through it'),
  lucideColourCase('camera', [C.ink, C.blue], 'a dark body with a blue lens ring inside'),
]

// ---------------------------------------------------------------------------
// emit
// ---------------------------------------------------------------------------

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CASES: Case[] = [...SYNTHETIC, ...LUCIDE.map((l) => lucideCase(l.name, l.why))]

const dir = join(ROOT, 'public', 'examples', 'line-art')
mkdirSync(dir, { recursive: true })
for (const c of CASES) {
  writeFileSync(join(dir, `${c.name}.svg`), c.make())
  console.log(`  ${c.name}.svg  — ${c.note}`)
}
console.log(`\n${CASES.length} line-art SVGs written to public/examples/line-art/`)

const colourDir = join(ROOT, 'public', 'examples', 'colour-line-art')
mkdirSync(colourDir, { recursive: true })
const COLOUR_CASES = [...COLOUR, ...LUCIDE_COLOUR]
for (const c of COLOUR_CASES) {
  writeFileSync(join(colourDir, `${c.name}.svg`), c.make())
  console.log(`  ${c.name}.svg  — ${c.note}`)
}
console.log(`\n${COLOUR_CASES.length} colour line-art SVGs written to public/examples/colour-line-art/`)
