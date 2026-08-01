// Curve-fit faceting sweep (one-off, dev/test). Traces Schild.png at 2048 across a
// grid of planar curve-fit overrides (epsilon / lineCost / cubicCost) to find a
// setting that turns chord-faceting into smooth cubics — WITHOUT breaking smooth
// shapes (nebula/petals circles are the guardians). For each candidate it writes
// the SVG + 2048 render + fold/corner crops and logs geometry + fidelity, into
// crispness-study/facet/. Run:  node src/devtest/facetSweep.ts

import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ensureImageData, loadPng } from './nodeHarness.ts'
import { downscale } from './traceGolden.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../lib/trace/index.ts'
import { serializeDoc } from '../lib/path/model.ts'
import { rasterizeDoc } from './raster.ts'
import { scoreDoc } from './scoreboard.ts'
import { encodePng } from './pngEncode.ts'
import { overWhite, cropZoom, geomMetrics } from './crispLib.ts'
import type { PlanarFitOptions } from '../lib/trace/planarFit.ts'

ensureImageData()

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const OUT = join(ROOT, 'crispness-study', 'facet')
const DIM = 2048
const CROPS = [
  { name: 'fold', x: 980, y: 470, w: 420, h: 420 },
  { name: 'corner', x: 30, y: 30, w: 420, h: 420 },
]

interface Cand { id: string; pf: Partial<PlanarFitOptions> }
const CANDS: Cand[] = [
  { id: 'a-baseline', pf: { lineCost: 3.9 } }, // original cost (default is now gated 4.5 for flat)
  { id: 'b-line4.5', pf: { lineCost: 4.5 } },
  { id: 'c-line6', pf: { lineCost: 6 } },
  { id: 'd-eps1.5', pf: { epsilon: 1.5 } },
  { id: 'e-eps2', pf: { epsilon: 2 } },
  { id: 'f-eps1.5-line5', pf: { epsilon: 1.5, lineCost: 5 } },
  { id: 'g-eps2-line6', pf: { epsilon: 2, lineCost: 6 } },
]

async function main() {
  if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true })
  mkdirSync(OUT, { recursive: true })

  const srcImg = loadPng('examples/test-files/Schild.png')
  const input = downscale(srcImg, DIM) // src is 2048 → identity
  const src2048 = overWhite(srcImg.data, srcImg.width * srcImg.height)
  writeFileSync(join(OUT, 'source.png'), encodePng(src2048, DIM, DIM))
  for (const c of CROPS) {
    const z = cropZoom(src2048, DIM, c, 3)
    writeFileSync(join(OUT, `source.crop-${c.name}.png`), encodePng(z.data, z.w, z.h))
  }
  const target = { width: DIM, height: DIM, data: src2048 }

  // Circle guardians: nebula/petals at their golden config (gradients ON, native).
  const guards = ['public/examples/nebula.png', 'public/examples/petals.png']
    .filter((p) => existsSync(join(ROOT, p)))
    .map((p) => ({ name: p.split('/').pop()!.replace('.png', ''), img: loadPng(p) }))

  console.log('SCHILD @2048 (gradients off, smoothing 50, precision 3):')
  const rows: string[] = ['| candidate | paths | cubics | lines | sharp>60 | meanΔE | SSIM | nodes | kB | guards (Δnodes / ΔmeanΔE) |', '|---|--:|--:|--:|--:|--:|--:|--:|--:|---|']
  const guardBase: Record<string, { nodes: number; de: number }> = {}

  for (const cand of CANDS) {
    const opts = { ...DEFAULT_VECTORIZE_OPTIONS, engine: 'planar' as const, gradients: false, smoothing: 50, planarFit: cand.pf }
    const doc = await traceImage(input as unknown as ImageData, opts)
    const svg = serializeDoc(doc, 3)
    const geom = geomMetrics(svg)
    const render = rasterizeDoc(doc, DIM, DIM)
    const score = scoreDoc(target, doc)
    writeFileSync(join(OUT, `${cand.id}.svg`), svg)
    writeFileSync(join(OUT, `${cand.id}.png`), encodePng(render, DIM, DIM))
    for (const c of CROPS) {
      const z = cropZoom(render, DIM, c, 3)
      writeFileSync(join(OUT, `${cand.id}.crop-${c.name}.png`), encodePng(z.data, z.w, z.h))
      // Vector zoom: rasterize the DOC for just this region at 6× so a chord vs a
      // cubic through the same points actually diverges (faceting becomes visible).
      const Z = 6
      const vd = structuredClone(doc)
      vd.viewBox = [0, 0, c.w * Z, c.h * Z] as [number, number, number, number]
      for (const it of vd.items) {
        if (it.kind !== 'path') continue
        for (const sp of it.subPaths)
          for (const nd of sp.nodes) {
            nd.x = (nd.x - c.x) * Z; nd.y = (nd.y - c.y) * Z
            if (nd.hIn) { nd.hIn.x = (nd.hIn.x - c.x) * Z; nd.hIn.y = (nd.hIn.y - c.y) * Z }
            if (nd.hOut) { nd.hOut.x = (nd.hOut.x - c.x) * Z; nd.hOut.y = (nd.hOut.y - c.y) * Z }
          }
      }
      const vr = rasterizeDoc(vd, c.w * Z, c.h * Z)
      writeFileSync(join(OUT, `${cand.id}.vzoom-${c.name}.png`), encodePng(vr, c.w * Z, c.h * Z))
    }

    // Guardians: trace each with the same override, compare to candidate 'a'.
    const guardOut: string[] = []
    for (const g of guards) {
      const gopts = { ...DEFAULT_VECTORIZE_OPTIONS, engine: 'planar' as const, gradients: true, planarFit: cand.pf }
      const gdoc = await traceImage(g.img as unknown as ImageData, gopts)
      const gs = scoreDoc({ width: g.img.width, height: g.img.height, data: overWhite(g.img.data, g.img.width * g.img.height) }, gdoc)
      if (cand.id === 'a-baseline') guardBase[g.name] = { nodes: gs.nodes, de: gs.meanDeltaE }
      const dn = gs.nodes - guardBase[g.name].nodes
      const dde = gs.meanDeltaE - guardBase[g.name].de
      guardOut.push(`${g.name} ${dn >= 0 ? '+' : ''}${dn}/${dde >= 0 ? '+' : ''}${dde.toFixed(2)}`)
    }

    rows.push(`| ${cand.id} | ${geom.paths} | ${geom.cubics} | ${geom.lines} | ${geom.sharp60} | ${score.meanDeltaE.toFixed(3)} | ${score.ssim.toFixed(4)} | ${score.nodes} | ${(Buffer.byteLength(svg) / 1024).toFixed(1)} | ${guardOut.join(', ')} |`)
    console.log(`  ${cand.id.padEnd(16)} cubic=${String(geom.cubics).padStart(3)} line=${String(geom.lines).padStart(3)} sharp=${String(geom.sharp60).padStart(3)} ΔE=${score.meanDeltaE.toFixed(3)} ssim=${score.ssim.toFixed(4)} nodes=${String(score.nodes).padStart(4)} | guards ${guardOut.join(', ')}`)
  }

  writeFileSync(join(OUT, 'FACET.md'), `# Faceting sweep — Schild @2048\n\nLower lines = less chord-faceting (Affinity emits 14). Guards (nebula/petals) must NOT lose nodes or gain ΔE (= circles breaking).\n\n${rows.join('\n')}\n`)
  console.log(`\nArtifacts in ${OUT}`)
}

await main()
