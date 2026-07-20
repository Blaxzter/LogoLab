// Generates the HANDCRAFTED "difficult case" corpus for the tracer A/B view
// (/labs/ab — AbLab). Each case is authored as a SELF-CONTAINED SVG so the view can
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

// ---------------------------------------------------------------------------
// FILLS, NOT STROKES — why these helpers exist
//
// These cases used to be authored with `stroke` (`<line stroke-width="44">`, `<circle
// fill="none" stroke-width="54">`). That renders identically, but it makes the file useless
// as GROUND TRUTH: a stroked element's visible boundary is the OUTLINE OF THE STROKE (an
// offset curve with joins and caps), not the path in the `d`/`x1..y2` attributes. A
// ground-truth reader handed the centerline would either have to reimplement stroke
// outlining, or — worse — score the centerline and report a confident wrong number.
//
// A stroked line IS a rectangle and a stroked circle IS an annulus, so we just author them
// that way. The pixels are unchanged; the ground truth becomes exact instead of
// approximate, and svgGround.ts can read it with no offset-curve maths at all.
// ---------------------------------------------------------------------------

/** The rectangle a butt-capped stroke of width `w` along (x1,y1)→(x2,y2) actually paints. */
function thickLine(x1: number, y1: number, x2: number, y2: number, w: number): string {
  const dx = x2 - x1, dy = y2 - y1
  const len = Math.hypot(dx, dy) || 1
  const px = (-dy / len) * (w / 2), py = (dx / len) * (w / 2)
  const p = (x: number, y: number): string => `${x.toFixed(2)},${y.toFixed(2)}`
  return [p(x1 + px, y1 + py), p(x2 + px, y2 + py), p(x2 - px, y2 - py), p(x1 - px, y1 - py)].join(' ')
}

/** A circle as an explicit path (two 180° arcs), so it composes into a multi-subpath ring. */
function circleD(cx: number, cy: number, r: number): string {
  return `M${(cx - r).toFixed(2)},${cy} A${r},${r} 0 1,0 ${(cx + r).toFixed(2)},${cy} A${r},${r} 0 1,0 ${(cx - r).toFixed(2)},${cy} Z`
}

/** The annulus a stroked circle actually paints: outer ring + inner hole, even-odd filled.
 *  A real hole in the winding, which is exactly what the `annulus` case is meant to test. */
function ring(cx: number, cy: number, rCenter: number, w: number, fill: string): string {
  const d = `${circleD(cx, cy, rCenter + w / 2)} ${circleD(cx, cy, rCenter - w / 2)}`
  return `<path d="${d}" fill="${fill}" fill-rule="evenodd"/>`
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
          `<polygon points="${thickLine(20, 20, 236, 236, 44)}" fill="${RED}"/>` +
          `<polygon points="${thickLine(236, 20, 20, 236, 44)}" fill="${BLUE}"/>`,
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
      const diag = `<polygon points="${thickLine(76.8, 0, 179.2, 256, 1)}" fill="${rgb(180, 40, 60)}"/>`
      return svg(`<rect width="${V}" height="${V}" fill="${WHITE}"/>${bars}${diag}`)
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
    // AUTHORED AS FILLED RECTS, NOT A <pattern> — the pattern principle is the stroke
    // principle (see FILLS, NOT STROKES above): a pattern fill's visible boundary is the
    // TILING, not the host rect's outline, so the <pattern> version was unscorable ground
    // truth (docs/vectorization-benchmarks.md §8.2 — a tracer that correctly recovered the
    // checkerboard was charged with inventing 52px of boundary). Tile sizes are 16/8 (was
    // 18/9) so the coarse grid ALIGNS with the fine quadrant at x=y=128: no square straddles
    // the quadrant edge, nothing is occluded, and the authored outlines ARE the visible
    // edges — the two properties an answer sheet needs.
    make: () => {
      const BEIGE = rgb(220, 214, 198)
      const cell = (x: number, y: number, s: number): string =>
        `<rect x="${x}" y="${y}" width="${s}" height="${s}" fill="${INK}"/>`
      const parts: string[] = [`<rect width="${V}" height="${V}" fill="${BEIGE}"/>`]
      for (let ty = 0; ty < 16; ty++) {
        for (let tx = 0; tx < 16; tx++) {
          if (tx >= 8 && ty >= 8) continue // the fine quadrant replaces these tiles
          parts.push(cell(tx * 16, ty * 16, 8), cell(tx * 16 + 8, ty * 16 + 8, 8))
        }
      }
      for (let ty = 0; ty < 16; ty++) {
        for (let tx = 0; tx < 16; tx++) {
          parts.push(cell(128 + tx * 8, 128 + ty * 8, 4), cell(128 + tx * 8 + 4, 128 + ty * 8 + 4, 4))
        }
      }
      return svg(parts.join(''))
    },
  },
  {
    // The §10.1 companion to `checker`: where checker proves the CORNER-TURN veto, this makes
    // the SCALE argument visible. Four adjacent checkerboard bands, cell size shrinking left→
    // right (16 / 12 / 8 / 6px at the 512 default). Cells are ADJACENT — shared straight edges,
    // so they trace clean and square (an isolated <13px square instead traces to a concave
    // "pillow", a pre-existing tiny-loop artifact that would only confuse). With the §9.8 veto
    // OFF the tracer's only guard is gone and you SEE the threshold: the big cells stay sharp
    // (their deviation from a circle already exceeds 1.5px) while the small cells scallop into
    // blobs. Scale-relative ε (localScaleK, §10.1) alone re-sharpens exactly the small ones,
    // by SIZE, no turn test. See the AbLab "Veto off" vs "Veto off + scale-ε" variants.
    name: 'scale-blind',
    note: 'graduated checkerboard bands (16→6px cells) → scale-relative snap tolerance subsumes the corner-turn veto (§10.1)',
    make: () => {
      const BEIGE = rgb(220, 214, 198)
      const parts: string[] = [`<rect width="${V}" height="${V}" fill="${BEIGE}"/>`]
      // Each band is a checkerboard patch of one cell size `s`, viewBox units (×2 at 512px).
      const bands = [
        { x0: 10, x1: 66, s: 8 }, // 16px cells — above the snap threshold, stay sharp
        { x0: 74, x1: 130, s: 6 }, // 12px
        { x0: 138, x1: 194, s: 4 }, // 8px — the §9.8 scallop size
        { x0: 202, x1: 250, s: 3 }, // 6px cells — round hardest without the veto
      ]
      const y0 = 10
      const y1 = 246
      for (const b of bands) {
        const nx = Math.floor((b.x1 - b.x0) / b.s)
        const ny = Math.floor((y1 - y0) / b.s)
        for (let j = 0; j < ny; j++)
          for (let i = 0; i < nx; i++)
            if ((i + j) % 2 === 0)
              parts.push(`<rect x="${(b.x0 + i * b.s).toFixed(1)}" y="${(y0 + j * b.s).toFixed(1)}" width="${b.s}" height="${b.s}" fill="${INK}"/>`)
      }
      return svg(parts.join(''))
    },
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
    note: 'rings with a transparent hole → even-odd winding + alpha',
    make: () => svg(ring(128, 128, 83, 54, RED) + ring(128, 128, 27, 23, rgb(22, 150, 150))),
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
