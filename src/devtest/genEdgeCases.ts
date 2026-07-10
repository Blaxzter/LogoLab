// Generates the HANDCRAFTED "difficult case" corpus for the tracer A/B view
// (vectorize-ab.html). Each case is authored as a SELF-CONTAINED SVG so the view can
// rasterize it at any input size (the resolution switch) — same vector content, varying
// raster resolution, which is the fair way to check whether the tracer's output is
// scale-stable. Re-run after editing a case:
//
//     node --experimental-strip-types src/devtest/genEdgeCases.ts
//
// The cases split into (1) the tracer work in this repo — posterized-ramp background
// reunification, the colour-class over-merge DELETE risk, near-coincident junction
// crossings (the weld), the render gate; and (2) classic hard cases every tracer
// struggles with — sub-pixel strokes, aliasing, primitive snapping, corners, hole
// topology, translucent overlap. Dev/test only; never bundled.

import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const V = 256 // viewBox side; the file is resolution-independent, this is just the unit grid
const rgb = (r: number, g: number, b: number): string => `rgb(${r},${g},${b})`
const svg = (body: string, defs = ''): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${V}" height="${V}" viewBox="0 0 ${V} ${V}">${defs ? `<defs>${defs}</defs>` : ''}${body}</svg>\n`

// palette
const WHITE = rgb(246, 246, 249)
const INK = rgb(26, 26, 34)
const NAVY = rgb(32, 46, 120)
const GOLD = rgb(226, 170, 40)
const RED = rgb(206, 44, 52)
const BLUE = rgb(42, 60, 200)

/** N-point star polygon points (outer/inner radii), first point up. */
function star(cx: number, cy: number, R: number, r: number, n = 5): string {
  const pts: string[] = []
  for (let i = 0; i < n * 2; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / n
    const rad = i % 2 === 0 ? R : r
    pts.push(`${(cx + rad * Math.cos(a)).toFixed(2)},${(cy + rad * Math.sin(a)).toFixed(2)}`)
  }
  return pts.join(' ')
}

