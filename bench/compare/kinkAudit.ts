// What a scorer change does to the kink column, from a run's SAVED outputs — nothing traced.
//
//   node --experimental-strip-types bench/compare/kinkAudit.ts [--run v1-clean] [--corpus svgemoji-v0]
//
// Re-locates every tool's tangent breaks with the current geomScore and prints, per tool, the
// run's stored total against the recount, and the cases that moved most. Written for the
// junction rule (§42.6): run it before re-running a whole comparison for a counting change.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { caseOverlay } from './overlay.ts'
import { RESULTS } from './paths.ts'

const argv = process.argv.slice(2)
const arg = (k: string, d: string) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d)
const RUN = arg('--run', 'v1-clean')
const CORPUS = arg('--corpus', 'svgemoji-v0')
const runDir = join(RESULTS, RUN)
const results = JSON.parse(readFileSync(join(runDir, 'results.json'), 'utf8')) as {
  meta: { res: number }
  rows: { tool: string; caseId: string; corpus: string; tangentBreaks?: number | null }[]
}
const stored = new Map(results.rows.map((r) => [`${r.tool}|${r.caseId}`, r.tangentBreaks ?? null]))

const byCase = new Map<string, { gt: string; tools: Map<string, string> }>()
for (const line of readFileSync(join(runDir, 'pairs.jsonl'), 'utf8').split('\n')) {
  if (!line.trim()) continue
  const p = JSON.parse(line) as { key: string; gt_svg: string; gen_svg: string }
  const tool = p.key.slice(0, p.key.indexOf('|'))
  const caseId = p.key.slice(p.key.indexOf('|') + 1)
  if (!caseId.startsWith(`${CORPUS}/`)) continue
  let c = byCase.get(caseId)
  if (!c) byCase.set(caseId, (c = { gt: p.gt_svg, tools: new Map() }))
  try {
    c.tools.set(tool, readFileSync(p.gen_svg, 'utf8'))
  } catch {
    // a failed trace has no file; its row is a failure either way
  }
}

const total = new Map<string, { before: number; after: number; moved: { id: string; d: number }[] }>()
for (const [caseId, c] of byCase) {
  const o = caseOverlay(readFileSync(c.gt, 'utf8'), results.meta.res, c.tools)
  for (const [tool, t] of Object.entries(o.tools)) {
    const before = stored.get(`${tool}|${caseId}`)
    if (before == null) continue
    const after = t.breaks.length / 3
    const s = total.get(tool) ?? { before: 0, after: 0, moved: [] }
    s.before += before
    s.after += after
    if (after !== before) s.moved.push({ id: caseId.slice(caseId.indexOf('/') + 1), d: after - before })
    total.set(tool, s)
  }
}
console.log(`${RUN} · ${CORPUS} · ${byCase.size} cases: kinks stored → recounted`)
for (const [tool, s] of [...total].sort((a, b) => a[0].localeCompare(b[0]))) {
  const top = s.moved
    .sort((a, b) => Math.abs(b.d) - Math.abs(a.d))
    .slice(0, 4)
    .map((m) => `${m.id} ${m.d > 0 ? '+' : ''}${m.d}`)
  console.log(
    `${tool.padEnd(22)} ${String(s.before).padStart(5)} → ${String(s.after).padEnd(5)} ${s.moved.length} cases moved  ${top.join(', ')}`,
  )
}
