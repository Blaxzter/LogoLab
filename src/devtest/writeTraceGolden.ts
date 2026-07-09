// (Re)generate the tracing regression baseline. Run after an INTENTIONAL algorithm
// change to bless the new output:  npm run gen:golden
//
// Includes the `slow` cases too (golden generation is a one-off; the test suite is
// what gates per-run cost). Prints each record so the diff is reviewable in the PR.

import { ensureImageData } from './nodeHarness.ts'
import { GOLDEN_CORPUS, caseAvailable, recordCase, saveGolden, type GoldenRecord } from './traceGolden.ts'

ensureImageData()

const records: GoldenRecord[] = []
for (const c of GOLDEN_CORPUS) {
  if (!caseAvailable(c)) {
    console.log(`${c.name.padEnd(16)} SKIPPED (fixture ${c.path} not found)`)
    continue
  }
  const t0 = performance.now()
  const r = await recordCase(c)
  const ms = (performance.now() - t0).toFixed(0)
  records.push(r)
  console.log(
    `${r.name.padEnd(16)} ${r.width}x${r.height} grad=${r.gradients ? 'on ' : 'off'} ` +
    `paths=${String(r.paths).padStart(3)} nodes=${String(r.nodes).padStart(5)} ` +
    `meanΔE=${r.meanDeltaE.toFixed(2)} ssim=${r.ssim.toFixed(4)} seam=${r.seamMax.toFixed(1)} ` +
    `junc=${r.junctions ?? 0} clus=${r.junctionClusters ?? 0} jag=${(r.jaggedness ?? 0).toFixed(2)} ` +
    `hash=${r.hash} geom=${r.geomSig} (${ms}ms)`,
  )
}
saveGolden(records)
console.log(`\nWrote ${records.length} records to test/golden/trace-baseline.json`)
