// LogoLab, three ways — each one serialised to a string and scored like any other tool.
// VTracer gets three configurations too (adapters/external.ts).
//
//   logolab-auto     HEADLINE. src/mcp/trace.ts traceIcon on the PNG — what `npx logolab`
//                    users get: the ink probe picks mono/colour, the gradient probe, the mono
//                    upscale. No per-case knowledge.
//   logolab-product  traceImage + PRODUCT_VECTORIZE_OPTIONS (stacked, gradients on), no
//                    per-case knowledge: the studio's starting settings.
//   logolab-gate     traceImage + DEFAULT_VECTORIZE_OPTIONS (tiled) with `gradients` read off
//                    the AUTHORED SVG — an ORACLE no other tool gets. It is the truth gate's
//                    development configuration (test/truth-gate.test.ts), kept as a
//                    reference row and labelled as such in summary.md, never the headline.
//
// Ablation lane (separate table, not the headline): the 2×2 of layering × gradients with no
// oracle, so the gate→product difference is attributed by measurement:
//   logolab-abl-tiled-grad, logolab-abl-tiled-nograd, logolab-abl-stacked-nograd
//   (stacked + gradients on IS logolab-product).
//
// The truth gate scores the in-memory doc; here the doc goes through serializeDoc(doc, 2)
// and back, the same string path every other tool's output takes. Timing is in-process and
// warm (no process spawn, no file I/O) — see the ms note in summary.md.

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS, PRODUCT_VECTORIZE_OPTIONS } from '../../../src/lib/trace/index.ts'
import { serializeDoc } from '../../../src/lib/path/model.ts'
import { traceIcon } from '../../../src/mcp/trace.ts'
import { loadSource } from '../../../src/mcp/image.ts'
import { REPO } from '../paths.ts'
import type { TracerAdapter, TraceInput } from '../types.ts'

export interface Provenance {
  head: string
  /** `git status --porcelain -- src bench` at start, verbatim. */
  status: string[]
  /** sha1 of `git diff HEAD -- src bench` plus every untracked file under them. */
  diffSha1: string | null
  dirty: boolean
}

let prov: Provenance | null = null
/** Taken ONCE (the first call, at run start) and reused for every version string and meta. */
export function provenance(): Provenance {
  if (prov) return prov
  const git = (...a: string[]): string => execFileSync('git', a, { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 28 })
  try {
    const head = git('rev-parse', '--short', 'HEAD').trim()
    const status = git('status', '--porcelain', '--untracked-files=all', '--', 'src', 'bench')
      .split('\n')
      .filter(Boolean)
    let diffSha1: string | null = null
    if (status.length) {
      const h = createHash('sha1').update(git('diff', 'HEAD', '--', 'src', 'bench'))
      for (const line of status.filter((l) => l.startsWith('??')).sort()) {
        const p = line.slice(3)
        h.update(p).update(git('hash-object', p))
      }
      diffSha1 = h.digest('hex')
    }
    prov = { head, status, diffSha1, dirty: status.length > 0 }
  } catch {
    prov = { head: 'unknown', status: [], diffSha1: null, dirty: false }
  }
  return prov
}
const rev = (): string => {
  const p = provenance()
  return p.dirty ? `${p.head}+dirty.${p.diffSha1?.slice(0, 8)}` : p.head
}

const inProcess = (name: string, opts: (i: TraceInput) => Parameters<typeof traceImage>[1]): TracerAdapter => ({
  name,
  lanes: ['colour', 'mono'],
  available: async () => null,
  version: async () => `logolab@${rev()}`,
  async trace(i) {
    const t = performance.now()
    const doc = await traceImage(i.image as unknown as ImageData, opts(i))
    const ms = performance.now() - t
    return { svg: serializeDoc(doc, 2), ms }
  },
})

export const logolabGate = inProcess('logolab-gate', (i) => ({
  ...DEFAULT_VECTORIZE_OPTIONS,
  engine: 'planar',
  gradients: i.case.gradients,
}))

export const logolabProduct = inProcess('logolab-product', () => ({ ...PRODUCT_VECTORIZE_OPTIONS }))

export const logolabAuto: TracerAdapter = {
  name: 'logolab-auto',
  lanes: ['colour', 'mono'],
  available: async () => null,
  version: async () => `logolab@${rev()} traceIcon`,
  async trace(i) {
    const t = performance.now()
    const out = await traceIcon(loadSource(i.pngPath), {})
    return { svg: out.svg, ms: performance.now() - t, notes: out.plan.summary }
  },
}

const tiled = { ...DEFAULT_VECTORIZE_OPTIONS, engine: 'planar' as const }
const stacked = { ...PRODUCT_VECTORIZE_OPTIONS }
export const logolabAblation: TracerAdapter[] = [
  inProcess('logolab-abl-tiled-grad', () => ({ ...tiled, gradients: true })),
  inProcess('logolab-abl-tiled-nograd', () => ({ ...tiled, gradients: false })),
  inProcess('logolab-abl-stacked-nograd', () => ({ ...stacked, gradients: false })),
]
export const ABLATION_TOOLS = new Set(logolabAblation.map((a) => a.name))