// --- cases ------------------------------------------------------------------
const CASES: { name: string; note: string; make: () => string }[] = [
  {
    name: 'bg-ramp',
    note: 'smooth ramp → posterization bands (backgroundGradient)',
    make: () =>
      svg(
        `<rect width="${V}" height="${V}" fill="url(#ramp)"/>`,
        `<linearGradient id="ramp" x1="0" y1="0" x2="${V}" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${rgb(40, 66, 200)}"/><stop offset="1" stop-color="${rgb(206, 70, 44)}"/></linearGradient>`,
      ),
  },
  {
    name: 'bg-ramp-twin',
    note: 'a shape sharing a band colour (colour-class DELETE risk) + a distinct mark',
    make: () =>
      svg(
        `<rect width="${V}" height="${V}" fill="url(#ramp)"/>` +
          `<circle cx="184" cy="128" r="33" fill="${rgb(40, 66, 200)}"/>` + // twin of the LEFT band, on the right
          `<circle cx="72" cy="128" r="26" fill="${rgb(30, 170, 70)}"/>`, // a genuinely distinct mark
        `<linearGradient id="ramp" x1="0" y1="0" x2="${V}" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${rgb(40, 66, 200)}"/><stop offset="1" stop-color="${rgb(206, 70, 44)}"/></linearGradient>`,
      ),
  },
  {
    name: 'cross-bars',
    note: 'crossing colour bars → near-coincident junction cluster (weld)',
    make: () =>
      svg(
        `<rect width="${V}" height="${V}" fill="${WHITE}"/>` +
          `<line x1="20" y1="20" x2="236" y2="236" stroke="${RED}" stroke-width="44"/>` +
          `<line x1="236" y1="20" x2="20" y2="236" stroke="${BLUE}" stroke-width="44"/>`,
      ),
  },
  {
    name: 'concentric',
    note: 'concentric rings → circle snap + concentric-centre / equal-radius solver',
    make: () => {
      const cols = [NAVY, GOLD, NAVY, GOLD, NAVY, GOLD]
      const circles = cols.map((c, i) => `<circle cx="128" cy="128" r="${124 - i * 21}" fill="${c}"/>`).join('')
      return svg(`<rect width="${V}" height="${V}" fill="${WHITE}"/>${circles}`)
    },
  },
  {
    name: 'hairlines',
    note: 'strokes stepping 3px → 0.25px → sub-pixel thin-feature preservation',
    make: () => {
      const ws = [3, 2, 1.5, 1, 0.75, 0.5, 0.25]
      const bars = ws
        .map((w, i) => { const cx = V * (0.12 + i * 0.11); return `<rect x="${(cx - w / 2).toFixed(2)}" y="25.6" width="${w}" height="204.8" fill="${INK}"/>` })
        .join('')
      return svg(`<rect width="${V}" height="${V}" fill="${WHITE}"/>${bars}<line x1="76.8" y1="0" x2="179.2" y2="256" stroke="${rgb(180, 40, 60)}" stroke-width="1"/>`)
    },
  },
  {
    name: 'aa-seam',
    note: 'soft diagonal between two flats → nearest-colour crispness (the sliver)',
    make: () =>
      svg(
        `<polygon points="0,0 256,0 256,204.8 0,64" fill="${rgb(232, 128, 34)}"/>` +
          `<polygon points="0,64 256,204.8 256,256 0,256" fill="${rgb(22, 150, 150)}"/>` +
          `<circle cx="128" cy="128" r="23" fill="${rgb(150, 60, 160)}"/>`,
      ),
  },
  {
    name: 'checker',
    note: 'fine checkerboard (a 2× finer quadrant) → high-frequency aliasing',
    make: () =>
      svg(
        `<rect width="${V}" height="${V}" fill="url(#c9)"/><rect x="128" y="128" width="128" height="128" fill="url(#c4)"/>`,
        `<pattern id="c9" width="18" height="18" patternUnits="userSpaceOnUse"><rect width="18" height="18" fill="${rgb(220, 214, 198)}"/><rect width="9" height="9" fill="${INK}"/><rect x="9" y="9" width="9" height="9" fill="${INK}"/></pattern>` +
          `<pattern id="c4" width="8" height="8" patternUnits="userSpaceOnUse"><rect width="8" height="8" fill="${rgb(220, 214, 198)}"/><rect width="4" height="4" fill="${INK}"/><rect x="4" y="4" width="4" height="4" fill="${INK}"/></pattern>`,
      ),
  },
  {
    name: 'radial-glow',
    note: 'radial vignette → 2-D gradient / glow paint model',
    make: () =>
      svg(
        `<rect width="${V}" height="${V}" fill="url(#glow)"/>`,
        `<radialGradient id="glow" cx="0.42" cy="0.42" r="0.75"><stop offset="0" stop-color="${rgb(255, 238, 196)}"/><stop offset="0.5" stop-color="${rgb(198, 184, 162)}"/><stop offset="1" stop-color="${rgb(28, 20, 60)}"/></radialGradient>`,
      ),
  },
  {
    name: 'gradient-flat',
    note: 'linear gradient bg + crisp flat shapes → render gate (must not absorb)',
    make: () =>
      svg(
        `<rect width="${V}" height="${V}" fill="url(#gf)"/>` +
          `<circle cx="87" cy="128" r="38" fill="${WHITE}"/>` +
          `<polygon points="100,87 248,87 174,169" fill="${INK}"/>`,
        `<linearGradient id="gf" x1="0" y1="0" x2="${V}" y2="${V}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${rgb(120, 40, 150)}"/><stop offset="1" stop-color="${rgb(235, 150, 40)}"/></linearGradient>`,
      ),
  },
  {
    name: 'sharp-star',
    note: 'sharp-pointed star → corner detection (points must stay sharp)',
    make: () => svg(`<rect width="${V}" height="${V}" fill="${WHITE}"/><polygon points="${star(128, 128, 115, 36)}" fill="${NAVY}"/>`),
  },
  {
    name: 'annulus',
    note: 'rings with a transparent hole → nonzero winding + alpha',
    make: () =>
      svg(
        `<circle cx="128" cy="128" r="83" fill="none" stroke="${RED}" stroke-width="54"/>` +
          `<circle cx="128" cy="128" r="27" fill="none" stroke="${rgb(22, 150, 150)}" stroke-width="23"/>`,
      ),
  },
  {
    name: 'overlap',
    note: 'two translucent discs → layer decomposition (the lens)',
    make: () =>
      svg(
        `<rect width="${V}" height="${V}" fill="${WHITE}"/>` +
          `<circle cx="107" cy="128" r="61" fill="${RED}" fill-opacity="0.55"/>` +
          `<circle cx="148" cy="128" r="61" fill="${BLUE}" fill-opacity="0.55"/>`,
      ),
  },
]

// --- emit -------------------------------------------------------------------
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const dir = join(root, 'public', 'examples', 'edge-cases')
mkdirSync(dir, { recursive: true })
for (const c of CASES) {
  writeFileSync(join(dir, `${c.name}.svg`), c.make())
  console.log(`  ${c.name}.svg  — ${c.note}`)
}
console.log(`\n${CASES.length} edge-case SVGs written to public/examples/edge-cases/`)
