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
  {
    // The §0 #6b driver — BAR-END CAPS, authored deliberately red (the gear-teeth §10.5
    // pattern: author the missing red number, then fix). The regime was located by a
    // real-pipeline sweep (angle × width × length × sub-pixel phase): at HEAD the loss
    // lives EXACTLY at the narrowest gradeable cap width — 7px @512, the CORNER_MIN_EDGE
    // floor itself — at NON-CRISP AA phases. There the 50%-isophote cap rasterizes
    // ~1px narrower than authored, the cap's staircase run degenerates, and one (or
    // both) cap corners bevel away: recall 0–3 of 4 per bar, while the SAME bar at a
    // crisp integer phase, or 1px wider, traces all 4 corners sub-px. Width 8px+ is
    // phase-robust green (8/8 phases at 0° and 35°) — so the rack pins w7 at MEASURED
    // failing (angle, phase) cells and keeps w10-crisp + w8-worst-phase bars as in-case
    // controls that must stay green through any fix. Phases are authored as center =
    // integer + phase/2 (both axes), the sweep's exact construction. The two narrow
    // bars on the right (6px / 4px @512) sit BELOW the grading floor on purpose: they
    // reproduce the user-visible pointed/nubbed-end regime (hairlines @512) without
    // adding gradeable corners — including the §10.2 anatomy (a ≤4px cap + both 90°
    // shoulders as ONE contiguous sub-threshold cluster → one apex).
    name: 'bar-caps',
    note: 'butt-capped 7px bars at AA-losing phases + w8/w10 controls → cap corner recall (§0 #6b)',
    make: () => {
      const bar = (x1: number, y1: number, x2: number, y2: number, w: number): string =>
        `<polygon points="${thickLine(x1, y1, x2, y2, w)}" fill="${INK}"/>`
      const rot = (cx: number, cy: number, deg: number, halfLen: number, w: number): string => {
        const a = (deg * Math.PI) / 180
        const dx = Math.cos(a) * halfLen
        const dy = Math.sin(a) * halfLen
        return bar(cx - dx, cy - dy, cx + dx, cy + dy, w)
      }
      // Rotated bars author w=3.51 (7.02px @512): at exactly 3.5 the GT polygon's
      // short side computes 6.99…px from float normalization and CORNER_MIN_EDGE 7
      // silently drops the whole cap from grading — the red bars would grade n/a.
      return svg(
        `<rect width="${V}" height="${V}" fill="${WHITE}"/>` +
          // w7 @512 red rack — measured per-bar recall at HEAD in the comment
          rot(22.125, 60.125, 90, 15, 3.5) + // vertical, phase .25
          rot(150.125, 22.125, 0, 15, 3.5) + // horizontal, phase .25
          rot(75.065, 150.065, 15, 15, 3.51) + // 15°, phase .13 (verified: cap MELTS, 2 lost)
          rot(75.25, 105.25, 15, 15, 3.51) + // 15°, phase .5 (sweep's worst cell, 0/4)
          rot(75.44, 195.44, 15, 15, 3.51) + // 15°, phase .88
          rot(130.25, 105.25, 45, 15, 3.51) + // 45°, phase .5
          rot(185.315, 105.315, 65, 15, 3.51) + // 65°, phase .63
          rot(185, 185, 65, 15, 3.51) + // 65°, integer phase (not only AA phases lose)
          // in-case controls — green at HEAD, must STAY green through any fix
          rot(58, 60, 90, 25, 5) + // w10, crisp phase
          rot(130.25, 150.25, 35, 15, 4.01) + // w8 at the worst w7 phase
          // BELOW the grading floor — visual repro of the pointed-end regime only
          bar(222, 35, 222, 85, 3) + // 6px @512
          bar(236, 35, 236, 85, 2), // 4px
      )
    },
  },
  {
    // The CONTRAST-RANK driver (user-reported 2026-07-30 on the Affinity Designer mark in
    // /labs/gallery): a LOW-contrast boundary that terminates on a HIGH-contrast edge splits
    // it and pins it at a junction whose position was decided by the weak evidence — so the
    // strong edge tilts (a straight bar bends) or kinks (an arc grows bumps).
    //
    // Authored FLAT on purpose. The mark that exposed it is ramp art traced flat, where the
    // weak boundaries are POSTERIZATION bands — but a posterized ramp cannot be scored
    // against its own answer sheet (the bands are not in the authored SVG; that is why
    // bg-ramp-twin is registered gradients:true and why §13's bulge had no gate). The
    // mechanism does not need a ramp: it needs a weak boundary meeting a strong one. Four
    // FLAT near-colours reproduce exactly that and stay scorable — the bands ARE authored,
    // so every gate applies.
    //
    // The blues are the Affinity mark's own posterized band colours, so the ΔE ladder is the
    // measured regime, not an invented one: ~7.5–8.2 between neighbours against 47–58 for
    // the navy edges — the same clean bimodal split the diagnosis found (bandPullDiag.ts).
    //
    // The mark's tightest pair (#49c9fa/#43c5fa, ΔE 2.7) is deliberately NOT used: authored
    // flat, quantize merges it (MERGE_DISTANCE 10, and §9.7's evidence veto only protects
    // pairs ≥ ΔE 4), so the band would not exist in the trace at all and the case would go
    // red for a known, unrelated reason — measured at authoring, 4 fills instead of 5, p95
    // 25.7px of simply-missing boundary. A ramp supplies the extra evidence that lets 2.7
    // survive in the real mark; flat authored art does not.
    //
    // Rack, each subject crossed by shallow (~7.6°) band boundaries:
    //   bar    — 20px straight bar crossed 3× per flank; the segment pinned BETWEEN two weak
    //            junctions is the image-#3 anatomy (a straight edge fitted to two bad ends).
    //   disc   — rim split by one boundary into two arcs (the §1d co-circular interaction).
    //   plate  — one rounded corner crossed near its start: the arc is isolated between two
    //            weak junctions and joins its straight sides with a tangent break — image #2.
    //   square — the CONTROL: high contrast, no crossing, must stay green through any fix.
    name: 'band-cross',
    note: 'weak colour boundaries terminating on strong edges → contrast-ranked junctions',
    make: () => {
      // The four bands, painted back-to-front; each polygon covers everything below its
      // boundary line, so the visible seams are exactly the three authored diagonals.
      const below = (y0: number, y1: number, fill: string): string =>
        `<polygon points="0,${y0} ${V},${y1} ${V},${V} 0,${V}" fill="${fill}"/>`
      const B1 = rgb(90, 213, 251) // #5ad5fb
      const B2 = rgb(73, 201, 250) // #49c9fa   ΔE(B1,B2) = 7.5
      const B3 = rgb(56, 189, 250) // #38bdfa   ΔE(B2,B3) = 8.2
      const B4 = rgb(40, 176, 247) // #28b0f7   ΔE(B3,B4) = 7.6
      const DEEP = rgb(19, 72, 129) // #134881 — ΔE 47–58 against every band
      // Plate: three sharp corners + ONE quarter arc (r28) at the bottom-left, which
      // boundary C crosses ~4px below its start. Sharp corners: bar 4 + square 4 + plate 3
      // = 11, over the corner gate's CORNER_MIN_COUNT of 10, so that gate stays applicable.
      const plate =
        `<path d="M140,165 H240 V245 H168 A28,28 0 0,1 140,217 Z" fill="${DEEP}"/>`
      return svg(
        `<rect width="${V}" height="${V}" fill="${B1}"/>` +
          below(62, 96, B2) + // boundary A
          below(132, 166, B3) + // boundary B
          below(196, 230, B4) + // boundary C
          `<polygon points="${thickLine(40, 8, 96, 248, 20)}" fill="${DEEP}"/>` +
          `<circle cx="170" cy="80" r="40" fill="${DEEP}"/>` +
          plate +
          `<rect x="205" y="8" width="40" height="40" fill="${DEEP}"/>`,
      )
    },
  },
  {
    // The §0 #15 driver (the residue §14 named and left open): a junction that IS a real
    // CORNER of the art. §14 places a junction on a fit taken THROUGH it, which is only
    // defined where the strong boundary CONTINUES — at a corner the chord-turn gate
    // correctly refuses (a through fit would round the corner off), and the junction then
    // keeps its INTEGER lattice corner. An edge with one threaded end and one corner-pinned
    // end therefore trades a constant offset for a TILT: on the Affinity mark the 133px top
    // edge went from a uniform offset to 0.66px of swing (measured, §17).
    //
    // The anatomy at its smallest is a sideways WEDGE whose apex sits ON a shallow band
    // seam. The seam's direction lies INSIDE the wedge, so past the apex it runs into the
    // navy and is hidden: it TERMINATES on the corner. Three regions meet at one authored
    // corner (navy, band above, band below) with ΔE ≈ 42–52 / 42–52 / 7.7 — exactly §14's
    // rank, and exactly the branch it refuses. The same seam re-emerges through the wedge's
    // BASE, where §14 does thread it, so each flank is a long strong edge with a
    // corner-pinned end and a threaded end: the tilt anatomy, per unit.
    // (An UP-pointing triangle does not work and the reason is worth recording: a shallow
    // seam through its apex does not enter the downward wedge, so it passes THROUGH — the
    // vertex is degree 4, and on the lattice it splits into two degree-3 junctions ~2px
    // apart whose arms are 2px long. Measured while authoring: `arm 2px < 6`, no verdict.)
    //
    // Cells — the apex half-angle sets how much of the tip the raster erodes, and the two
    // columns put the apex at both ends of a chain (start vs end):
    //   right-pointing 32° / 17° / 45°   left-pointing 45° / 32° / 17°
    //   CONTROL row — the same 32° wedges whose apex is NOT on a seam (the seam crosses a
    //   flank instead): that corner is an interior vertex of one chain, which the §10.6
    //   snap already resolves. Same shape, same seam crossings, only the apex differs — so
    //   a fix that helps the six and moves the two controls is fixing the wrong thing.
    //
    // UNGATED (the `scale-blind` / `wedge-counter` arrangement: genEdgeCases + the A/B lane,
    // not TRUTH_CORPUS). A lattice pin is at most 0.71px by construction, and a whole-case
    // p95 dilutes that far inside tier 0's 2.5 — no case-level tolerance can be RED on this
    // mechanism. The red gate is test/planar-thread.test.ts, which measures the junction
    // against the authored corner it is supposed to be.
    name: 'seam-corner',
    note: 'a band seam terminating ON a corner of the art → the junction IS the corner (§0 #15)',
    make: () => {
      const below = (y0: number, y1: number, fill: string): string =>
        `<polygon points="0,${y0} ${V},${y1} ${V},${V} 0,${V}" fill="${fill}"/>`
      // The Affinity mark's own posterized band ladder (ΔE ≈ 7.5–8.2 between neighbours,
      // 42–52 against the navy) — the measured regime band-cross already uses, extended by
      // one step so four seams fit.
      const B1 = rgb(90, 213, 251)
      const B2 = rgb(73, 201, 250)
      const B3 = rgb(56, 189, 250)
      const B4 = rgb(40, 176, 247)
      const B5 = rgb(24, 163, 243)
      const DEEP = rgb(19, 72, 129)
      /** Sideways isoceles wedge: apex (x,y), body extending `dir` (−1 left / +1 right),
       *  half-angle `half`°, arm length `arm`. */
      const wedge = (x: number, y: number, dir: -1 | 1, half: number, arm: number): string => {
        const t = (half * Math.PI) / 180
        const dx = dir * arm * Math.cos(t)
        const dy = arm * Math.sin(t)
        const p = (px: number, py: number): string => `${px.toFixed(2)},${py.toFixed(2)}`
        return `<polygon points="${p(x, y)} ${p(x + dx, y - dy)} ${p(x + dx, y + dy)}" fill="${DEEP}"/>`
      }
      // All four seams share one shallow slope (0.0472, ~2.7°) — the same weak-boundary
      // regime band-cross uses. S1..S3 carry an apex in each column; S4 carries none.
      const SL = 0.0472
      const seamY = (y0: number, x: number): number => y0 + SL * x
      return svg(
        `<rect width="${V}" height="${V}" fill="${B1}"/>` +
          below(44, 44 + SL * V, B2) + // S1
          below(100, 100 + SL * V, B3) + // S2
          below(156, 156 + SL * V, B4) + // S3
          below(212, 212 + SL * V, B5) + // S4 — crosses the CONTROL wedges' flanks
          wedge(206, seamY(44, 206), -1, 32, 52) +
          wedge(206, seamY(100, 206), -1, 17, 52) +
          wedge(206.5, seamY(156, 206.5), -1, 45, 44) +
          wedge(50, seamY(44, 50), 1, 45, 44) +
          wedge(50, seamY(100, 50), 1, 32, 52) +
          wedge(50.5, seamY(156, 50.5), 1, 17, 52) +
          wedge(206, 228, -1, 32, 52) + // CONTROL — apex off every seam
          wedge(50, 228, 1, 32, 52), // CONTROL
      )
    },
  },
  {
    // The §15.8 driver (user-reported 2026-08-05, /labs/ab on the Instagram wordmark): the
    // top of a script 'a', where the bowl's crown and the stem converge into a thin white
    // COUNTER WEDGE. The wedge is sub-pixel for its last few px, so the lattice fuses its
    // tip into a 2px step — a sharp corner whose one arm is the crown, already turning
    // inside the [SNAP_GAP..SNAP_SPAN] window the §15 tangent pin measures its "arm line"
    // over. The line is then a CHORD, not the boundary's tangent, and pinning a long handle
    // onto it swings the crown px off its own samples (measured on the witness: 29.3° on a
    // 26px handle = 13.1px of control-point movement, ~2px of sag, the counter's white gap
    // closed). Thin converging counters are ordinary letterform anatomy — a, e, g of any
    // wordmark — which is why this is authored as a rack rather than left to the gallery.
    //
    // Each unit is a bowl RING (ink annulus + gold counter, so the counter is its own
    // scored region) whose rim a stem bar grazes as a NEAR-TANGENT chord: `depth` sets how
    // far the chord cuts in, which is what makes the wedge converge slowly enough to pinch
    // out sub-pixel. The three (R, depth, φ) cells are the ones a pipeline sweep measured
    // losing at HEAD (handle-tip movement 5.5 / 5.2 / 3.5px, boundary p95 2.1× worse than
    // with the pass off); the fourth is the in-case CONTROL — the same shape with the stem
    // meeting the rim STEEPLY, where the wedge never goes sub-pixel and the pin is right.
    //
    // NOTE, honestly, and this is why the case is UNGATED (the `scale-blind` arrangement:
    // in genEdgeCases + the A/B lane, not in TRUTH_CORPUS): (a) it is not RED at HEAD on its
    // own aggregate numbers — the worst sag is ~2px over a short arc, which a whole-case p95
    // dilutes to 1.19, inside tier 0's 2.5. The red gate for the mechanism is
    // test/planar-pin.test.ts, which measures the fit against its own evidence. And (b)
    // gating it would ALSO pin an unrelated open defect at a knife edge: @256 the §15
    // displacement pass costs this art 2 of its 20 authored corners (16/20 = exactly the
    // corner gate's 80% floor, both before and after §15.8 — the coarse-end residue named in
    // §15.7). What this rack is for is the pipeline-level and visual witness: measured @512,
    // boundary p95 1.19 → 0.45 and chamfer 0.24 → 0.16 across the fix.
    name: 'wedge-counter',
    note: 'converging counter wedge over a curved crown → tangent-pin arm-line extrapolation (§15.8)',
    make: () => {
      // One 'a'-like unit. `phi` is where the stem's chord meets the rim (deg from the top),
      // `depth` how deep it cuts, `crown` the ink left between counter and rim.
      const unit = (cx: number, cy: number, R: number, depth: number, phi: number): string => {
        const crown = Math.max(1.2, R * 0.16)
        const dy = -Math.max(1, R * 0.15)
        const r = R + dy - crown
        const stemW = Math.max(4, R * 0.45)
        const a = (phi * Math.PI) / 180
        const nx = Math.sin(a)
        const ny = -Math.cos(a)
        // The chord: offset R−depth from the centre along n, running along its perpendicular.
        const ox = cx + nx * (R - depth)
        const oy = cy + ny * (R - depth)
        const dx = -ny
        const dyv = nx
        const L = R * 2.2
        const p = (x: number, y: number): string => `${x.toFixed(2)},${y.toFixed(2)}`
        const stem = [
          p(ox - dx * L * 0.15, oy - dyv * L * 0.15),
          p(ox + dx * L, oy + dyv * L),
          p(ox + dx * L + nx * stemW, oy + dyv * L + ny * stemW),
          p(ox - dx * L * 0.15 + nx * stemW, oy - dyv * L * 0.15 + ny * stemW),
        ].join(' ')
        return (
          `<path d="${circleD(cx, cy, R)} ${circleD(cx, cy + dy, r)}" fill="${INK}" fill-rule="evenodd"/>` +
          `<circle cx="${cx}" cy="${(cy + dy).toFixed(2)}" r="${r.toFixed(2)}" fill="${GOLD}"/>` +
          `<polygon points="${stem}" fill="${INK}"/>`
        )
      }
      return svg(
        `<rect width="${V}" height="${V}" fill="${WHITE}"/>` +
          unit(62, 62, 28, 0.8, 65) + // measured: 5.54px of handle-tip movement, p95 0.71 → 1.49
          unit(190.5, 58.5, 22, 0.6, 65) + // 5.22px, p95 0.59 → 1.34 (half-pixel phase)
          unit(62.5, 190.5, 22, 0.6, 75) + // 3.50px, p95 0.38 → 1.45
          unit(190, 190, 26, 2.6, 30), // CONTROL: a steep meeting, no sub-pixel wedge
      )
    },
  },
  {
    // The §10 "driver" case — small SHARP features on the same canvas as a large smooth
    // shape, so one absolute fit tolerance cannot serve both. A 14-tooth gear whose tooth
    // chords are all ≥ 7.5px @512 — above the answer sheet's CORNER_MIN_EDGE grading
    // floor, cleanly raster-resolved — yet whose corners sit 7.5–12.5px apart, inside
    // the wash zone of the fit's FIXED ±4px corner window + 5px apex-merge distance: the
    // detector melts most of them while every boundary px stays sub-tolerance (measured
    // at authoring: chamfer 0.22 / p95 0.78 GREEN, corner recall 21/60 = 35% RED — the
    // distance-blind corner gate is the only one that can see this failure). The corner-
    // turn VETO cannot help (it guards the beautify SNAPS; this loss happens in the FIT),
    // and localScaleK does not move it (snaps again) — this case gates the "still open"
    // bigger half of §10: scale-aware fit ε / detector windows. Where `scale-blind`
    // (ungated, veto-off A/B) argues the snap side, this one GATES the fit side. The big
    // navy disc is the control: same trace settings, generous scale, must stay clean.
    name: 'gear-teeth',
    note: 'small sharp gear teeth + large smooth disc → scale-blind fit ε / corner window (§10.5)',
    make: () => {
      // Trapezoid-tooth gear as one polygon: per tooth root→flank→tip→flank, then the
      // root arc chord to the next tooth. All corners sharp by construction.
      const gear = (cx: number, cy: number, rRoot: number, rTip: number, n: number): string => {
        const pts: string[] = []
        const step = (2 * Math.PI) / n
        for (let i = 0; i < n; i++) {
          const a = -Math.PI / 2 + i * step
          const at = (f: number, r: number): string =>
            `${(cx + r * Math.cos(a + f * step)).toFixed(2)},${(cy + r * Math.sin(a + f * step)).toFixed(2)}`
          pts.push(at(0, rRoot), at(0.15, rTip), at(0.45, rTip), at(0.6, rRoot))
        }
        return pts.join(' ')
      }
      return svg(
        `<rect width="${V}" height="${V}" fill="${WHITE}"/>` +
          `<circle cx="168" cy="92" r="62" fill="${NAVY}"/>` +
          `<polygon points="${gear(78, 172, 22, 28, 14)}" fill="${INK}"/>`,
      )
    },
  },
  {
    // Issue #17's anatomy, which no existing fixture carries. `wedge-counter` was measured
    // for it first and does NOT reproduce (max overshoot 0.21px): its wedges pinch out
    // SUB-PIXEL and the lattice fuses them, which is §15.8's mechanism, not this one.
    //
    // Here the counter is fully resolved and still acute: a LENS of two circular arcs, so
    // both arms are CURVED and converge slowly. `snapCornerToArms` fits a straight line to
    // each arm over [SNAP_GAP..SNAP_SPAN] = [3..14]px and intersects them — on a curved arm
    // that line is a CHORD, it leans INTO the lens, and the two chords cross px past the
    // real tip. The shallower the tip, the harder the error multiplies (a slope error
    // divides by tan of the half-angle), which is why the rack sweeps the tip ANGLE as its
    // primary axis rather than size.
    //
    // Each unit is a GOLD lens counter inside an INK disc on white, so the counter is its
    // own scored region with a strong boundary on both flanks. Rotations are per-cell so
    // the tips land at different raster phases and no result is an axis-alignment artifact.
    //
    // The two CONTROLS matter as much as the cells, because the fix must not become "stop
    // reconstructing": the bottom row carries thin INK SPIKES whose tips the raster genuinely
    // ERODES — sharp-star's regime, where reconstructing px past the last labelled pixel is
    // the RIGHT answer (§10.2, corner recall 11/11). A veto that also silences these is
    // fixing the wrong thing.
    name: 'acute-counter',
    note: 'acute LENS counters (two slowly-converging CURVED arms) → apex reconstructed past the ink (#17)',
    make: () => {
      /**
       * A lens of two circular arcs of radius `R` meeting at a full tip angle of `tip`°.
       * Both tips lie on the local y axis, h apart; each arc bulges by sagitta s.
       * From (R−s)² + (h/2)² = R²:  h = 2R·sin(tip/2),  s = R·(1−cos(tip/2)).
       */
      const lens = (cx: number, cy: number, R: number, tip: number, rot: number, fill: string): string => {
        const half = (tip * Math.PI) / 360
        const h = 2 * R * Math.sin(half)
        const r = R.toFixed(3)
        const d =
          `M 0,${(-h / 2).toFixed(3)} A ${r},${r} 0 0 1 0,${(h / 2).toFixed(3)}` +
          ` A ${r},${r} 0 0 1 0,${(-h / 2).toFixed(3)} Z`
        return `<path d="${d}" fill="${fill}" transform="translate(${cx},${cy}) rotate(${rot})"/>`
      }
      /** One rack cell: the ink disc that carries the counter, plus the counter. */
      const unit = (cx: number, cy: number, R: number, tip: number, rot: number): string => {
        const h = 2 * R * Math.sin((tip * Math.PI) / 360)
        return (
          `<circle cx="${cx}" cy="${cy}" r="${(h / 2 + 7).toFixed(2)}" fill="${INK}"/>` +
          lens(cx, cy, R, tip, rot, GOLD)
        )
      }
      /** Isoceles spike, apex (x,y), pointing `rot`° — the ERODED-tip control. */
      const spike = (x: number, y: number, halfDeg: number, arm: number, rot: number): string => {
        const t = (halfDeg * Math.PI) / 180
        const p = (px: number, py: number): string => `${px.toFixed(2)},${py.toFixed(2)}`
        const pts = `${p(0, 0)} ${p(arm * Math.cos(t), -arm * Math.sin(t))} ${p(arm * Math.cos(t), arm * Math.sin(t))}`
        return `<polygon points="${pts}" fill="${INK}" transform="translate(${x},${y}) rotate(${rot})"/>`
      }
      // EVERY CELL MUST RESOLVE AT 256px, or it measures the wrong thing. A lens is
      // 2·R·(1−cos(tip/2)) wide at its middle, and the first draft's 24° cells came to
      // 1.5px @256 — they were dropped WHOLE (authored tip 120–143px from any fitted
      // node, a thin-feature loss, §12's territory) and would have scored this mechanism
      // with another one's failure. The cells below are all ≥ 3.7px wide @256, so the
      // counter survives at every resolution and the only thing under test is where its
      // tip lands.
      return svg(
        `<rect width="${V}" height="${V}" fill="${WHITE}"/>` +
          // Row 1 — the tip-angle sweep at ~26 units of length, phases 0/23/47°.
          unit(46, 46, 48, 32, 0) +
          unit(128, 46, 40, 38, 23) +
          unit(210, 46, 34, 44, 47) +
          // Row 2 — the same angles SHORTER, so the [3..14]px arm window covers a larger
          // share of each arc and its chord leans further in (half-pixel phase offsets).
          unit(46.5, 128.5, 30, 38, 11) +
          unit(128.5, 128.5, 24, 44, 67) +
          unit(210.5, 128.5, 20, 56, 90) +
          // Row 3, CONTROLS — eroded ink spikes that MUST still reconstruct past the lattice.
          spike(24, 200, 5, 62, -8) +
          spike(24, 232, 8, 62, 4) +
          // …and the in-case blunt counter, where the chord lean is negligible.
          unit(210, 210, 30, 96, 31),
      )
    },
  },
  {
    // Issue #7's anatomy (the mastercard "needle"): a corner whose arms are CURVED but
    // whose tip is NOT acute — letterform joins. `snapCornerToArms` fits a straight line
    // per arm and intersects; on a curved arm that line is a chord, it leans into the
    // curve, and the intersection slides ALONG the other arm — measured on the mark as a
    // white needle piercing the 'e' stems (apex 2.1–2.9px out along the crossbar) and a
    // crotch apex pushed the WRONG way (away from the notch). §18 is structurally blind
    // here: the move is under its 2.5px floor, or the ray runs ALONG a real edge whose AA
    // fringe reads as coverage (reach ≈ moved). Verified to reproduce before authoring:
    // the same cells traced as a scratch rack show moved 2.81px along-chord at bow 0.92.
    //
    // Two rows, one mechanism each, both arms resolvable at 256 (this rack measures the
    // FIT's apex placement, not §12's thin-feature loss or §15.8's sub-pixel pinch):
    //   • D-COUNTERS (arc × line, the 'e' eye): a circular-segment counter in an ink
    //     block. The flat chord is one arm, the arc the other; the authored corner is the
    //     chord end. The defect is axial overshoot along the chord.
    //   • DISC-UNION CROTCHES (arc × arc, the 'm' crotch): one authored path whose two
    //     circle arcs meet at explicit crossing vertices, so corner recovery can score
    //     them. Both walls are curved; the chords' intersection lands off the bisector.
    // Controls: an eroded straight-arm spike (must KEEP reconstructing far past the
    // lattice — sharp-star's regime) and a right-angle square notch (straight arms, the
    // line model is exact, the fix must not move it).
    name: 'letter-joins',
    note: 'letterform joins — CURVED-arm corners displace the chord-intersection apex (#7)',
    make: () => {
      /** Circular-segment counter: chord `c` wide, bulge `h`, chord along local y=0.
       *  R = (c²/4 + h²) / 2h; corner interior angle at each chord end = asin((c/2)/R). */
      const dseg = (cx: number, cy: number, c: number, h: number, rot: number): string => {
        const R = (c * c) / 4 / (2 * h) + h / 2
        const d = `M ${(-c / 2).toFixed(3)},0 A ${R.toFixed(3)},${R.toFixed(3)} 0 0 1 ${(c / 2).toFixed(3)},0 Z`
        return `<path d="${d}" fill="${GOLD}" transform="translate(${cx},${cy}) rotate(${rot})"/>`
      }
      /** Union of two discs radius `r`, centres (±dc, 0), authored as ONE path whose two
       *  crossing points are explicit vertices (corner recovery needs authored vertices —
       *  a union computed by the renderer would leave the crossings implicit). */
      const lensPair = (cx: number, cy: number, r: number, dc: number, rot: number): string => {
        const yc = Math.sqrt(r * r - dc * dc)
        const d =
          `M 0,${(-yc).toFixed(3)}` +
          ` A ${r},${r} 0 1 0 0,${yc.toFixed(3)}` +
          ` A ${r},${r} 0 1 0 0,${(-yc).toFixed(3)} Z`
        return `<path d="${d}" fill="${INK}" transform="translate(${cx},${cy}) rotate(${rot})"/>`
      }
      return svg(
        `<rect width="${V}" height="${V}" fill="${WHITE}"/>` +
          // Row 1 — D-counters at the witness's own scale (mastercard's 'e' eye is
          // 26×9 units @512-for-2) with per-cell rotation phases.
          `<rect x="14" y="18" width="72" height="46" fill="${INK}"/>` + dseg(50, 52, 26, 9, 0) +
          `<rect x="100" y="18" width="72" height="46" fill="${INK}"/>` + dseg(136, 52, 34, 12, 9) +
          `<rect x="186" y="18" width="60" height="46" fill="${INK}"/>` + dseg(216, 52, 20, 8, 31) +
          // Row 2 — disc-union crotches, ink interior angles ~94°/77°/89°.
          lensPair(52, 130, 30, 22, 0) +
          lensPair(140, 130, 24, 15, 17) +
          lensPair(216, 130, 20, 14, 43) +
          // Row 3 — controls.
          `<polygon points="24,236 86,214 86,222" fill="${INK}"/>` +
          `<path d="M 120,200 h 60 v 40 h -60 Z M 145,200 v 14 h 12 v -14 Z" fill="${INK}" fill-rule="evenodd"/>`,
      )
    },
  },
  {
    // Issue #8's anatomy (the ibm mark's dropped ▼): a SMALL SOLID FEATURE, isolated from
    // its neighbours by the art's own white gaps, whose connected component lands under
    // the palette path's `minRegionArea` floor — so despeckleComponents dissolves it into
    // the background and the trace loses a whole region. Measured on the reporting mark:
    // the ▼ is 24 exactly-ink px in a 32px component, eroded to 26 by the mode filter,
    // against a floor of 50 at the default Despeckle dial. It survives every palette
    // COLOUR stage (its ink entry is 11.7% of the image — nowhere near any share floor);
    // only the per-component area floor kills it.
    //
    // The rack sweeps component area ACROSS the floor rather than sitting on one point,
    // because the floor moves with the user's Despeckle dial: five peaks per row at ~20,
    // 30, 40, 48 and 64 raster-px² when rasterized at 512 (the gate's resolution), i.e.
    // four below the default 50px floor and one above it as the in-case control that must
    // be recovered either way. Two rows at a half-raster-pixel phase offset, because
    // §10.7 measured cap/corner survival to be an AA-phase lottery at this scale; row 2 is
    // GOLD so the evidence is exercised on a second accepted palette entry rather than
    // only on the ink↔paper pair.
    //
    // CONTROL, in-case: a shallow (~1.8°) diagonal seam across the bottom third. That is
    // the shrapnel generator the floor exists for — a near-horizontal AA staircase whose
    // pixels snap alternately to either flat, littering the boundary with tiny components.
    // Any rule that revives the peaks must leave those dead, and this case gates BOTH
    // sides at once: the peaks show up as region recovery + boundary error, the seam's
    // shrapnel as node parsimony.
    name: 'peak-drop',
    note: 'small isolated features under the despeckle area floor — dropped whole (#8)',
    make: () => {
      /** Downward triangle of `areaR` raster-px² at 512 (a 256-unit canvas doubles), at
       *  the reporting mark's base/height ratio (7.15 : 9.1). Top edge at y, apex below. */
      const peak = (cx: number, y: number, areaR: number, fill: string): string => {
        const bR = Math.sqrt(2 * areaR * (7.15 / 9.1))
        const bU = bR / 2 / 2 // half-base, authored units
        const hU = bR / (7.15 / 9.1) / 2
        return `<polygon points="${(cx - bU).toFixed(3)},${y} ${(cx + bU).toFixed(3)},${y} ${cx.toFixed(3)},${(y + hU).toFixed(3)}" fill="${fill}"/>`
      }
      const AREAS = [20, 30, 40, 48, 64]
      /** One stripe cell: a bar, a clear gap, the peak, a clear gap, another bar — the ibm
       *  stripe anatomy that isolates the peak into its own connected component. The gaps
       *  are ≥ 7 raster px @512 (the reporting mark's are 8), so no AA bridges them. */
      const cell = (x: number, yTop: number, areaR: number, fill: string, phase: number): string =>
        `<rect x="${x}" y="${yTop}" width="28" height="3.5" fill="${fill}"/>` +
        peak(x + 14 + phase, yTop + 8 + phase, areaR, fill) +
        `<rect x="${x}" y="${yTop + 18}" width="28" height="3.5" fill="${fill}"/>`
      // Four rows at quarter-unit (half raster px @512) phase offsets: §10.7 measured
      // small-feature survival to be an AA-phase lottery at this scale, and one phase would
      // gate one draw of it. Alternating INK/GOLD exercises the evidence on two accepted
      // palette entries rather than only on the ink↔paper pair. The bars are deliberately
      // SHORT: a rack padded with long straight edges measures its padding — the boundary
      // percentiles have to be dominated by the features under test for them to gate.
      const ROWS: [number, string, number][] = [[12, INK, 0], [56, GOLD, 0.25], [100, INK, 0.5], [144, GOLD, 0.75]]
      return svg(
        `<rect width="${V}" height="${V}" fill="${WHITE}"/>` +
          ROWS.map(([y, fill, ph]) => AREAS.map((a, i) => cell(8 + i * 49, y, a, fill, ph)).join('')).join('') +
          // CONTROL — the shallow AA seam whose staircase the floor is there to sweep up.
          `<polygon points="0,204 ${V},196 ${V},${V} 0,${V}" fill="${INK}"/>`,
      )
    },
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
